import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import { BoundedRateLimiter } from './http.ts';
import {
  createBotCommandHandler,
  createTelegramAuthHandler,
  createTelegramWebhookHandler,
} from './telegramHandler.ts';
import {
  createFirestoreTelegramStore,
  PersistentTelegramBotService,
} from './telegramPersistence.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import {
  createDrawBallHandler,
  createResetRoundHandler,
  createSchedulerTickHandler,
  createStartGameHandler,
} from './gameHandler.ts';
import {
  createFirestoreGameStore,
  PersistentGameAuthorityService,
} from './gamePersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import {
  createPlayerStateHandler,
  createPlayerWalletHandler,
} from './playerHandler.ts';
import {
  createAdminBotConfigHandler,
  createAdminNotificationsHandler,
  createAdminNotificationsSendHandler,
  createAdminOverviewHandler,
  createAdminPayoutReviewHandler,
  createAdminRoomRoundActionHandler,
  createAdminUserStatusHandler,
  createAdminUsersHandler,
} from './adminHandler.ts';
import { PersistentAdminService } from './adminPersistence.ts';
import { generateDeterministicCard } from '../../src/game/rules.ts';

type DocData = Record<string, unknown>;

function createInMemoryFirestore() {
  const store = new Map<string, DocData>();
  let txQueue: Promise<unknown> = Promise.resolve();

  function clone<T>(val: T): T {
    if (val === null || val === undefined || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(clone) as unknown as T;
    if (val instanceof Date) return new Date(val.getTime()) as unknown as T;
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

  function listDirectChildren(colPath: string) {
    const prefix = `${colPath}/`;
    const docs: Array<{ id: string; path: string; data: DocData }> = [];
    for (const [docPath, data] of store.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const remainder = docPath.slice(prefix.length);
      if (remainder.includes('/')) continue;
      docs.push({ id: remainder, path: docPath, data: clone(data) });
    }
    return docs;
  }

  function makeQuery(
    colPath: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    order?: { field: string; dir: 'asc' | 'desc' },
    limitCount?: number
  ) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(colPath, [...filters, { field, op, value }], order, limitCount);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(colPath, filters, { field, dir }, limitCount);
      },
      limit(count: number) {
        return makeQuery(colPath, filters, order, count);
      },
      async get() {
        let items = listDirectChildren(colPath).filter((item) =>
          filters.every((f) => {
            const val = item.data[f.field];
            if (f.op === '<') return Number(val) < Number(f.value);
            if (f.op === '<=') return Number(val) <= Number(f.value);
            if (f.op === '==') return val === f.value;
            if (f.op === '>') return Number(val) > Number(f.value);
            if (f.op === '>=') return Number(val) >= Number(f.value);
            return false;
          })
        );
        if (order) {
          const { field, dir } = order;
          items.sort((a, b) => {
            const av = Number(a.data[field] ?? 0);
            const bv = Number(b.data[field] ?? 0);
            return dir === 'desc' ? bv - av : av - bv;
          });
        }
        if (typeof limitCount === 'number') {
          items = items.slice(0, limitCount);
        }
        const docs = items.map((i) => makeSnap(i.id, i.path, i.data));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  function makeCollectionRef(colPath: string) {
    return {
      ...makeQuery(colPath),
      doc(docId: string) {
        return makeDocRef(`${colPath}/${docId}`);
      },
    };
  }

  const fakeFirestore = {
    collection(colName: string) {
      return makeCollectionRef(colName);
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        delete(ref: { path: string }) {
          ops.push(() => store.delete(ref.path));
        },
        set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
          ops.push(() => {
            if (opts?.merge && store.has(ref.path)) {
              store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
            } else {
              store.set(ref.path, clone(data));
            }
          });
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = txQueue.then(async () => {
        const pendingWrites: Array<() => void> = [];
        let hasWritten = false;
        const tx = {
          async get(ref: { id: string; path: string }) {
            if (hasWritten) {
              throw new Error('Firestore transactions require all reads before writes.');
            }
            return makeSnap(ref.id, ref.path, store.get(ref.path));
          },
          set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
            hasWritten = true;
            const nextData = clone(data);
            pendingWrites.push(() => {
              if (opts?.merge && store.has(ref.path)) {
                store.set(ref.path, { ...store.get(ref.path)!, ...nextData });
              } else {
                store.set(ref.path, nextData);
              }
            });
          },
          update(ref: { path: string }, data: DocData) {
            hasWritten = true;
            const nextData = clone(data);
            pendingWrites.push(() => {
              const current = store.get(ref.path);
              if (!current) throw new Error(`Document missing during tx.update: ${ref.path}`);
              store.set(ref.path, { ...current, ...nextData });
            });
          },
          delete(ref: { path: string }) {
            hasWritten = true;
            pendingWrites.push(() => {
              store.delete(ref.path);
            });
          },
        };
        const result = await fn(tx);
        for (const w of pendingWrites) w();
        return result;
      });
      txQueue = run.catch(() => undefined);
      return await run;
    },
  };

  return { db: fakeFirestore as unknown as Firestore, store };
}

function buildSignedInitData(
  botToken: string,
  authDate: number,
  userObj: Record<string, unknown>,
  startParam?: string
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `Q_${userObj.id}_${authDate}`);
  params.set('user', JSON.stringify(userObj));
  if (startParam) params.set('start_param', startParam);

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function invoke(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string | string[]>;
  } = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.50' };
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  if (options.body !== undefined && !headers['content-type'] && typeof options.body === 'object') {
    headers['content-type'] = 'application/json';
  }
  let statusCode = 200;
  let jsonBody: Record<string, unknown> = {};
  const req = {
    url: options.url || '/',
    method: options.method || 'GET',
    headers,
    body: options.body,
    query: options.query || {},
    socket: { remoteAddress: '203.0.113.50' },
  } as unknown as VercelRequest;
  const res = {
    setHeader() {},
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      jsonBody = payload;
      return this;
    },
    send(payload: unknown) {
      jsonBody =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : { raw: payload };
      return this;
    },
  } as unknown as VercelResponse;
  await handler(req, res);
  return { statusCode, body: jsonBody };
}

