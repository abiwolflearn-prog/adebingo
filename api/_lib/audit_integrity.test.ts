import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import { createTelegramAuthHandler } from './telegramHandler.ts';
import { createPlayerStateHandler, createPlayerWalletHandler } from './playerHandler.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import {
  createAdminDepositReviewHandler,
  createAdminPayoutReviewHandler,
  createAdminRouterHandler,
} from './adminHandler.ts';
import { createFirestoreTelegramStore } from './telegramPersistence.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from './gamePersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { mintServerSessionToken } from '../../src/utils/adminAuthority.ts';

type DocData = Record<string, unknown>;

function createStrictInMemoryFirestore() {
  const store = new Map<string, DocData>();
  let txQueue: Promise<unknown> = Promise.resolve();

  function clone<T>(val: T): T {
    if (val === null || val === undefined || typeof val !== 'object') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(clone) as unknown as T;
    }
    if (val instanceof Date) {
      return new Date(val.getTime()) as unknown as T;
    }
    const ctor = (val as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'FieldValue' || ctor === 'ServerTimestampTransform') {
      return new Date() as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = clone(v);
    }
    return out as T;
  }

  function makeSnap(id: string, path: string, data: DocData | undefined) {
    const cloned = data ? clone(data) : undefined;
    return {
      id,
      exists: Boolean(cloned),
      ref: makeDocRef(path),
      data: () => (cloned ? clone(cloned) : undefined),
      get: (field: string) => (cloned ? cloned[field] : undefined),
    };
  }

  function makeDocRef(path: string) {
    const parts = path.split('/');
    const id = parts[parts.length - 1];
    return {
      id,
      path,
      collection(subName: string) {
        return makeCollectionRef(`${path}/${subName}`);
      },
      async get() {
        return makeSnap(id, path, store.get(path));
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        if (opts?.merge && store.has(path)) {
          store.set(path, { ...store.get(path)!, ...clone(data) });
        } else {
          store.set(path, clone(data));
        }
      },
      async update(data: DocData) {
        const current = store.get(path);
        if (!current) throw new Error(`Document missing: ${path}`);
        store.set(path, { ...current, ...clone(data) });
      },
      async delete() {
        store.delete(path);
      },
    };
  }

  function makeQuery(
    prefix: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    limitCount?: number
  ) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(prefix, [...filters, { field, op, value }], limitCount);
      },
      limit(n: number) {
        return makeQuery(prefix, filters, n);
      },
      orderBy() {
        return makeQuery(prefix, filters, limitCount);
      },
      async get() {
        const docs: ReturnType<typeof makeSnap>[] = [];
        for (const [p, data] of store.entries()) {
          if (!p.startsWith(`${prefix}/`)) continue;
          const rest = p.slice(prefix.length + 1);
          if (rest.includes('/')) continue;
          let matched = true;
          for (const f of filters) {
            const v = data[f.field];
            if (f.op === '==' && v !== f.value) matched = false;
            if (f.op === '!=' && v === f.value) matched = false;
          }
          if (matched) {
            docs.push(makeSnap(rest, p, data));
          }
        }
        const finalDocs = typeof limitCount === 'number' ? docs.slice(0, limitCount) : docs;
        return {
          empty: finalDocs.length === 0,
          size: finalDocs.length,
          docs: finalDocs,
          forEach(cb: (d: ReturnType<typeof makeSnap>) => void) {
            finalDocs.forEach(cb);
          },
        };
      },
    };
  }

  function makeCollectionRef(prefix: string) {
    return {
      doc(id?: string) {
        const docId = id || `auto_${crypto.randomBytes(4).toString('hex')}`;
        return makeDocRef(`${prefix}/${docId}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(prefix, [{ field, op, value }]);
      },
      limit(n: number) {
        return makeQuery(prefix, [], n);
      },
      orderBy() {
        return makeQuery(prefix);
      },
      async get() {
        return makeQuery(prefix).get();
      },
    };
  }

  const db = {
    collection(name: string) {
      return makeCollectionRef(name);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const stagedWrites: Array<() => void> = [];
        let hasWritten = false;
        const tx = {
          async get(refOrQuery: { path?: string; get: () => Promise<unknown> }) {
            if (hasWritten) {
              throw new Error('Firestore transactions require all reads to be executed before all writes.');
            }
            return refOrQuery.get();
          },
          set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
            hasWritten = true;
            stagedWrites.push(() => {
              if (opts?.merge && store.has(ref.path)) {
                store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
              } else {
                store.set(ref.path, clone(data));
              }
            });
          },
          create(ref: { path: string }, data: DocData) {
            hasWritten = true;
            if (store.has(ref.path)) {
              const err = new Error(`ALREADY_EXISTS: ${ref.path}`) as Error & { code?: number };
              err.code = 6;
              throw err;
            }
            stagedWrites.push(() => {
              store.set(ref.path, clone(data));
            });
          },
          update(ref: { path: string }, data: DocData) {
            hasWritten = true;
            stagedWrites.push(() => {
              const curr = store.get(ref.path);
              if (!curr) throw new Error(`Document missing: ${ref.path}`);
              store.set(ref.path, { ...curr, ...clone(data) });
            });
          },
          delete(ref: { path: string }) {
            hasWritten = true;
            stagedWrites.push(() => {
              store.delete(ref.path);
            });
          },
        };
        const result = await fn(tx);
        for (const w of stagedWrites) w();
        return result;
      };
      const p = txQueue.then(run, run);
      txQueue = p.catch(() => {});
      return p;
    },
  };

  return { db: db as unknown as Firestore, store };
}

function buildSignedInitData(
  botToken: string,
  userObj: { id: number; first_name: string; last_name?: string; username?: string },
  extra: Record<string, string> = {}
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', `AAHdF6IQAAAAAN0Xoh${userObj.id}`);
  params.set('user', JSON.stringify(userObj));
  for (const [k, v] of Object.entries(extra)) {
    params.set(k, v);
  }
  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = {
      method: opts.method || 'GET',
      url: opts.url || '/',
      headers: opts.headers || {},
      body: opts.body,
      query: opts.query || {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as VercelRequest;

    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(payload: Record<string, unknown>) {
        resolve({ status: statusCode, json: payload });
        return this;
      },
      send(payload: unknown) {
        resolve({
          status: statusCode,
          json: typeof payload === 'string' ? { raw: payload } : (payload as Record<string, unknown>),
        });
        return this;
      },
      end() {
        resolve({ status: statusCode, json: {} });
        return this;
      },
    } as unknown as VercelResponse;

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function createTestAuthDeps(
  tokens: Record<string, DecodedIdTokenLike>,
  sessionSecret: string
): AuthBackendDeps {
  return {
    getSessionSecret: () => sessionSecret,
    verifyIdToken: async (token: string) => {
      const match = tokens[token];
      if (!match) throw new Error('invalid_firebase_token');
      return match;
    },
  };
}

test('Audit 1: Persistent Account Creation, Signed start_param Referral Attribution, Dual-Collection Sync, and Abuse Prevention', async () => {
  const BOT_TOKEN = '999888777:AAAuditTestBotTokenSecret1234567890';
  const SESSION_SECRET = 'audit-test-session-secret-0123456789';
  const prevSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  try {
    const { db, store } = createStrictInMemoryFirestore();
    const authDeps = createTestAuthDeps({}, SESSION_SECRET);

    const authHandler = createTelegramAuthHandler({
      getDb: () => db,
      getBotToken: () => BOT_TOKEN,
      isAdminReady: () => true,
      mintCustomToken: async (u) => ({
        uid: `tg_${u.telegramUserId}`,
        customToken: `custom_tg_${u.telegramUserId}`,
      }),
    });
    const playerStateHandler = createPlayerStateHandler({ getDb: () => db, authDeps });
    const playerWalletHandler = createPlayerWalletHandler({ getDb: () => db, authDeps });

  // 1) Inviter registers via cryptographically verified Telegram initData
  const inviterInitData = buildSignedInitData(BOT_TOKEN, {
    id: 500001,
    first_name: 'Dawit',
    username: 'dawit_inviter',
  });
  const inviterAuth = await invokeHandler(authHandler, {
    method: 'POST',
    url: '/api/telegram/auth',
    body: { initData: inviterInitData },
  });
  assert.equal(inviterAuth.status, 200);
  assert.equal(inviterAuth.json.ok, true);
  assert.equal((inviterAuth.json.profile as { demoBalanceEtb: number }).demoBalanceEtb, 250);
  const inviterToken = String(inviterAuth.json.sessionToken);

  // Verify initial balance ledger entry exists
  const initTx = store.get('transactions/tx_init_tg_500001');
  assert.ok(initTx, 'Initial 250 ETB ledger entry must be written on account creation');
  assert.equal(initTx.amountEtb, 250);
  assert.equal(initTx.balanceBeforeEtb, 0);
  assert.equal(initTx.balanceAfterEtb, 250);

  // 2) Invitee registers via Telegram Mini App deep link with signed start_param=ADEY-500001
  const inviteeInitData = buildSignedInitData(
    BOT_TOKEN,
    { id: 500002, first_name: 'Hanna', username: 'hanna_invitee' },
    { start_param: 'ADEY-500001' }
  );
  const inviteeAuth = await invokeHandler(authHandler, {
    method: 'POST',
    url: '/api/telegram/auth',
    body: { initData: inviteeInitData },
  });
  assert.equal(inviteeAuth.status, 200);
  assert.equal(inviteeAuth.json.ok, true);
  assert.equal((inviteeAuth.json.referralApplied as { applied: boolean })?.applied, true);
  // Invitee gets 250 initial + 15 referral bonus = 265 ETB
  assert.equal((inviteeAuth.json.profile as { demoBalanceEtb: number }).demoBalanceEtb, 265);
  const inviteeToken = String(inviteeAuth.json.sessionToken);

  // Verify BOTH users & botPlayers are strictly synced for BOTH inviter (270) and invitee (265)
  assert.equal(store.get('users/tg_500001')?.demoBalanceEtb, 270);
  assert.equal(store.get('botPlayers/500001')?.demoBalanceEtb, 270);
  assert.equal(store.get('users/tg_500001')?.referralsCount, 1);

  assert.equal(store.get('users/tg_500002')?.demoBalanceEtb, 265);
  assert.equal(store.get('botPlayers/500002')?.demoBalanceEtb, 265);

  // Verify inviter sees real referral record & updated 270 ETB balance in /api/player/state
  const inviterState = await invokeHandler(playerStateHandler, {
    method: 'GET',
    url: '/api/player/state',
    headers: { authorization: `Bearer ${inviterToken}` },
  });
  assert.equal(inviterState.status, 200);
  assert.equal((inviterState.json.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 270);
  assert.equal((inviterState.json.referrals as unknown[]).length, 1);
  assert.equal(typeof inviterState.json.serverNowMs, 'number');

  // 3) Duplicate referral attempt by invitee is blocked (409)
  const dupRef = await invokeHandler(playerWalletHandler, {
    method: 'POST',
    url: '/api/player/wallet',
    headers: { authorization: `Bearer ${inviteeToken}`, 'idempotency-key': 'dup-ref-1' },
    body: { action: 'apply_promo', code: 'ADEY-500001' },
  });
  assert.equal(dupRef.status, 409);
  assert.equal(store.get('users/tg_500002')?.demoBalanceEtb, 265);

  // 4) Self-referral attempt by inviter is blocked (400)
  const selfRef = await invokeHandler(playerWalletHandler, {
    method: 'POST',
    url: '/api/player/wallet',
    headers: { authorization: `Bearer ${inviterToken}`, 'idempotency-key': 'self-ref-1' },
    body: { action: 'apply_promo', code: 'ADEY-500001' },
  });
  assert.equal(selfRef.status, 400);
  assert.equal(store.get('users/tg_500001')?.demoBalanceEtb, 270);

  // 5) Nonexistent inviter code is rejected via Telegram store (never creates phantom bonus)
  const tgStore = createFirestoreTelegramStore(db);
  assert.ok(tgStore.processReferralDeepLink);
  const ghostRef = await tgStore.processReferralDeepLink({
    referralCode: 'ADEY-99999999',
    inviteeTelegramId: 500003,
    inviteeName: 'GhostTester',
    inviteeUsername: 'ghost_tester',
  });
  assert.equal(ghostRef.applied, false);
  assert.equal(ghostRef.reason, 'inviter_not_found');

  // 6) Uninitialized player queried on /api/player/state returns 0 ETB (never fabricates balance)
  const uninitSession = mintServerSessionToken(
    { telegramUserId: 500099, displayName: 'Uninit', username: 'uninit' },
    SESSION_SECRET
  );
  const uninitState = await invokeHandler(playerStateHandler, {
    method: 'GET',
    url: '/api/player/state',
    headers: { authorization: `Bearer ${uninitSession.token}` },
  });
    assert.equal(uninitState.status, 200);
    assert.equal((uninitState.json.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 0);
  } finally {
    if (prevSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = prevSecret;
  }
});

test('Audit 2: Financial Atomicity, Concurrent Withdrawal Double-Spend Protection, Admin Refund/Deposit Sync, Idempotency & Support Ticket Persistence', async () => {
  const BOT_TOKEN = '999888777:AAAuditTestBotTokenSecret1234567890';
  const SESSION_SECRET = 'audit-test-session-secret-0123456789';
  const prevSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  try {
    const { db, store } = createStrictInMemoryFirestore();
    const authDeps = createTestAuthDeps({}, SESSION_SECRET);

    const authHandler = createTelegramAuthHandler({
      getDb: () => db,
      getBotToken: () => BOT_TOKEN,
      isAdminReady: () => true,
      mintCustomToken: async (u) => ({
        uid: `tg_${u.telegramUserId}`,
        customToken: `custom_tg_${u.telegramUserId}`,
      }),
    });
    const playerWalletHandler = createPlayerWalletHandler({ getDb: () => db, authDeps });
    const playerStateHandler = createPlayerStateHandler({ getDb: () => db, authDeps });
    const payoutReviewHandler = createAdminPayoutReviewHandler({ getDb: () => db, authDeps });
    const depositReviewHandler = createAdminDepositReviewHandler({ getDb: () => db, authDeps });
    const adminRouter = createAdminRouterHandler({ getDb: () => db, authDeps });

  // Register player (250 ETB initial)
  const playerInitData = buildSignedInitData(BOT_TOKEN, {
    id: 600001,
    first_name: 'Meron',
    username: 'meron_player',
  });
  const playerAuth = await invokeHandler(authHandler, {
    method: 'POST',
    url: '/api/telegram/auth',
    body: { initData: playerInitData },
  });
  assert.equal(playerAuth.status, 200);
  const playerToken = String(playerAuth.json.sessionToken);

  // Mint verified Owner Admin token (Telegram ID 8842109)
  const adminSession = mintServerSessionToken(
    { telegramUserId: 8842109, displayName: 'Owner', username: 'owner', email: 'abiwolfcode@gmail.com' },
    SESSION_SECRET
  );

  // 1) Concurrent double-spend withdrawal attack: two 200 ETB withdrawals simultaneously on a 250 ETB balance
  const [w1, w2] = await Promise.all([
    invokeHandler(playerWalletHandler, {
      method: 'POST',
      url: '/api/player/wallet',
      headers: { authorization: `Bearer ${playerToken}`, 'idempotency-key': 'withdraw-race-1' },
      body: { action: 'withdraw_request', amountEtb: 200, method: 'Telebirr (Demo)' },
    }),
    invokeHandler(playerWalletHandler, {
      method: 'POST',
      url: '/api/player/wallet',
      headers: { authorization: `Bearer ${playerToken}`, 'idempotency-key': 'withdraw-race-2' },
      body: { action: 'withdraw_request', amountEtb: 200, method: 'Telebirr (Demo)' },
    }),
  ]);
  const statuses = [w1.status, w2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 400], 'Exactly one concurrent withdrawal must succeed and the second must fail');
  // Balance immediately held/deducted to 50 ETB in BOTH collections
  assert.equal(store.get('users/tg_600001')?.demoBalanceEtb, 50);
  assert.equal(store.get('botPlayers/600001')?.demoBalanceEtb, 50);

  const succeededWithdrawal = (w1.status === 201 ? w1.json.withdrawal : w2.json.withdrawal) as {
    requestId: string;
  };
  assert.ok(succeededWithdrawal.requestId);

  // 2) Duplicate idempotency-key replay is rejected with 409
  const replayRes = await invokeHandler(playerWalletHandler, {
    method: 'POST',
    url: '/api/player/wallet',
    headers: { authorization: `Bearer ${playerToken}`, 'idempotency-key': 'withdraw-race-1' },
    body: { action: 'withdraw_request', amountEtb: 10, method: 'Telebirr (Demo)' },
  });
  assert.equal(replayRes.status, 409);
  assert.equal(store.get('users/tg_600001')?.demoBalanceEtb, 50);

  // 3) Admin rejects withdrawal -> exact 200 ETB refund credited to BOTH users & botPlayers (back to 250)
  const rejectRes = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    url: `/api/admin/payouts/${succeededWithdrawal.requestId}/review`,
    headers: { authorization: `Bearer ${adminSession.token}` },
    query: { requestId: succeededWithdrawal.requestId },
    body: { nextStatus: 'Rejected', reviewNotes: 'Audit refund verification' },
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(store.get('users/tg_600001')?.demoBalanceEtb, 250);
  assert.equal(store.get('botPlayers/600001')?.demoBalanceEtb, 250);

  // 4) Player submits deposit request -> admin approves -> +100 ETB synced to BOTH users & botPlayers (350)
  const depReq = await invokeHandler(playerWalletHandler, {
    method: 'POST',
    url: '/api/player/wallet',
    headers: { authorization: `Bearer ${playerToken}`, 'idempotency-key': 'dep-audit-1' },
    body: { action: 'deposit_request', amountEtb: 100, provider: 'Telebirr (Demo)' },
  });
  assert.equal(depReq.status, 201);
  const depositId = String((depReq.json.deposit as { depositId: string }).depositId);

  const depApprove = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    url: `/api/admin/deposits/${depositId}/review`,
    headers: { authorization: `Bearer ${adminSession.token}` },
    query: { depositId },
    body: { nextStatus: 'Approved', reviewNotes: 'Verified receipt' },
  });
  assert.equal(depApprove.status, 200);
  assert.equal(store.get('users/tg_600001')?.demoBalanceEtb, 350);
  assert.equal(store.get('botPlayers/600001')?.demoBalanceEtb, 350);

  // 5) Admin manual wallet adjustment endpoint enforces RBAC & syncs both collections (+50 -> 400)
  const playerForbiddenAdj = await invokeHandler(adminRouter, {
    method: 'POST',
    url: '/api/admin/users/tg_600001/wallet',
    headers: { authorization: `Bearer ${playerToken}` },
    body: { deltaEtb: 50, reason: 'Unauthorized attempt' },
  });
  assert.equal(playerForbiddenAdj.status, 403);

  const adminAdj = await invokeHandler(adminRouter, {
    method: 'POST',
    url: '/api/admin/users/tg_600001/wallet',
    headers: { authorization: `Bearer ${adminSession.token}` },
    body: { deltaEtb: 50, reason: 'Audit loyalty credit' },
  });
  assert.equal(adminAdj.status, 200);
  assert.equal(store.get('users/tg_600001')?.demoBalanceEtb, 400);
  assert.equal(store.get('botPlayers/600001')?.demoBalanceEtb, 400);

  // 6) Ledger Reconciliation: sum of all persisted ledger amounts for tg_600001 MUST equal exact current balance (400)
  let ledgerSum = 0;
  for (const [key, doc] of store.entries()) {
    if (key.startsWith('transactions/') && doc.userId === 'tg_600001') {
      ledgerSum += Number(doc.amountEtb ?? doc.amount ?? 0);
    }
  }
  assert.equal(Number(ledgerSum.toFixed(2)), 400, 'Sum of immutable ledger entries must match exact account balance');

  // 7) Support ticket persists & returns in GET /api/player/state
  const ticketRes = await invokeHandler(playerWalletHandler, {
    method: 'POST',
    url: '/api/player/wallet',
    headers: { authorization: `Bearer ${playerToken}`, 'idempotency-key': 'ticket-audit-1' },
    body: {
      action: 'support_ticket',
      category: 'wallet',
      subject: 'Deposit confirmation check',
      message: 'Confirming my 100 ETB deposit receipt.',
    },
  });
  assert.equal(ticketRes.status, 201);
  const stateAfter = await invokeHandler(playerStateHandler, {
    method: 'GET',
    url: '/api/player/state',
    headers: { authorization: `Bearer ${playerToken}` },
  });
  assert.equal(stateAfter.status, 200);
  const tickets = stateAfter.json.supportTickets as Array<{ subject: string }>;
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].subject, 'Deposit confirmation check');
  } finally {
    if (prevSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = prevSecret;
  }
});

test('Audit 3: Server-Authoritative Countdown Calculation, Round Reset Cleanup & Admin Round-Action Authorization', async () => {
  const BOT_TOKEN = '999888777:AAAuditTestBotTokenSecret1234567890';
  const SESSION_SECRET = 'audit-test-session-secret-0123456789';
  const { db, store } = createStrictInMemoryFirestore();
  const authDeps = createTestAuthDeps({}, SESSION_SECRET);

  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps });
  const adminRouter = createAdminRouterHandler({ getDb: () => db, authDeps });

  await gameStore.ensureDefaultRooms();

  const playerSession = mintServerSessionToken(
    { telegramUserId: 700001, displayName: 'Player', username: 'p700001' },
    SESSION_SECRET
  );

  // Set registration deadline to 27 seconds from now (simulating a mid-round player joining late)
  const roomDoc = store.get('rooms/adey-main')!;
  const targetDeadlineMs = Date.now() + 27_000;
  store.set('rooms/adey-main', {
    ...roomDoc,
    status: 'countdown',
    countdownSeconds: 60, // stale stored integer — live calculation MUST derive ~27s from registrationDeadlineMs!
    registrationDeadlineMs: targetDeadlineMs,
  });

  const detailRes = await invokeHandler(roomsHandler, {
    method: 'GET',
    url: '/api/rooms?roomId=adey-main',
    headers: { authorization: `Bearer ${playerSession.token}` },
    query: { roomId: 'adey-main' },
  });
  assert.equal(detailRes.status, 200);
  assert.equal(typeof detailRes.json.serverNowMs, 'number');
  const roomSummary = detailRes.json.room as { countdownSeconds: number; registrationDeadlineMs: number };
  assert.ok(
    roomSummary.countdownSeconds >= 25 && roomSummary.countdownSeconds <= 28,
    `Expected live countdown ~27s, got ${roomSummary.countdownSeconds}s`
  );
  assert.equal(roomSummary.registrationDeadlineMs, targetDeadlineMs);

  // Reserve a card, then verify resetGameRoundAtomic clears cards & players and sets a fresh deadline
  store.set('users/tg_700001', {
    uid: 'tg_700001',
    telegramUserId: 'tg_700001',
    displayName: 'Test Player',
    username: 'test_700001',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 250,
  });
  const reserve = await gameService.reserveOrReleaseCard({
    roomId: 'adey-main',
    cardId: 42,
    uid: 'tg_700001',
    displayName: 'Test Player',
    telegramUserId: 'tg_700001',
  });
  assert.equal(reserve.ok, true);
  assert.ok(store.has('rooms/adey-main/cards/42'));
  assert.ok(store.has('rooms/adey-main/players/tg_700001'));

  const adminSession = mintServerSessionToken(
    { telegramUserId: 8842109, displayName: 'Owner', username: 'owner', email: 'abiwolfcode@gmail.com' },
    SESSION_SECRET
  );

  // Unauthenticated & non-admin calls to /api/admin/rooms/:roomId/round-action must be rejected
  const unauthRound = await invokeHandler(adminRouter, {
    method: 'POST',
    url: '/api/admin/rooms/adey-main/round-action',
    body: { action: 'reset' },
  });
  assert.equal(unauthRound.status, 401);

  const playerRound = await invokeHandler(adminRouter, {
    method: 'POST',
    url: '/api/admin/rooms/adey-main/round-action',
    headers: { authorization: `Bearer ${playerSession.token}` },
    body: { action: 'reset' },
  });
  assert.equal(playerRound.status, 403);

  // Authorized admin reset clears stale cards & players and resets room counters to 0
  const adminReset = await invokeHandler(adminRouter, {
    method: 'POST',
    url: '/api/admin/rooms/adey-main/round-action',
    headers: { authorization: `Bearer ${adminSession.token}` },
    body: { action: 'reset' },
  });
  assert.equal(adminReset.status, 200);
  assert.equal(store.has('rooms/adey-main/cards/42'), false, 'Stale card reservations must be purged on round reset');
  assert.equal(store.has('rooms/adey-main/players/tg_700001'), false, 'Stale room player docs must be purged on round reset');
  assert.equal(store.get('rooms/adey-main')?.reservedCardsCount, 0);
  assert.equal(store.get('rooms/adey-main')?.confirmedPlayersCount, 0);
  assert.ok(Number(store.get('rooms/adey-main')?.registrationDeadlineMs) > Date.now());
});