function createAuthDeps(
  tokenMap: Record<string, DecodedIdTokenLike>,
  adminUids: string[] = [],
  sessionSecret?: string
): AuthBackendDeps {
  const admins = new Set(adminUids);
  return {
    ...(sessionSecret ? { sessionSecret } : {}),
    async verifyIdToken(token: string) {
      const found = tokenMap[token];
      if (!found) throw new Error('invalid token');
      return found;
    },
    async isAdminUid(uid: string) {
      return admins.has(uid);
    },
    async getUserDisplayName(uid: string) {
      return tokenMap[`tok_${uid}`]?.name || uid;
    },
  };
}

test('Multi-device 3-player flow: inviter + invited player + independent player share identical rooms, synchronized timer, server-only game control, and co-winner settlement', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '999999:TEST_ADEBINGO_FUNCTIONAL_VERIFY';
  const cronSecret = 'test_cron_secret_32_bytes_minimum_value';
  const nowUnix = Math.floor(Date.now() / 1000);
  const limiter = new BoundedRateLimiter();

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    nowUnixSeconds: () => nowUnix,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_tg_${telegramUserId}`,
    }),
    limiter,
  });

  // 1. Player A (Inviter) authenticates via signed Telegram initData
  const authA = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(botToken, nowUnix, {
        id: 500001,
        first_name: 'Dawit',
        last_name: 'Kebede',
        username: 'dawit_inviter',
        language_code: 'am',
      }),
    },
  });
  assert.equal(authA.statusCode, 200);
  assert.equal(authA.body.verifiedTelegramId, 500001);
  const tokenA = String(authA.body.sessionToken);

  // 2. Player B (Invited) opens Mini App with lowercase referral param `adey-500001`
  const authB = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(
        botToken,
        nowUnix,
        {
          id: 500002,
          first_name: 'Hanna',
          last_name: 'Tesfaye',
          username: 'hanna_invited',
          language_code: 'en',
        },
        'adey-500001'
      ),
    },
  });
  assert.equal(authB.statusCode, 200);
  assert.equal(authB.body.verifiedTelegramId, 500002);
  assert.equal((authB.body.referralApplied as { applied?: boolean })?.applied, true);
  const tokenB = String(authB.body.sessionToken);

  // 3. Player C (Independent) authenticates without referral
  const authC = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(botToken, nowUnix, {
        id: 500003,
        first_name: 'Yonas',
        last_name: 'Alemu',
        username: 'yonas_solo',
        language_code: 'am',
      }),
    },
  });
  assert.equal(authC.statusCode, 200);
  const tokenC = String(authC.body.sessionToken);

  const authDeps = createAuthDeps(
    {
      tok_admin: {
        uid: 'admin_uid_1',
        email: 'abelbimrew868@gmail.com',
        email_verified: true,
        name: 'Adey Owner',
      },
    },
    ['admin_uid_1'],
    botToken
  );

  const playerStateHandler = createPlayerStateHandler({ getDb: () => db, authDeps, limiter });
  const playerWalletHandler = createPlayerWalletHandler({ getDb: () => db, authDeps, limiter });
  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps, limiter });
  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps, limiter });
  const startHandler = createStartGameHandler({ getDb: () => db, authDeps, limiter });
  const drawHandler = createDrawBallHandler({ getDb: () => db, authDeps, limiter });
  const resetHandler = createResetRoundHandler({ getDb: () => db, authDeps, limiter });
  const tickHandler = createSchedulerTickHandler({
    getDb: () => db,
    getCronSecret: () => cronSecret,
    limiter,
  });

  // Verify Player A got +20 ETB referral bonus (15 + 20 = 35 ETB) and Player B got initial 15 ETB
  const [stateA, stateB] = await Promise.all([
    invoke(playerStateHandler, { headers: { authorization: `Bearer ${tokenA}` } }),
    invoke(playerStateHandler, { headers: { authorization: `Bearer ${tokenB}` } }),
  ]);
  assert.equal((stateA.body.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 35);
  assert.equal((stateB.body.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 15);
  assert.equal((stateB.body.profile as { referredByCode?: string }).referredByCode, 'ADEY-500001');

  // Duplicate referral and self-referral must be rejected
  const dupRef = await invoke(playerWalletHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenB}` },
    body: { action: 'apply_promo', code: 'ADEY-500001', idempotencyKey: 'dup_ref_1' },
  });
  assert.equal(dupRef.statusCode, 409);

  const selfRef = await invoke(playerWalletHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenC}` },
    body: { action: 'apply_promo', code: 'ADEY-500003', idempotencyKey: 'self_ref_1' },
  });
  assert.equal(selfRef.statusCode, 400);

  // All 3 players see identical canonical room list (10 / 20 / 10 ETB) and synchronized timer
  const [roomsA, roomsB, roomsC] = await Promise.all([
    invoke(roomsHandler, { headers: { authorization: `Bearer ${tokenA}` } }),
    invoke(roomsHandler, { headers: { authorization: `Bearer ${tokenB}` } }),
    invoke(roomsHandler, { headers: { authorization: `Bearer ${tokenC}` } }),
  ]);
  const listA = roomsA.body.rooms as Array<{ roomId: string; cardPrice: number }>;
  const listB = roomsB.body.rooms as Array<{ roomId: string; cardPrice: number }>;
  const listC = roomsC.body.rooms as Array<{ roomId: string; cardPrice: number }>;
  assert.deepEqual(
    listA.map((r) => [r.roomId, r.cardPrice]),
    listB.map((r) => [r.roomId, r.cardPrice])
  );
  assert.deepEqual(
    listB.map((r) => [r.roomId, r.cardPrice]),
    listC.map((r) => [r.roomId, r.cardPrice])
  );

  // Concurrent race on Card #42 between Player A and Player B: only ONE succeeds
  const [raceA, raceB] = await Promise.all([
    invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
      body: { roomId: 'adey-main', cardId: 42, action: 'reserve', idempotencyKey: 'race_a_42' },
    }),
    invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}` },
      body: { roomId: 'adey-main', cardId: 42, action: 'reserve', idempotencyKey: 'race_b_42' },
    }),
  ]);
  assert.deepEqual([raceA.statusCode, raceB.statusCode].sort(), [200, 409]);

  // Ensure all 3 players hold 1 distinct card in adey-main
  const aWon42 = raceA.statusCode === 200;
  if (aWon42) {
    const rB = await invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}` },
      body: { roomId: 'adey-main', cardId: 43, action: 'reserve', idempotencyKey: 'res_b_43' },
    });
    assert.equal(rB.statusCode, 200);
  } else {
    const rA = await invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
      body: { roomId: 'adey-main', cardId: 43, action: 'reserve', idempotencyKey: 'res_a_43' },
    });
    assert.equal(rA.statusCode, 200);
  }
  const rC = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenC}` },
    body: { roomId: 'adey-main', cardId: 44, action: 'reserve', idempotencyKey: 'res_c_44' },
  });
  assert.equal(rC.statusCode, 200);

  // Duplicate click with same idempotencyKey is blocked 409
  const dupClick = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenC}` },
    body: { roomId: 'adey-main', cardId: 44, action: 'reserve', idempotencyKey: 'res_c_44' },
  });
  assert.equal(dupClick.statusCode, 409);

  // Regular players MUST NOT be able to manually start, draw, or reset the game
  for (const tok of [tokenA, tokenB, tokenC]) {
    const badStart = await invoke(startHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
      body: { roomId: 'adey-main' },
    });
    assert.equal(badStart.statusCode, 403);

    const badDraw = await invoke(drawHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
      body: { roomId: 'adey-main' },
    });
    assert.equal(badDraw.statusCode, 403);

    const badReset = await invoke(resetHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
      body: { roomId: 'adey-main' },
    });
    assert.equal(badReset.statusCode, 403);
  }

  // Trigger autonomous scheduler tick after registration deadline expires
  const roomDoc = store.get('rooms/adey-main')!;
  store.set('rooms/adey-main', {
    ...roomDoc,
    registrationDeadlineMs: Date.now() - 2000,
  });

  const tickStart = await invoke(tickHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${cronSecret}` },
    body: { roomId: 'adey-main', maxSteps: 1 },
  });
  assert.equal(tickStart.statusCode, 200);
  assert.equal(store.get('rooms/adey-main')?.status, 'live');

  // Once live, card selection is locked for all players
  const lateReserve = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: { roomId: 'adey-main', cardId: 99, action: 'reserve', idempotencyKey: 'late_99' },
  });
  assert.equal(lateReserve.statusCode, 409);

  // Verify co-winner tie visibility in GET /api/player/state
  const card42 = generateDeterministicCard(42);
  const card43 = generateDeterministicCard(43);
  const tieGameId = 'game_adey-main_tie_check';
  store.set(`games/${tieGameId}`, {
    gameId: tieGameId,
    roomId: 'adey-main',
    roomNameAm: 'አደይ ዋና አዳራሽ',
    roomNameEn: 'Adey Main Hall',
    status: 'completed',
    winnerUid: 'tg_500001',
    winningCardId: card42.id,
    cardPrice: 10,
    winnersPrizePoolEtb: 24,
    calledNumbers: [1, 2, 3, 4, 5],
    completedAt: new Date().toISOString(),
    winners: [
      { uid: 'tg_500001', telegramUserId: 500001, displayName: 'Dawit', cardId: card42.id, prizeEtb: 12 },
      { uid: 'tg_500002', telegramUserId: 500002, displayName: 'Hanna', cardId: card43.id, prizeEtb: 12 },
    ],
  });

  const stateBAfterTie = await invoke(playerStateHandler, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  const historyB = stateBAfterTie.body.gameHistory as Array<{ id: string; prizeDemo: number }>;
  const tieRecord = historyB.find((g) => g.id === tieGameId);
  assert.ok(tieRecord, 'Second co-winner must see simultaneous tie win in gameHistory');
  assert.equal(tieRecord.prizeDemo, 12);
});

test('Telegram contact sharing: enforces unique phone bindings across accounts, blocks verified overwrite, and rejects unverified text/forwarded contacts', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '999999:TEST_ADEBINGO_CONTACT';
  const nowUnix = Math.floor(Date.now() / 1000);
  const limiter = new BoundedRateLimiter();

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    nowUnixSeconds: () => nowUnix,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_tg_${telegramUserId}`,
    }),
    limiter,
  });
  const authDeps = createAuthDeps({}, [], botToken);
  const botCmdHandler = createBotCommandHandler({ getDb: () => db, authDeps, limiter });

  const auth1 = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(botToken, nowUnix, {
        id: 600001,
        first_name: 'Meron',
        username: 'meron_c',
      }),
    },
  });
  const auth2 = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(botToken, nowUnix, {
        id: 600002,
        first_name: 'Bereket',
        username: 'bereket_c',
      }),
    },
  });
  const tok1 = String(auth1.body.sessionToken);
  const tok2 = String(auth2.body.sessionToken);

  // Plain-text phone number must never be verified
  const plainText = await invoke(botCmdHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok1}` },
    body: { text: '+251911223399' },
  });
  assert.equal(plainText.body.registrationStatus, 'pending_contact');

  // Client-forged contact object on /api/telegram/bot-command must be rejected with 403
  const forgedViaBotCmd = await invoke(botCmdHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok1}` },
    body: {
      text: '',
      contact: { phone_number: '+251911223399', first_name: 'Meron', user_id: 600001 },
    },
  });
  assert.equal(forgedViaBotCmd.statusCode, 403);
  assert.equal(forgedViaBotCmd.body.reason, 'native_telegram_contact_required');
  assert.equal(store.get('users/tg_600001')?.phoneVerified, false);

  const webhookSecret = 'func-verif-webhook-secret-9999';
  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    fetchImpl: (async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    limiter,
  });

  // Forwarded/third-party contact (mismatched user_id) on webhook must be rejected
  const mismatched = await invoke(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600101,
      message: {
        from: { id: 600001, first_name: 'Meron', username: 'meron_c' },
        chat: { id: 600001, type: 'private' },
        contact: { phone_number: '+251911223399', first_name: 'Other', user_id: 999999 },
      },
    },
  });
  assert.equal(mismatched.body.ok, false);

  // User 1 verifies own native Telegram phone contact -> stored in /users/tg_600001/private/contact and phoneBindings
  const verify1 = await invoke(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600102,
      message: {
        from: { id: 600001, first_name: 'Meron', username: 'meron_c' },
        chat: { id: 600001, type: 'private' },
        contact: { phone_number: '+251911223399', first_name: 'Meron', user_id: 600001 },
      },
    },
  });
  assert.equal(verify1.statusCode, 200);
  assert.equal(verify1.body.registrationStatus, 'verified');
  assert.equal(store.get('users/tg_600001/private/contact')?.phoneVerified, true);
  assert.equal(store.get('phoneBindings/251911223399')?.uid, 'tg_600001');

  // User 2 tries to verify the EXACT SAME phone number -> blocked as duplicate_phone_number
  const dupPhone = await invoke(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600103,
      message: {
        from: { id: 600002, first_name: 'Bereket', username: 'bereket_c' },
        chat: { id: 600002, type: 'private' },
        contact: { phone_number: '+251911223399', first_name: 'Bereket', user_id: 600002 },
      },
    },
  });
  assert.equal(dupPhone.body.ok, false);
  assert.equal(dupPhone.body.securityCode, 'duplicate_phone_number');
  assert.equal(store.get('users/tg_600002')?.phoneVerified, false);

  // User 1 tries to overwrite already-verified contact with a different phone -> blocked as verified_contact_locked
  const overwrite = await invoke(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600104,
      message: {
        from: { id: 600001, first_name: 'Meron', username: 'meron_c' },
        chat: { id: 600001, type: 'private' },
        contact: { phone_number: '+251922000111', first_name: 'Meron', user_id: 600001 },
      },
    },
  });
  assert.equal(overwrite.body.ok, false);
  assert.equal(overwrite.body.securityCode, 'verified_contact_locked');
  assert.equal(store.get('users/tg_600001/private/contact')?.phoneNumber, '+251911223399');

  // User 1 re-sharing same verified phone -> idempotent success
  const sameAgain = await invoke(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600105,
      message: {
        from: { id: 600001, first_name: 'Meron', username: 'meron_c' },
        chat: { id: 600001, type: 'private' },
        contact: { phone_number: '+251911223399', first_name: 'Meron', user_id: 600001 },
      },
    },
  });
  assert.equal(sameAgain.body.ok, true);
  assert.equal(sameAgain.body.registrationStatus, 'verified');
});

test('Admin dashboard real operations: RBAC, enriched player view, suspension enforcement, strict payout pipeline, aligned overview/bot/notifications & audit chain', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '999999:TEST_ADEBINGO_ADMIN';
  const nowUnix = Math.floor(Date.now() / 1000);
  const limiter = new BoundedRateLimiter();

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    nowUnixSeconds: () => nowUnix,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_tg_${telegramUserId}`,
    }),
    limiter,
  });

  const authP = await invoke(authHandler, {
    method: 'POST',
    body: {
      initData: buildSignedInitData(botToken, nowUnix, {
        id: 700001,
        first_name: 'Tigest',
        last_name: 'Mekonnen',
        username: 'tigest_p',
      }),
    },
  });
  const playerTok = String(authP.body.sessionToken);

  // Give player 100 ETB balance to test card reserve & payout
  store.set('users/tg_700001', {
    ...store.get('users/tg_700001')!,
    demoBalanceEtb: 100,
  });

  const authDeps = createAuthDeps(
    {
      admin_tok: {
        uid: 'admin_owner',
        email: 'abelbimrew868@gmail.com',
        email_verified: true,
        name: 'Adey Owner',
      },
    },
    ['admin_owner'],
    botToken
  );

  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps, limiter });
  const walletHandler = createPlayerWalletHandler({ getDb: () => db, authDeps, limiter });
  const adminUsersHandler = createAdminUsersHandler({ getDb: () => db, authDeps, limiter });
  const adminStatusHandler = createAdminUserStatusHandler({ getDb: () => db, authDeps, limiter });
  const adminPayoutReviewHandler = createAdminPayoutReviewHandler({ getDb: () => db, authDeps, limiter });
  const adminOverviewHandler = createAdminOverviewHandler({ getDb: () => db, authDeps, limiter });
  const adminBotConfigHandler = createAdminBotConfigHandler({ getDb: () => db, authDeps, limiter });
  const adminNotifSendHandler = createAdminNotificationsSendHandler({ getDb: () => db, authDeps, limiter });
  const adminNotifListHandler = createAdminNotificationsHandler({ getDb: () => db, authDeps, limiter });
  const adminRoundActionHandler = createAdminRoomRoundActionHandler({ getDb: () => db, authDeps, limiter });

  // Non-admin player MUST be blocked 403 on admin endpoints
  const forbiddenAdmin = await invoke(adminUsersHandler, {
    headers: { authorization: `Bearer ${playerTok}` },
  });
  assert.equal(forbiddenAdmin.statusCode, 403);

  // Ensure canonical rooms exist and player reserves Card #7
  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps, limiter });
  await invoke(roomsHandler, { headers: { authorization: `Bearer ${playerTok}` } });
  const resCard = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: { roomId: 'adey-main', cardId: 7, action: 'reserve', idempotencyKey: 'p_card_7' },
  });
  assert.equal(resCard.statusCode, 200);

  // Player submits a withdrawal request (Pending)
  const wReq = await invoke(walletHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: {
      action: 'withdraw_request',
      amountEtb: 25,
      method: 'Telebirr (Manual)',
      idempotencyKey: 'w_req_1',
    },
  });
  assert.equal(wReq.statusCode, 201);
  const requestId = String((wReq.body.withdrawal as { requestId: string }).requestId);

  // Admin inspects players: activeRoomCards is populated!
  const usersRes = await invoke(adminUsersHandler, {
    headers: { authorization: 'Bearer admin_tok' },
    query: { q: '700001' },
  });
  assert.equal(usersRes.statusCode, 200);
  const foundUser = (usersRes.body.users as Array<Record<string, unknown>>)[0];
  assert.equal(foundUser.telegramUserId, 700001);
  assert.deepEqual(foundUser.activeRoomCards, [{ roomId: 'adey-main', cardIds: [7] }]);

  // Admin suspends player -> player is immediately blocked 403 from reserving cards and withdrawing
  const suspendRes = await invoke(adminStatusHandler, {
    method: 'POST',
    url: '/api/admin/users/tg_700001/status',
    headers: { authorization: 'Bearer admin_tok' },
    body: { accountStatus: 'suspended', reason: 'Audit hold' },
  });
  assert.equal(suspendRes.statusCode, 200);

  const blockedCard = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: { roomId: 'adey-main', cardId: 8, action: 'reserve', idempotencyKey: 'blocked_8' },
  });
  assert.equal(blockedCard.statusCode, 403);

  const blockedWithdraw = await invoke(walletHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: { action: 'withdraw_request', amountEtb: 10, method: 'Telebirr', idempotencyKey: 'blocked_w' },
  });
  assert.equal(blockedWithdraw.statusCode, 403);

  // Suspended player CAN still submit a support ticket
  const allowedSupport = await invoke(walletHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: {
      action: 'support_ticket',
      category: 'account',
      subject: 'Account review',
      message: 'Please review my account suspension.',
      idempotencyKey: 'sup_1',
    },
  });
  assert.equal(allowedSupport.statusCode, 201);

  // Admin reactivates player -> card reserve works again
  const reactivateRes = await invoke(adminStatusHandler, {
    method: 'POST',
    url: '/api/admin/users/tg_700001/status',
    headers: { authorization: 'Bearer admin_tok' },
    body: { accountStatus: 'active', reason: 'Cleared' },
  });
  assert.equal(reactivateRes.statusCode, 200);

  const unblockedCard = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTok}` },
    body: { roomId: 'adey-main', cardId: 8, action: 'reserve', idempotencyKey: 'unblocked_8' },
  });
  assert.equal(unblockedCard.statusCode, 200);

  // Direct Pending -> Completed is strictly rejected (409); Pending -> Approved -> Completed succeeds
  const payoutSkip = await invoke(adminPayoutReviewHandler, {
    method: 'POST',
    url: `/api/admin/payouts/${requestId}/review`,
    headers: { authorization: 'Bearer admin_tok' },
    body: { nextStatus: 'Completed', reviewNotes: 'Skip approval' },
  });
  assert.equal(payoutSkip.statusCode, 409);

  const payoutApprove = await invoke(adminPayoutReviewHandler, {
    method: 'POST',
    url: `/api/admin/payouts/${requestId}/review`,
    headers: { authorization: 'Bearer admin_tok' },
    body: { nextStatus: 'Approved', reviewNotes: 'Approved for Telebirr payout' },
  });
  assert.equal(payoutApprove.statusCode, 200);
  assert.equal((payoutApprove.body.payout as { status: string }).status, 'Approved');

  const payoutComplete = await invoke(adminPayoutReviewHandler, {
    method: 'POST',
    url: `/api/admin/payouts/${requestId}/review`,
    headers: { authorization: 'Bearer admin_tok' },
    body: { nextStatus: 'Completed', reviewNotes: 'Paid via Telebirr' },
  });
  assert.equal(payoutComplete.statusCode, 200);
  assert.equal((payoutComplete.body.payout as { status: string }).status, 'Completed');

  // Admin overview exposes aligned financialDashboard fields & activity summary
  const overviewRes = await invoke(adminOverviewHandler, {
    headers: { authorization: 'Bearer admin_tok' },
  });
  assert.equal(overviewRes.statusCode, 200);
  const fin = (overviewRes.body.overview as { financialDashboard: Record<string, unknown> })
    .financialDashboard;
  assert.equal(fin.maxPlayersCapacity, 600);
  assert.equal(typeof fin.verifiedPaidEntriesCount, 'number');
  assert.ok('currentDrawnNumber' in fin);
  const feed = fin.liveActivityFeed as Array<{ summary?: string }>;
  assert.ok(feed.length > 0 && typeof feed[0].summary === 'string' && feed[0].summary.length > 0);

  // Admin bot config saves playAm/playEn into canonical playBingoAm/playBingoEn
  const botSave = await invoke(adminBotConfigHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin_tok' },
    body: {
      buttonLabels: { playAm: '🎱 አደይ ቢንጎ ክፈት', playEn: '🎱 Open Adey Bingo' },
    },
  });
  assert.equal(botSave.statusCode, 200);
  const savedLabels = (botSave.body.botConfig as { buttonLabels: Record<string, string> })
    .buttonLabels;
  assert.equal(savedLabels.playBingoAm, '🎱 አደይ ቢንጎ ክፈት');
  assert.equal(savedLabels.playBingoEn, '🎱 Open Adey Bingo');

  // Admin notifications send supports payload.responseMessage and returns messageText
  const notifSend = await invoke(adminNotifSendHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin_tok' },
    body: {
      event: 'support_response',
      telegramUserId: 700001,
      payload: { responseMessage: 'Your support ticket is resolved.' },
    },
  });
  assert.equal(notifSend.statusCode, 200);

  const notifList = await invoke(adminNotifListHandler, {
    headers: { authorization: 'Bearer admin_tok' },
  });
  const outbox = notifList.body.outbox as Array<{ messageText?: string; telegramUserId: number }>;
  assert.equal(outbox[0].telegramUserId, 700001);
  assert.equal(outbox[0].messageText, 'Your support ticket is resolved.');

  // Admin room round action returns numeric roundNumber
  const resetAct = await invoke(adminRoundActionHandler, {
    method: 'POST',
    url: '/api/admin/rooms/adey-main/round-action',
    headers: { authorization: 'Bearer admin_tok' },
    body: { action: 'reset' },
  });
  assert.equal(resetAct.statusCode, 200);
  assert.equal(typeof resetAct.body.roundNumber, 'number');

  // Verify SHA-256 audit hash chain integrity
  const adminSvc = new PersistentAdminService(db);
  const integrity = await adminSvc.verifyAuditChainIntegrity();
  assert.equal(integrity.valid, true);
  assert.ok(integrity.totalEntries >= 4);
});

test('Countdown 00:00 never stalls: server-side due-deadline progression triggers registration extension, auto-start, missed-tick catch-up, and intermission reset exactly once across concurrent players', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '999999:TEST_ADEBINGO_TIMER_00';
  const cronSecret = 'cron_secret_timer_verification_32_chars';
  const nowUnix = Math.floor(Date.now() / 1000);
  const limiter = new BoundedRateLimiter();

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    nowUnixSeconds: () => nowUnix,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_tg_${telegramUserId}`,
    }),
    limiter,
  });

  // Authenticate 5 players
  const playerTokens: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const authRes = await invoke(authHandler, {
      method: 'POST',
      body: {
        initData: buildSignedInitData(botToken, nowUnix, {
          id: 810000 + i,
          first_name: `TimerPlayer${i}`,
          username: `timer_p${i}`,
        }),
      },
    });
    assert.equal(authRes.statusCode, 200);
    playerTokens.push(String(authRes.body.sessionToken));
  }

  const authDeps = createAuthDeps(
    {
      admin_tok: {
        uid: 'admin_timer_owner',
        email: 'abelbimrew868@gmail.com',
        email_verified: true,
        name: 'Adey Owner',
      },
    },
    ['admin_timer_owner'],
    botToken
  );

  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps, limiter });
  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps, limiter });
  const startHandler = createStartGameHandler({ getDb: () => db, authDeps, limiter });
  const drawHandler = createDrawBallHandler({ getDb: () => db, authDeps, limiter });
  const resetHandler = createResetRoundHandler({ getDb: () => db, authDeps, limiter });
  const tickHandler = createSchedulerTickHandler({
    getDb: () => db,
    getCronSecret: () => cronSecret,
    authDeps,
    limiter,
  });

  // Regular players must NEVER be able to start, draw, reset, or invoke /api/game/tick
  for (const [h, body] of [
    [startHandler, { roomId: 'adey-main' }],
    [drawHandler, { roomId: 'adey-main' }],
    [resetHandler, { roomId: 'adey-main' }],
    [tickHandler, { roomId: 'adey-main' }],
  ] as const) {
    const forbidden = await invoke(h, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerTokens[0]}` },
      body,
    });
    assert.equal(forbidden.statusCode, 403);
  }

  // Initialize rooms & let 2 players reserve cards (< minPlayers = 3)
  const initList = await invoke(roomsHandler, {
    headers: { authorization: `Bearer ${playerTokens[0]}` },
  });
  assert.equal(initList.statusCode, 200);

  for (let i = 0; i < 2; i++) {
    const r = await invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerTokens[i]}` },
      body: { roomId: 'adey-main', cardId: i + 1, action: 'reserve', idempotencyKey: `t_res_${i}` },
    });
    assert.equal(r.statusCode, 200);
  }

  // 1. REGISTRATION EXPIRY AT 00:00 WITH < 3 PLAYERS -> 5 concurrent GET /api/rooms polls
  // MUST extend registration EXACTLY ONCE without external cron, preserving all 2 cards
  store.set('rooms/adey-main', {
    ...(store.get('rooms/adey-main') ?? {}),
    status: 'countdown',
    registrationDeadlineMs: Date.now() - 500, // expired!
  });

  const extResponses = await Promise.all(
    playerTokens.map((tok) =>
      invoke(roomsHandler, {
        headers: { authorization: `Bearer ${tok}` },
        query: { roomId: 'adey-main' },
      })
    )
  );
  for (const resp of extResponses) {
    assert.equal(resp.statusCode, 200);
    const room = resp.body.room as {
      status: string;
      extendedRegistrationCount: number;
      registrationDeadlineMs: number;
      countdownSeconds: number;
      totalCardsSold: number;
    };
    assert.equal(room.status, 'countdown');
    assert.equal(room.extendedRegistrationCount, 1, 'Registration must extend exactly once');
    assert.ok(room.registrationDeadlineMs > Number(resp.body.serverNowMs));
    assert.ok(room.countdownSeconds >= 55 && room.countdownSeconds <= 60);
    assert.equal(room.totalCardsSold, 2, 'Reserved cards must be preserved');
  }

  // 2. REGISTRATION EXPIRY AT 00:00 WITH >= 3 PLAYERS -> 5 concurrent GET /api/rooms polls
  // MUST auto-start EXACTLY ONCE, draw 1 opening ball, and schedule nextBallDrawAtMs in future
  const thirdCard = await invoke(reserveHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${playerTokens[2]}` },
    body: { roomId: 'adey-main', cardId: 3, action: 'reserve', idempotencyKey: 't_res_2' },
  });
  assert.equal(thirdCard.statusCode, 200);

  store.set('rooms/adey-main', {
    ...(store.get('rooms/adey-main') ?? {}),
    status: 'countdown',
    registrationDeadlineMs: Date.now() - 250, // expired!
  });

  const startResponses = await Promise.all(
    playerTokens.map((tok) =>
      invoke(roomsHandler, {
        headers: { authorization: `Bearer ${tok}` },
        query: { roomId: 'adey-main' },
      })
    )
  );
  for (const resp of startResponses) {
    assert.equal(resp.statusCode, 200);
    const room = resp.body.room as {
      status: string;
      nextBallDrawAtMs: number;
      totalCollectedEtb: number;
      winnersPrizePoolEtb: number;
    };
    const game = resp.body.game as { status: string; calledNumbers: number[] };
    assert.equal(room.status, 'live');
    assert.ok(room.nextBallDrawAtMs > Number(resp.body.serverNowMs) - 100);
    assert.equal(room.totalCollectedEtb, 30);
    assert.equal(room.winnersPrizePoolEtb, 24);
    assert.equal(game.status, 'live');
    assert.equal(game.calledNumbers.length, 1, 'Exactly 1 opening ball drawn');
  }

  // 3. MISSED SCHEDULER TICKS WITH RECENT LEASE -> catch-up must NOT stall on lease_busy_skipped,
  // must anchor nextBallDrawAtMs in the future, and must never produce duplicate called numbers
  const gameService = new PersistentGameAuthorityService(
    createFirestoreGameStore(db),
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  const nowCatchUp = Date.now() + 25_000; // 25s missed-tick outage!
  // Simulate a recent lease written 10s ago by another worker inside the outage window
  store.set('schedulerLeases/adey-main', {
    roomId: 'adey-main',
    workerId: 'other_worker',
    lastTickMs: nowCatchUp - 10_000,
    leasedUntilMs: nowCatchUp - 8_000,
    lastAction: 'ball_auto_drawn',
    status: 'live',
    updatedAtMs: nowCatchUp - 10_000,
  });
  const catchUpResults = await gameService.tickRoomSchedulerCatchUp({
    roomId: 'adey-main',
    nowMs: nowCatchUp,
    workerId: 'cron_recovery_worker',
    maxSteps: 4,
  });
  assert.ok(catchUpResults.length >= 1);
  assert.ok(
    catchUpResults.some(
      (r) => r.action === 'ball_auto_drawn' || r.action === 'winner_auto_settled'
    ),
    'Missed-tick catch-up must draw balls without stalling on stale lease timestamps'
  );
  const liveGameAfterCatchUp = store.get('games/game_adey-main_live');
  const calledAfterCatchUp = (liveGameAfterCatchUp?.calledNumbers as number[]) || [];
  assert.equal(new Set(calledAfterCatchUp).size, calledAfterCatchUp.length, 'No duplicate balls');
  if (store.get('rooms/adey-main')?.status === 'live') {
    assert.ok(
      Number(store.get('rooms/adey-main')?.nextBallDrawAtMs) > nowCatchUp,
      'nextBallDrawAtMs must be anchored cleanly in the future after catch-up'
    );
  }

  // 4. INTERMISSION DISPLAY & EXPIRY AT 00:00 -> live intermission countdown while active,
  // then 5 concurrent GET /api/rooms polls after expiry create Round #2 EXACTLY ONCE
  const activeIntermissionEnd = Date.now() + 5_000;
  store.set('rooms/adey-main', {
    ...(store.get('rooms/adey-main') ?? {}),
    status: 'completed',
    roundNumber: 1,
    nextBallDrawAtMs: 0,
    intermissionEndsAtMs: activeIntermissionEnd,
  });
  store.set('games/game_adey-main_live', {
    ...(store.get('games/game_adey-main_live') ?? {}),
    status: 'completed',
    roundNumber: 1,
    intermissionEndsAtMs: activeIntermissionEnd,
  });

  const duringIntermission = await invoke(roomsHandler, {
    headers: { authorization: `Bearer ${playerTokens[0]}` },
    query: { roomId: 'adey-main' },
  });
  assert.equal(duringIntermission.statusCode, 200);
  assert.equal((duringIntermission.body.room as { status: string }).status, 'completed');
  assert.ok(
    (duringIntermission.body.room as { countdownSeconds: number }).countdownSeconds >= 3,
    'Active intermission must expose positive remaining countdownSeconds'
  );

  // Now expire intermission -> 5 concurrent GET /api/rooms polls advance to Round #2 exactly once
  store.set('rooms/adey-main', {
    ...(store.get('rooms/adey-main') ?? {}),
    status: 'completed',
    roundNumber: 1,
    intermissionEndsAtMs: Date.now() - 500,
  });
  store.set('games/game_adey-main_live', {
    ...(store.get('games/game_adey-main_live') ?? {}),
    status: 'completed',
    roundNumber: 1,
    intermissionEndsAtMs: Date.now() - 500,
  });

  const nextRoundResponses = await Promise.all(
    playerTokens.map((tok) =>
      invoke(roomsHandler, {
        headers: { authorization: `Bearer ${tok}` },
        query: { roomId: 'adey-main' },
      })
    )
  );
  for (const resp of nextRoundResponses) {
    assert.equal(resp.statusCode, 200);
    const room = resp.body.room as {
      status: string;
      roundNumber: number;
      registrationDeadlineMs: number;
      totalCardsSold: number;
    };
    assert.equal(room.status, 'countdown');
    assert.equal(room.roundNumber, 2, 'Intermission expiry must increment roundNumber exactly once');
    assert.ok(room.registrationDeadlineMs > Number(resp.body.serverNowMs));
    assert.equal(room.totalCardsSold, 0, 'Old round cards must be cleared');
  }

  // 5. Manual admin start sets nextBallDrawAtMs in the future so immediate GET /api/rooms does NOT double-draw
  for (let i = 0; i < 3; i++) {
    await invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerTokens[i]}` },
      body: { roomId: 'meskel-gold', cardId: i + 10, action: 'reserve', idempotencyKey: `m_res_${i}` },
    });
  }
  // Ensure players have enough balance for 20 ETB Meskel Gold
  for (let i = 1; i <= 3; i++) {
    store.set(`users/tg_${810000 + i}`, {
      ...(store.get(`users/tg_${810000 + i}`) ?? {}),
      demoBalanceEtb: 100,
    });
    const r = await invoke(reserveHandler, {
      method: 'POST',
      headers: { authorization: `Bearer ${playerTokens[i - 1]}` },
      body: { roomId: 'meskel-gold', cardId: i + 20, action: 'reserve', idempotencyKey: `m2_res_${i}` },
    });
    assert.equal(r.statusCode, 200);
  }
  const manualStart = await invoke(startHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin_tok' },
    body: { roomId: 'meskel-gold' },
  });
  assert.equal(manualStart.statusCode, 200);
  const immediatePoll = await invoke(roomsHandler, {
    headers: { authorization: `Bearer ${playerTokens[0]}` },
    query: { roomId: 'meskel-gold' },
  });
  assert.equal(immediatePoll.statusCode, 200);
  assert.equal((immediatePoll.body.game as { calledNumbers: number[] }).calledNumbers.length, 1);
  assert.ok(
    Number((immediatePoll.body.room as { nextBallDrawAtMs: number }).nextBallDrawAtMs) >
      Number(immediatePoll.body.serverNowMs) - 500
  );
});

test('Official @AdeyBingoGameBot referral link generation, /start deep-link attribution, and duplicate protection in persistent bot service', async () => {
  const { db, store } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(
    tgStore,
    replayGuard,
    'https://adebingo-3nta.vercel.app/'
  );

  // 1. Inviter registers via /start
  const inviterStart = await botService.handleIncomingUpdate({
    updateId: 99001,
    senderTelegramId: 5152447113,
    chatId: 5152447113,
    chatType: 'private',
    firstName: 'Yonas',
    username: 'yonas_adey',
    text: '/start',
  });
  assert.equal(inviterStart.ok, true);

  // 2. Inviter requests /invite and cb:referral_copy -> exact https://t.me/AdeyBingoGameBot?start=ADEY-5152447113
  const expectedInviteUrl = 'https://t.me/AdeyBingoGameBot?start=ADEY-5152447113';
  const inviteReply = await botService.handleIncomingUpdate({
    updateId: 99002,
    senderTelegramId: 5152447113,
    chatId: 5152447113,
    chatType: 'private',
    text: '/invite',
  });
  assert.equal(inviteReply.ok, true);
  assert.ok(inviteReply.text.includes(expectedInviteUrl));
  assert.ok(!inviteReply.text.includes('AdeyBingoBot?'));

  const shareButton = (inviteReply.replyMarkup.inline_keyboard || [])
    .flat()
    .find((btn) => Boolean(btn.url));
  assert.ok(shareButton?.url);
  assert.ok(shareButton.url.includes(encodeURIComponent(expectedInviteUrl)));

  const copyReply = await botService.handleIncomingUpdate({
    updateId: 99003,
    callbackQueryId: 'cbq_ref_copy_5152447113',
    senderTelegramId: 5152447113,
    chatId: 5152447113,
    chatType: 'private',
    callbackData: 'cb:referral_copy',
  });
  assert.equal(copyReply.ok, true);
  assert.ok(copyReply.text.includes(expectedInviteUrl));

  // 3. Friend opens https://t.me/AdeyBingoGameBot?start=ADEY-5152447113 -> Telegram delivers `/start ADEY-5152447113`
  const friendStart = await botService.handleIncomingUpdate({
    updateId: 99004,
    senderTelegramId: 5152447999,
    chatId: 5152447999,
    chatType: 'private',
    firstName: 'Bethlehem',
    username: 'beth_adey',
    text: '/start ADEY-5152447113',
  });
  assert.equal(friendStart.ok, true);
  assert.equal(store.get('users/tg_5152447999')?.demoBalanceEtb, 15);
  assert.equal(store.get('users/tg_5152447999')?.referredByCode, 'ADEY-5152447113');
  assert.equal(store.get('users/tg_5152447113')?.demoBalanceEtb, 35); // 15 initial + 20 referral bonus

  // 4. Second friend uses bot-qualified lowercase `/start@AdeyBingoGameBot adey-5152447113`
  const friend2Start = await botService.handleIncomingUpdate({
    updateId: 99005,
    senderTelegramId: 5152448000,
    chatId: 5152448000,
    chatType: 'private',
    firstName: 'Samuel',
    username: 'sam_adey',
    text: '/start@AdeyBingoGameBot adey-5152447113',
  });
  assert.equal(friend2Start.ok, true);
  assert.equal(store.get('users/tg_5152448000')?.referredByCode, 'ADEY-5152447113');
  assert.equal(store.get('users/tg_5152447113')?.demoBalanceEtb, 55); // 35 + 20

  // 5. Duplicate referral re-submission by existing invitee is safely ignored (no duplicate bonus)
  const dupStart = await botService.handleIncomingUpdate({
    updateId: 99006,
    senderTelegramId: 5152447999,
    chatId: 5152447999,
    chatType: 'private',
    text: '/start ADEY-5152447113',
  });
  assert.equal(dupStart.ok, true);
  assert.equal(store.get('users/tg_5152447113')?.demoBalanceEtb, 55);
  assert.equal(store.get('users/tg_5152447999')?.demoBalanceEtb, 15);

  // 6. Friend's own /invite link dynamically uses friend's actual Telegram ID
  const friendInvite = await botService.handleIncomingUpdate({
    updateId: 99007,
    senderTelegramId: 5152447999,
    chatId: 5152447999,
    chatType: 'private',
    text: '/invite',
  });
  assert.ok(friendInvite.text.includes('https://t.me/AdeyBingoGameBot?start=ADEY-5152447999'));
});
