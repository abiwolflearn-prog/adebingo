import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import { BoundedRateLimiter } from './http.ts';
import { classifyCustomTokenError } from './firebaseAdmin.ts';
import {
  createFirestoreGameStore,
  PersistentGameAuthorityService,
} from './gamePersistence.ts';
import { PersistentAdminService } from './adminPersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import { createSchedulerTickHandler } from './gameHandler.ts';
import {
  createAdminAuditRoomsHandler,
  createAdminDepositReviewHandler,
  createAdminPayoutReviewHandler,
  createAdminReconcileRoomsHandler,
  createAdminRouterHandler,
} from './adminHandler.ts';
import {
  createBotCommandHandler,
  createTelegramAuthHandler,
  createTelegramWebhookHandler,
} from './telegramHandler.ts';
import {
  createPlayerStateHandler,
  createPlayerWalletHandler,
} from './playerHandler.ts';
import { AUTHORITATIVE_PRODUCTION_ROOMS } from '../../src/game/roomCatalog.ts';
import { INITIAL_ROOMS } from '../../src/data/demoData.ts';
import { calculateAuthoritativeGameFinancials } from '../../src/game/rules.ts';
import { mintServerSessionToken } from '../../src/utils/adminAuthority.ts';

type DocData = Record<string, unknown>;

function createInMemoryFirestore() {
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
          items = [...items].sort((a, b) => {
            const av = a.data[order.field];
            const bv = b.data[order.field];
            if (typeof av === 'number' && typeof bv === 'number') {
              return order.dir === 'asc' ? av - bv : bv - av;
            }
            const as = String(av ?? '');
            const bs = String(bv ?? '');
            return order.dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
          });
        }
        if (limitCount !== undefined) {
          items = items.slice(0, limitCount);
        }
        const docs = items.map((item) => makeSnap(item.id, item.path, item.data));
        return {
          docs,
          size: docs.length,
          empty: docs.length === 0,
          forEach: (cb: (d: ReturnType<typeof makeSnap>) => void) => docs.forEach(cb),
        };
      },
    };
  }

  function makeCollectionRef(colPath: string) {
    return {
      path: colPath,
      doc(id?: string) {
        const docId = id || `auto_${crypto.randomBytes(6).toString('hex')}`;
        return makeDocRef(`${colPath}/${docId}`);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(colPath, [{ field, op, value }]);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(colPath, [], { field, dir });
      },
      limit(count: number) {
        return makeQuery(colPath, [], undefined, count);
      },
      async get() {
        return makeQuery(colPath).get();
      },
    };
  }

  const db = {
    collection(name: string) {
      return makeCollectionRef(name);
    },
    doc(path: string) {
      return makeDocRef(path);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const next = txQueue.then(async () => {
        const staged = new Map<string, DocData>(
          Array.from(store.entries()).map(([k, v]) => [k, clone(v)])
        );
        const tx = {
          async get(target: { path?: string; get?: () => Promise<unknown> }) {
            if (target.path && !target.path.endsWith('/')) {
              const parts = target.path.split('/');
              if (parts.length % 2 === 0) {
                const id = parts[parts.length - 1];
                return makeSnap(id, target.path, staged.get(target.path));
              }
              const prefix = `${target.path}/`;
              const docs: Array<ReturnType<typeof makeSnap>> = [];
              for (const [p, d] of staged.entries()) {
                if (!p.startsWith(prefix)) continue;
                const rem = p.slice(prefix.length);
                if (rem.includes('/')) continue;
                docs.push(makeSnap(rem, p, d));
              }
              return {
                docs,
                size: docs.length,
                empty: docs.length === 0,
                forEach: (cb: (d: ReturnType<typeof makeSnap>) => void) => docs.forEach(cb),
              };
            }
            if (typeof target.get === 'function') {
              return target.get();
            }
            throw new Error('Unsupported transaction get target');
          },
          create(ref: { path: string }, data: DocData) {
            if (staged.has(ref.path)) {
              const err = new Error(`ALREADY_EXISTS: ${ref.path}`) as Error & { code?: number };
              err.code = 6;
              throw err;
            }
            staged.set(ref.path, clone(data));
          },
          set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
            if (opts?.merge && staged.has(ref.path)) {
              staged.set(ref.path, { ...staged.get(ref.path)!, ...clone(data) });
            } else {
              staged.set(ref.path, clone(data));
            }
          },
          update(ref: { path: string }, data: DocData) {
            const cur = staged.get(ref.path);
            if (!cur) throw new Error(`Document missing in tx: ${ref.path}`);
            staged.set(ref.path, { ...cur, ...clone(data) });
          },
          delete(ref: { path: string }) {
            staged.delete(ref.path);
          },
        };
        const result = await fn(tx);
        store.clear();
        for (const [k, v] of staged.entries()) {
          store.set(k, v);
        }
        return result;
      });
      txQueue = next.catch(() => undefined);
      return next;
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
          ops.push(() => {
            if (opts?.merge && store.has(ref.path)) {
              store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
            } else {
              store.set(ref.path, clone(data));
            }
          });
        },
        update(ref: { path: string }, data: DocData) {
          ops.push(() => {
            const cur = store.get(ref.path);
            if (!cur) throw new Error(`Document missing in batch: ${ref.path}`);
            store.set(ref.path, { ...cur, ...clone(data) });
          });
        },
        delete(ref: { path: string }) {
          ops.push(() => store.delete(ref.path));
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
  };

  return { db: db as unknown as Firestore, store };
}

function buildSignedInitData(
  botToken: string,
  authDate: number,
  user: Record<string, unknown>,
  extraParams: Record<string, string> = {}
): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `QID_${crypto.randomBytes(6).toString('hex')}`,
    user: JSON.stringify(user),
    ...extraParams,
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function createMockAuthDeps(
  tokenMap: Record<string, DecodedIdTokenLike>,
  adminUids: string[] = [],
  sessionSecret = 'test-session-secret-32-chars-minimum'
): AuthBackendDeps {
  return {
    verifyIdToken: async (token: string) => {
      const decoded = tokenMap[token];
      if (!decoded) throw new Error('Invalid token');
      return decoded;
    },
    isAdminUid: async (uid: string) => adminUids.includes(uid),
    getSessionSecret: () => sessionSecret,
  };
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void>,
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
  }
) {
  let statusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let rawBody = '';

  const req = {
    method: opts.method || 'GET',
    url: opts.url || '/',
    headers: Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
    query: opts.query || {},
    body: opts.body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;

  const resObj = {
    statusCode: 200,
    setHeader(name: string, val: string) {
      responseHeaders[name.toLowerCase()] = String(val);
      return resObj;
    },
    status(code: number) {
      statusCode = code;
      resObj.statusCode = code;
      return resObj;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        rawBody += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      }
      return resObj;
    },
    json(data: unknown) {
      rawBody = JSON.stringify(data);
      return resObj;
    },
  };
  const res = resObj as unknown as VercelResponse;

  await handler(req, res);
  let parsedBody: Record<string, unknown> = {};
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    parsedBody = { raw: rawBody };
  }
  return { statusCode, headers: responseHeaders, body: parsedBody };
}

// =============================================================================
// PHASE 1 — Firestore Persistence & Room Integrity
// =============================================================================

test('Phase 1: Canonical rooms initialize cleanly without fake players, conflicting rooms, or overwriting existing room docs', async () => {
  const { db, store } = createInMemoryFirestore();
  const gameStore = createFirestoreGameStore(db);
  const adminService = new PersistentAdminService(db);

  // Verify demo UI fixtures also start clean (no fabricated activePlayers or taken cards)
  assert.equal(INITIAL_ROOMS.length, AUTHORITATIVE_PRODUCTION_ROOMS.length);
  for (const room of INITIAL_ROOMS) {
    assert.equal(room.activePlayers, 0);
    assert.deepEqual(room.takenCardIds, []);
    assert.equal(room.status, 'countdown');
  }

  // Pre-seed a customized production room doc to prove ensureDefaultRooms / ensureSeedData NEVER overwrites it
  store.set('rooms/adey-main', {
    roomId: 'adey-main',
    nameAm: 'አደይ ዋና አዳራሽ (Custom)',
    nameEn: 'Adey Main Hall (Custom)',
    cardPrice: 15,
    cardPriceEtb: 15,
    status: 'countdown',
    roundNumber: 7,
    activePlayersCount: 0,
    cardsSold: 0,
    confirmedPlayersCount: 0,
    totalCollectedEtb: 0,
    adeyShareEtb: 0,
    winnersPrizePoolEtb: 0,
    registrationDeadlineMs: 1_900_000_000_000,
    maxPlayersPerRoom: 600,
    maxCardsPerRoom: 600,
    maxCardsPerPlayer: 4,
    minPlayers: 3,
    countdownSeconds: 60,
    drawIntervalMs: 3000,
    intermissionSeconds: 10,
  });

  await gameStore.ensureDefaultRooms();
  await adminService.ensureSeedData();

  // Only the 3 canonical rooms exist (no conflicting adey-fast or adey-vip)
  const roomKeys = Array.from(store.keys()).filter((k) => /^rooms\/[^/]+$/.test(k)).sort();
  assert.deepEqual(roomKeys, ['rooms/addis-express', 'rooms/adey-main', 'rooms/meskel-gold']);

  // Existing adey-main document preserved intact
  assert.equal(store.get('rooms/adey-main')?.cardPrice, 15);
  assert.equal(store.get('rooms/adey-main')?.roundNumber, 7);
  assert.equal(store.get('rooms/adey-main')?.registrationDeadlineMs, 1_900_000_000_000);

  // Newly created rooms have canonical pricing and clean 0-player state
  assert.equal(store.get('rooms/meskel-gold')?.cardPrice, 20);
  assert.equal(store.get('rooms/meskel-gold')?.cardPriceEtb, 20);
  assert.equal(store.get('rooms/meskel-gold')?.activePlayersCount, 0);
  assert.equal(store.get('rooms/addis-express')?.status, 'countdown');
  assert.equal(store.get('rooms/addis-express')?.activePlayersCount, 0);

  // Zero fake demo users, deposits, payouts, referrals, or genesis audit logs seeded
  assert.equal(Array.from(store.keys()).filter((k) => k.startsWith('users/')).length, 0);
  assert.equal(Array.from(store.keys()).filter((k) => k.startsWith('depositRequests/')).length, 0);
  assert.equal(Array.from(store.keys()).filter((k) => k.startsWith('payoutRequests/')).length, 0);
  assert.equal(Array.from(store.keys()).filter((k) => k.startsWith('referrals/')).length, 0);
  assert.equal(Array.from(store.keys()).filter((k) => k.startsWith('adminAuditLogs/')).length, 0);
});

test('Phase 1: Per-room cardPrice (20 ETB Meskel Gold) drives card debits, 80/20 financials, and admin overview metrics', async () => {
  const { db, store } = createInMemoryFirestore();
  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  const adminService = new PersistentAdminService(db);

  await gameStore.ensureDefaultRooms();

  for (const [uid, name] of [
    ['tg_101', 'Selam'],
    ['tg_102', 'Hanna'],
    ['tg_103', 'Dawit'],
  ] as const) {
    store.set(`users/${uid}`, {
      uid,
      telegramUserId: uid,
      displayName: name,
      language: 'am',
      phoneVerified: true,
      demoBalanceEtb: 200,
    });
  }

  // Reserve cards in meskel-gold (20 ETB per card)
  const r1 = await gameService.reserveOrReleaseCard({
    roomId: 'meskel-gold',
    cardId: 5,
    uid: 'tg_101',
    displayName: 'Selam',
    telegramUserId: 'tg_101',
  });
  const r2 = await gameService.reserveOrReleaseCard({
    roomId: 'meskel-gold',
    cardId: 6,
    uid: 'tg_101',
    displayName: 'Selam',
    telegramUserId: 'tg_101',
  });
  const r3 = await gameService.reserveOrReleaseCard({
    roomId: 'meskel-gold',
    cardId: 12,
    uid: 'tg_102',
    displayName: 'Hanna',
    telegramUserId: 'tg_102',
  });
  const r4 = await gameService.reserveOrReleaseCard({
    roomId: 'meskel-gold',
    cardId: 19,
    uid: 'tg_103',
    displayName: 'Dawit',
    telegramUserId: 'tg_103',
  });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(r4.ok, true);

  // Balance debits reflect 20 ETB per card (NOT 10 ETB)
  assert.equal(store.get('users/tg_101')?.demoBalanceEtb, 160);
  assert.equal(store.get('users/tg_102')?.demoBalanceEtb, 180);
  assert.equal(store.get('users/tg_103')?.demoBalanceEtb, 180);

  // Room financials match calculateAuthoritativeGameFinancials(3, 4, 20)
  const expectedFin = calculateAuthoritativeGameFinancials(3, 4, 20);
  const meskelDoc = store.get('rooms/meskel-gold');
  assert.equal(meskelDoc?.activePlayersCount, 3);
  assert.equal(meskelDoc?.totalCardsSold, 4);
  assert.equal(meskelDoc?.totalCollectedEtb, expectedFin.totalCollectedEtb);
  assert.equal(meskelDoc?.adeyShareEtb, expectedFin.adeyShareEtb);
  assert.equal(meskelDoc?.winnersPrizePoolEtb, expectedFin.winnersPrizePoolEtb);

  // Verify admin overview metrics read actual room cardPriceEtb (not hardcoded 10)
  store.set('rooms/adey-main', {
    ...(store.get('rooms/adey-main') ?? {}),
    cardPrice: 25,
    cardPriceEtb: 25,
    activePlayersCount: 4,
    confirmedPlayersCount: 4,
    totalCardsSold: 4,
  });
  const overview = await adminService.getOverviewMetrics();
  assert.equal(overview.financialDashboard.entryPriceEtb, 25);
  assert.equal(overview.financialDashboard.verifiedTotalRevenueEtb, 100);
  assert.equal(overview.financialDashboard.adeyShareEtb, 20);
  assert.equal(overview.financialDashboard.winnersPrizePoolEtb, 80);
});

test('Phase 1: Room integrity validation and non-destructive reconciliation repair drifted counts and ghost live rooms via Admin API', async () => {
  const { db, store } = createInMemoryFirestore();
  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  await gameStore.ensureDefaultRooms();

  store.set('users/tg_201', {
    uid: 'tg_201',
    telegramUserId: 'tg_201',
    displayName: 'Player One',
    demoBalanceEtb: 100,
  });
  await gameService.reserveOrReleaseCard({
    roomId: 'meskel-gold',
    cardId: 21,
    uid: 'tg_201',
    displayName: 'Player One',
    telegramUserId: 'tg_201',
  });

  // Inject drift on meskel-gold and make addis-express a ghost empty live room
  store.set('rooms/meskel-gold', {
    ...(store.get('rooms/meskel-gold') ?? {}),
    activePlayersCount: 99,
    cardsSold: 88,
    cardPrice: 20,
    cardPriceEtb: 10, // conflicting price field
    totalCollectedEtb: 999,
    winnersPrizePoolEtb: 777,
  });
  store.set('rooms/addis-express', {
    ...(store.get('rooms/addis-express') ?? {}),
    status: 'live',
    activePlayersCount: 0,
    cardsSold: 0,
  });

  const authDeps = createMockAuthDeps(
    {
      'admin-tok': { uid: 'tg_9000', name: 'Admin', email_verified: true },
      'player-tok': { uid: 'tg_201', name: 'Player One', telegram_verified: true },
    },
    ['tg_9000']
  );

  const auditHandler = createAdminAuditRoomsHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const reconcileHandler = createAdminReconcileRoomsHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // Non-admin blocked (403)
  const playerAudit = await invokeHandler(auditHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer player-tok' },
  });
  assert.equal(playerAudit.statusCode, 403);

  // Admin audit detects discrepancies
  const auditBefore = await invokeHandler(auditHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer admin-tok' },
  });
  assert.equal(auditBefore.statusCode, 200);
  assert.equal(auditBefore.body.valid, false);
  assert.ok(Number(auditBefore.body.invalidCount) >= 2);

  // Default Admin reconcile runs in dryRun preview mode (zero production mutations without approval)
  const previewRes = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: {},
  });
  assert.equal(previewRes.statusCode, 200);
  assert.equal(previewRes.body.dryRun, true);
  assert.equal(previewRes.body.reconciledCount, 0);
  assert.equal(store.get('rooms/meskel-gold')?.activePlayersCount, 99, 'Dry-run preview must NOT mutate rooms');

  // Applying without explicit owner approval (confirmApply: true) is rejected with 400 approval_required
  const unapprovedRes = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: { dryRun: false },
  });
  assert.equal(unapprovedRes.statusCode, 400);
  assert.equal(unapprovedRes.body.reason, 'approval_required');

  // Admin reconcile with explicit approval creates backup snapshots and fixes drift non-destructively
  const reconcileRes = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: { dryRun: false, confirmApply: true },
  });
  assert.equal(reconcileRes.statusCode, 200);
  assert.equal(reconcileRes.body.dryRun, false);
  assert.ok(Number(reconcileRes.body.reconciledCount) >= 2);
  const backupIds = (reconcileRes.body.backupIds as string[]) || [];
  assert.ok(backupIds.length >= 2, 'Must record backup snapshots before applying reconciliation');
  assert.equal(store.has(`roomReconciliationBackups/${backupIds[0]}`), true);

  // Real card and player subcollection records are untouched
  assert.equal(store.get('rooms/meskel-gold/cards/21')?.ownerId, 'tg_201');
  assert.equal(store.has('rooms/meskel-gold/players/tg_201'), true);

  // Room aggregates and ghost live status are repaired
  assert.equal(store.get('rooms/meskel-gold')?.activePlayersCount, 1);
  assert.equal(store.get('rooms/meskel-gold')?.totalCardsSold, 1);
  assert.equal(store.get('rooms/meskel-gold')?.cardPrice, 20);
  assert.equal(store.get('rooms/meskel-gold')?.cardPriceEtb, 20);
  assert.equal(store.get('rooms/meskel-gold')?.totalCollectedEtb, 20);
  assert.equal(store.get('rooms/meskel-gold')?.winnersPrizePoolEtb, 16);
  assert.equal(store.get('rooms/addis-express')?.status, 'countdown');

  // Subsequent audit reports 100% valid
  const auditAfter = await invokeHandler(auditHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer admin-tok' },
  });
  assert.equal(auditAfter.statusCode, 200);
  assert.equal(auditAfter.body.valid, true);
  assert.equal(auditAfter.body.invalidCount, 0);

  // Also verify consolidated /api/admin router dispatches audit/rooms and audit/rooms/reconcile
  const adminRouter = createAdminRouterHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const routedAudit = await invokeHandler(adminRouter, {
    method: 'GET',
    query: { route: 'audit/rooms' },
    headers: { authorization: 'Bearer admin-tok' },
  });
  assert.equal(routedAudit.statusCode, 200);
  assert.equal(routedAudit.body.valid, true);
});

// =============================================================================
// PHASE 2 — Autonomous Vercel-Compatible Scheduler
// =============================================================================

test('Phase 2: /api/game/tick enforces CRON_SECRET fail-closed auth and supports Vercel Cron GET, POST, and Admin tokens', async () => {
  const { db } = createInMemoryFirestore();
  const cronSecret = 'prod-cron-secret-value-at-least-24-chars';
  const sessionSecret = 'admin-session-secret-at-least-32-chars!!';

  const authDeps = createMockAuthDeps(
    {
      'player.jwt.tok': { uid: 'tg_555', name: 'Regular Player', telegram_verified: true },
    },
    ['tg_999'],
    sessionSecret
  );

  // 1. Missing CRON_SECRET -> fails closed 503
  const unconfiguredTick = createSchedulerTickHandler({
    getDb: () => db,
    authDeps,
    getCronSecret: () => '',
  });
  const res503 = await invokeHandler(unconfiguredTick, { method: 'GET' });
  assert.equal(res503.statusCode, 503);
  assert.equal(res503.body.reason, 'cron_secret_not_configured');

  const tickHandler = createSchedulerTickHandler({
    getDb: () => db,
    authDeps,
    getCronSecret: () => cronSecret,
  });

  // 2. Wrong CRON_SECRET -> 401
  const res401 = await invokeHandler(tickHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer wrong-secret-value' },
  });
  assert.equal(res401.statusCode, 401);
  assert.equal(res401.body.reason, 'invalid_cron_secret');

  // 3. Regular player JWT token -> 403
  const res403 = await invokeHandler(tickHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer player.jwt.tok' },
    body: { roomId: 'adey-main' },
  });
  assert.equal(res403.statusCode, 403);

  // 4. Valid Vercel Cron GET with Authorization: Bearer <CRON_SECRET> -> 200
  const resCronGet = await invokeHandler(tickHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(resCronGet.statusCode, 200);
  assert.equal(resCronGet.body.ok, true);
  assert.equal(resCronGet.body.authorizedVia, 'cron_secret');

  // 5. Valid POST with x-cron-secret header -> 200
  const resCronHeader = await invokeHandler(tickHandler, {
    method: 'POST',
    headers: { 'x-cron-secret': cronSecret },
    body: { roomId: 'adey-main', maxSteps: 5 },
  });
  assert.equal(resCronHeader.statusCode, 200);
  assert.equal(resCronHeader.body.ok, true);

  // 6. Valid Admin signed session token -> 200
  const { token: adminSessionToken } = mintServerSessionToken(
    {
      uid: 'tg_999',
      telegramUserId: 999,
      displayName: 'Lead Admin',
      username: 'lead_admin',
      isAdminOverride: true,
    },
    sessionSecret
  );
  const resAdmin = await invokeHandler(tickHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSessionToken}` },
    body: { roomId: 'adey-main' },
  });
  assert.equal(resAdmin.statusCode, 200);
  assert.equal(resAdmin.body.authorizedVia, 'admin_token');
});

test('Phase 2: Autonomous scheduler runs full lifecycle (countdown -> auto-start -> catch-up ball draws -> single settlement -> intermission -> next round) with no duplicates', async () => {
  const { db, store } = createInMemoryFirestore();
  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  await gameStore.ensureDefaultRooms();

  const roomId = 'meskel-gold'; // 20 ETB per card
  const players = [
    { uid: 'tg_301', name: 'Abebe', cardId: 1 },
    { uid: 'tg_302', name: 'Sara', cardId: 2 },
    { uid: 'tg_303', name: 'Bereket', cardId: 3 },
  ];
  for (const p of players) {
    store.set(`users/${p.uid}`, {
      uid: p.uid,
      telegramUserId: p.uid,
      displayName: p.name,
      demoBalanceEtb: 100,
    });
    const res = await gameService.reserveOrReleaseCard({
      roomId,
      cardId: p.cardId,
      uid: p.uid,
      displayName: p.name,
      telegramUserId: p.uid,
    });
    assert.equal(res.ok, true);
  }

  let nowMs = 1_800_000_000_000;

  // Simulate legacy room with registrationDeadlineMs: 0 so ensureSharedRegistrationDeadline initializes it at synthetic nowMs + 60,000ms
  store.set(`rooms/${roomId}`, {
    ...(store.get(`rooms/${roomId}`) ?? {}),
    registrationDeadlineMs: 0,
  });

  // Step 1: Ensure shared registration deadline (60s countdown)
  const deadlineMs = await gameService.ensureSharedRegistrationDeadline(roomId, nowMs);
  assert.equal(deadlineMs, nowMs + 60_000);

  // Step 2: Advance past countdown deadline -> autonomous start
  nowMs += 61_000;
  const startTick = await gameService.tickRoomScheduler({
    roomId,
    nowMs,
    workerId: 'cron-worker-1',
  });
  assert.equal(startTick.ok, true);
  assert.equal(startTick.action, 'game_auto_started');
  assert.equal(store.get(`rooms/${roomId}`)?.status, 'live');
  const gameId = String(store.get(`rooms/${roomId}`)?.currentGameId || startTick.gameId);
  assert.ok(gameId);

  // Step 3: Simulate missed scheduler invocations (15 seconds delayed -> 5 missed 3s intervals)
  nowMs += 15_000;
  const catchUpBatch = await gameService.tickRoomSchedulerCatchUp({
    roomId,
    nowMs,
    workerId: 'cron-worker-2',
    maxSteps: 5,
  });
  assert.ok(catchUpBatch.length >= 1);
  assert.equal(catchUpBatch.every((r) => r.ok), true);

  // Verify zero duplicate called numbers after catch-up
  const calledAfterCatchUp = (store.get(`games/${gameId}`)?.calledNumbers as number[]) || [];
  assert.equal(new Set(calledAfterCatchUp).size, calledAfterCatchUp.length);

  // Step 4: Continue catching up until automatic winner settlement
  let settled = catchUpBatch.some((r) => r.action === 'winner_auto_settled');
  let safetyLoops = 0;
  while (!settled && safetyLoops < 30) {
    nowMs += 30_000;
    const batch = await gameService.tickRoomSchedulerCatchUp({
      roomId,
      nowMs,
      workerId: `cron-loop-${safetyLoops}`,
      maxSteps: 10,
    });
    assert.ok(batch.length >= 1);
    assert.equal(batch.every((r) => r.ok), true);
    if (batch.some((r) => r.action === 'winner_auto_settled')) {
      settled = true;
      break;
    }
    safetyLoops++;
  }
  assert.equal(settled, true, 'Game should autonomously settle a winner within 75 draws');

  const settledRoom = store.get(`rooms/${roomId}`);
  const settledGame = store.get(`games/${gameId}`);
  assert.equal(settledRoom?.status, 'completed');
  assert.equal(settledGame?.status, 'completed');

  // Verify called numbers contain no duplicates
  const finalCalled = (settledGame?.calledNumbers as number[]) || [];
  assert.equal(new Set(finalCalled).size, finalCalled.length);

  // Verify 80/20 payout accuracy: 3 players * 20 ETB = 60 ETB total, 48 ETB winners prize pool (80%)
  const winners = (settledGame?.winners as Array<{ uid: string; prizeEtb: number }>) || [];
  assert.ok(winners.length >= 1);
  const totalDistributed = Number(
    winners.reduce((sum, w) => sum + Number(w.prizeEtb), 0).toFixed(2)
  );
  assert.equal(totalDistributed, 48);

  // Snapshot winner balances before duplicate tick attempt
  const balancesAfterSettle = Object.fromEntries(
    players.map((p) => [p.uid, Number(store.get(`users/${p.uid}`)?.demoBalanceEtb)])
  );

  // Duplicate tick during active lease / intermission must NOT double-credit or create duplicate win transactions
  const settledAtMs = Number(settledRoom?.lastSchedulerTickMs ?? nowMs);
  const dupTick = await gameService.tickRoomScheduler({
    roomId,
    nowMs: settledAtMs + 1000,
    workerId: 'cron-dup',
  });
  assert.equal(dupTick.ok, true);
  assert.equal(
    dupTick.action === 'lease_busy_skipped' || dupTick.action === 'noop',
    true
  );
  for (const p of players) {
    assert.equal(store.get(`users/${p.uid}`)?.demoBalanceEtb, balancesAfterSettle[p.uid]);
  }

  // Step 5: Advance past intermission (10s) -> automatic next round creation
  const intermissionEndMs = Number(settledRoom?.intermissionEndsAtMs || settledAtMs + 10_000);
  const resetTick = await gameService.tickRoomScheduler({
    roomId,
    nowMs: intermissionEndMs + 1000,
    workerId: 'cron-reset',
  });
  assert.equal(resetTick.ok, true);
  assert.equal(resetTick.action, 'next_game_auto_created');
  assert.equal(store.get(`rooms/${roomId}`)?.status, 'countdown');
  assert.equal(store.get(`rooms/${roomId}`)?.roundNumber, 2);
  assert.equal(store.get(`rooms/${roomId}`)?.totalCardsSold, 0);
});

// =============================================================================
// PHASE 3 — Multiplayer Synchronization & Referral Deep-Link
// =============================================================================

test('Phase 3: Two players (inviter + invitee) with different local clocks sync identical countdown, cards, round, and 20 ETB financials via Vercel APIs', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '123456789:ABCDEF_MULTIPLAYER_TEST_TOKEN';
  const nowUnix = Math.floor(Date.now() / 1000);

  // Seed inviter
  store.set('users/tg_5001', {
    uid: 'tg_5001',
    telegramUserId: 'tg_5001',
    displayName: 'Inviter Selam',
    demoBalanceEtb: 100,
  });
  store.set('botPlayers/5001', {
    telegramId: 5001,
    uid: 'tg_5001',
    displayName: 'Inviter Selam',
    demoBalanceEtb: 100,
    referralCode: 'ADEY-5001',
    referralCount: 0,
    referralBonusEtb: 0,
    totalWins: 0,
  });

  // Invitee authenticates with referral deep-link start_param=ADEY-5001
  const tgAuthHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_${telegramUserId}`,
    }),
  });
  const inviteeInitData = buildSignedInitData(
    botToken,
    nowUnix - 2,
    { id: 5002, first_name: 'Invitee', last_name: 'Kaleb', username: 'kaleb_tg' },
    { start_param: 'ADEY-5001' }
  );
  const authRes = await invokeHandler(tgAuthHandler, {
    method: 'POST',
    body: { initData: inviteeInitData },
  });
  assert.equal(authRes.statusCode, 200);
  assert.equal(authRes.body.ok, true);

  // Mark both players phone-verified and credit invitee so they can reserve a 20 ETB card in meskel-gold
  store.set('users/tg_5001', {
    ...(store.get('users/tg_5001') ?? {}),
    phoneVerified: true,
  });
  store.set('users/tg_5002', {
    ...(store.get('users/tg_5002') ?? {}),
    phoneVerified: true,
    demoBalanceEtb: 100,
  });

  const authDeps = createMockAuthDeps({
    'tok-inviter': { uid: 'tg_5001', telegram_id: 5001, telegram_verified: true, name: 'Inviter Selam' },
    'tok-invitee': { uid: 'tg_5002', telegram_id: 5002, telegram_verified: true, name: 'Invitee Kaleb' },
  });

  const roomsHandler = createRoomsHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const reserveHandler = createReserveCardHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // Inviter fetches rooms (lazily persists one shared registrationDeadlineMs)
  const inviterRooms = await invokeHandler(roomsHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-inviter' },
  });
  assert.equal(inviterRooms.statusCode, 200);
  const inviterServerNow = Number(inviterRooms.body.serverNowMs);
  const inviterMeskel = (inviterRooms.body.rooms as Array<Record<string, unknown>>).find(
    (r) => r.roomId === 'meskel-gold'
  )!;
  assert.ok(Number(inviterMeskel.registrationDeadlineMs) > inviterServerNow);

  // Inviter reserves card 7 in meskel-gold (20 ETB)
  const reserveInviter = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-inviter' },
    body: { roomId: 'meskel-gold', cardId: 7 },
  });
  assert.equal(reserveInviter.statusCode, 200);

  // Invitee reserves card 8 in meskel-gold (20 ETB)
  const reserveInvitee = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-invitee' },
    body: { roomId: 'meskel-gold', cardId: 8 },
  });
  assert.equal(reserveInvitee.statusCode, 200);

  // Both fetch room detail
  const detailInviter = await invokeHandler(roomsHandler, {
    method: 'GET',
    query: { roomId: 'meskel-gold' },
    headers: { authorization: 'Bearer tok-inviter' },
  });
  const detailInvitee = await invokeHandler(roomsHandler, {
    method: 'GET',
    query: { roomId: 'meskel-gold' },
    headers: { authorization: 'Bearer tok-invitee' },
  });

  assert.equal(detailInviter.statusCode, 200);
  assert.equal(detailInvitee.statusCode, 200);

  const roomA = detailInviter.body.room as Record<string, unknown>;
  const roomB = detailInvitee.body.room as Record<string, unknown>;

  // Both players receive identical authoritative deadline, round, taken cards, and 20 ETB financials
  assert.equal(roomA.registrationDeadlineMs, roomB.registrationDeadlineMs);
  assert.equal(roomA.roundNumber, roomB.roundNumber);
  assert.equal(roomA.cardPrice, 20);
  assert.equal(roomB.cardPrice, 20);
  assert.equal(roomA.totalCollectedEtb, 40);
  assert.equal(roomB.totalCollectedEtb, 40);
  assert.equal(roomA.winnersPrizePoolEtb, 32);
  assert.equal(roomB.winnersPrizePoolEtb, 32);
  assert.deepEqual(detailInviter.body.takenCardIds, [7, 8]);
  assert.deepEqual(detailInvitee.body.takenCardIds, [7, 8]);

  // Simulate skewed local clocks (+8s on inviter device, -6s on invitee device):
  // Using serverClockOffset = serverNowMs - localNowMs produces identical remaining seconds!
  const trueNowMs = Number(detailInviter.body.serverNowMs);
  const inviterLocalClock = trueNowMs + 8_000;
  const inviteeLocalClock = trueNowMs - 6_000;
  const inviterOffset = Number(detailInviter.body.serverNowMs) - inviterLocalClock;
  const inviteeOffset = Number(detailInvitee.body.serverNowMs) - inviteeLocalClock;

  const inviterRemaining = Math.max(
    0,
    Math.ceil((Number(roomA.registrationDeadlineMs) - (inviterLocalClock + inviterOffset)) / 1000)
  );
  const inviteeRemaining = Math.max(
    0,
    Math.ceil((Number(roomB.registrationDeadlineMs) - (inviteeLocalClock + inviteeOffset)) / 1000)
  );
  assert.equal(Math.abs(inviterRemaining - inviteeRemaining) <= 1, true);

  // Verify referral attribution was persisted via start_param
  const referralDocs = Array.from(store.entries()).filter(([k]) => k.startsWith('referrals/'));
  assert.equal(referralDocs.length, 1);
  assert.equal(referralDocs[0][1].inviterUid, 'tg_5001');
  assert.equal(referralDocs[0][1].inviteeUid, 'tg_5002');
});

// =============================================================================
// PHASE 4 — Telegram Authentication, IAM Diagnostics & Verified Phone Contact
// =============================================================================

test('Phase 4: Telegram auth enforces HMAC validation, replay protection, IAM signBlob diagnostics, and verified phone contact binding', async () => {
  const { db, store } = createInMemoryFirestore();
  const botToken = '987654321:XYZ_TELEGRAM_AUTH_TEST_TOKEN';
  const nowUnix = Math.floor(Date.now() / 1000);

  // 1. IAM / credential error classification (never exposes raw secrets)
  assert.equal(
    classifyCustomTokenError(
      new Error('Permission iam.serviceAccounts.signBlob denied on resource projects/x/serviceAccounts/y')
    ).code,
    'iam_sign_blob_permission_denied'
  );
  assert.equal(
    classifyCustomTokenError(new Error('Failed to parse private key: Invalid PEM formatted message')).code,
    'invalid_private_key'
  );
  assert.equal(
    classifyCustomTokenError(new Error('Firebase Admin SDK credentials are not configured')).code,
    'firebase_admin_unconfigured'
  );

  // 2. When mintCustomToken throws IAM signBlob error, /api/telegram/auth returns safe 503 diagnostic
  const iamFailHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async () => {
      throw new Error(
        'Error: Permission iam.serviceAccounts.signBlob denied for service account'
      );
    },
  });
  const iamInitData = buildSignedInitData(botToken, nowUnix - 3, {
    id: 6001,
    first_name: 'Meron',
    username: 'meron_et',
  });
  const iamRes = await invokeHandler(iamFailHandler, {
    method: 'POST',
    body: { initData: iamInitData },
  });
  assert.equal(iamRes.statusCode, 503);
  assert.equal(iamRes.body.reason, 'iam_sign_blob_permission_denied');

  // 3. Valid HMAC initData mints custom token, binds canonical tg_<id>, and blocks replay on second attempt
  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `fb_custom_${telegramUserId}`,
    }),
  });

  const validInitData = buildSignedInitData(botToken, nowUnix - 4, {
    id: 6002,
    first_name: 'Yonas',
    username: 'yonas_tg',
  });
  const okRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInitData },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.uid, 'tg_6002');
  assert.equal(okRes.body.customToken, 'fb_custom_6002');
  assert.equal(store.get('telegramBindings/tg_6002')?.uid, 'tg_6002');

  // Replay of identical initData -> 409
  const replayRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInitData },
  });
  assert.equal(replayRes.statusCode, 409);

  // Tampered signature -> 401
  const tamperedRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInitData.replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)) },
  });
  assert.equal(tamperedRes.statusCode, 401);

  // 4. Client-supplied contact payloads on /api/telegram/bot-command must be rejected;
  //    only real native Telegram webhook updates may mark a phone as verified.
  const authDeps = createMockAuthDeps({
    'tok-6002': { uid: 'tg_6002', telegram_id: 6002, telegram_verified: true, name: 'Yonas' },
  });
  const botCmdHandler = createBotCommandHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // Forbidden client override field rejected with 403
  const spoofedRes = await invokeHandler(botCmdHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-6002' },
    body: {
      senderTelegramId: 9999,
      contact: { phone_number: '+251911223344', first_name: 'Yonas' },
    },
  });
  assert.equal(spoofedRes.statusCode, 403);

  // Client-forged contact JSON on /api/telegram/bot-command rejected with 403 native_telegram_contact_required
  const forgedClientContact = await invokeHandler(botCmdHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-6002' },
    body: {
      contact: { phone_number: '+251911223344', first_name: 'Yonas', user_id: 6002 },
    },
  });
  assert.equal(forgedClientContact.statusCode, 403);
  assert.equal(forgedClientContact.body.reason, 'native_telegram_contact_required');
  assert.equal(store.get('users/tg_6002')?.phoneVerified, false);

  // Native Telegram webhook contact sharing: mismatched contact.user_id rejected (does not mark phoneVerified)
  const webhookSecret = 'prod-readiness-webhook-secret-9999';
  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    fetchImpl: (async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    limiter: new BoundedRateLimiter(),
  });
  const mismatchedContact = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600201,
      message: {
        from: { id: 6002, first_name: 'Yonas', username: 'yonas_tg' },
        chat: { id: 6002, type: 'private' },
        contact: { phone_number: '+251911223344', first_name: 'Other', user_id: 99999 },
      },
    },
  });
  assert.equal(mismatchedContact.body.ok, false);
  assert.equal(store.get('users/tg_6002')?.phoneVerified, false);

  // Valid native Telegram webhook contact binds sender Telegram ID and persists private contact
  const verifiedContact = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 600202,
      message: {
        from: { id: 6002, first_name: 'Yonas', username: 'yonas_tg' },
        chat: { id: 6002, type: 'private' },
        contact: { phone_number: '+251 911 223 344', first_name: 'Yonas', user_id: 6002 },
      },
    },
  });
  assert.equal(verifiedContact.statusCode, 200);
  assert.equal(verifiedContact.body.ok, true);
  assert.equal(store.get('users/tg_6002')?.phoneVerified, true);
  assert.equal(store.get('botPlayers/6002')?.phoneVerified, true);
  assert.equal(store.get('users/tg_6002/private/contact')?.phoneNumber, '+251911223344');
});

// =============================================================================
// PHASE 5 — Player & Payment Persistence & Strict State Transitions
// =============================================================================

test('Phase 5: Payment/withdrawal state transitions enforce strict matrices, sync users+botPlayers, and report accurate gameHistory', async () => {
  const { db, store } = createInMemoryFirestore();

  // Player exists only in botPlayers initially (testing withdraw_request users/{uid} upsert sync)
  store.set('botPlayers/7001', {
    telegramId: 7001,
    uid: 'tg_7001',
    displayName: 'Tigist',
    demoBalanceEtb: 200,
    phoneVerified: true,
    referralCode: 'ADEY-7001',
  });

  // Archive a completed 20 ETB meskel-gold game with 2 co-winners (48 ETB pool -> 24 ETB each)
  store.set('games/game_meskel-gold_r1', {
    gameId: 'game_meskel-gold_r1',
    roomId: 'meskel-gold',
    roomNameAm: 'መስቀል ጎልድ',
    roomNameEn: 'Meskel Gold',
    roundNumber: 1,
    cardPrice: 20,
    entryFeeDemo: 20,
    demoPrizeEtb: 48,
    winnerUid: 'tg_7001',
    winnerCardId: 14,
    winners: [
      { uid: 'tg_7001', displayName: 'Tigist', cardId: 14, prizeEtb: 24 },
      { uid: 'tg_7002', displayName: 'Hana', cardId: 22, prizeEtb: 24 },
    ],
    calledNumbers: [3, 18, 33, 49, 66],
    completedAt: '2026-04-01T12:00:00.000Z',
  });

  const authDeps = createMockAuthDeps(
    {
      'tok-player': { uid: 'tg_7001', telegram_id: 7001, telegram_verified: true, name: 'Tigist' },
      'tok-admin': { uid: 'tg_9001', email_verified: true, name: 'Lead Admin' },
    },
    ['tg_9001']
  );

  const walletHandler = createPlayerWalletHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const playerStateHandler = createPlayerStateHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const depositReviewHandler = createAdminDepositReviewHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const payoutReviewHandler = createAdminPayoutReviewHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // 1. Player submits manual deposit request -> status Pending (never auto-credited)
  const depReq = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player' },
    body: {
      action: 'deposit_request',
      amountEtb: 150,
      method: 'Telebirr (Manual)',
      referenceCode: 'TB-REAL-7001',
    },
  });
  assert.equal(depReq.statusCode, 201);
  const depositId = String((depReq.body.deposit as { depositId: string }).depositId);
  assert.equal(store.get(`depositRequests/${depositId}`)?.status, 'Pending');
  assert.equal(store.get('botPlayers/7001')?.demoBalanceEtb, 200); // not credited yet

  // Pending -> Pending no-op rejected with 409 invalid_transition
  const depNoop = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { depositId },
    body: { nextStatus: 'Pending', reviewNotes: 'Invalid no-op' },
  });
  assert.equal(depNoop.statusCode, 409);
  assert.equal(depNoop.body.reason, 'invalid_transition');

  // Pending -> Approved credits 150 ETB atomically across users + botPlayers + transactions
  const depApprove = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { depositId },
    body: { nextStatus: 'Approved', reviewNotes: 'Verified receipt' },
  });
  assert.equal(depApprove.statusCode, 200);
  assert.equal(store.get('users/tg_7001')?.demoBalanceEtb, 350);
  assert.equal(store.get('botPlayers/7001')?.demoBalanceEtb, 350);

  // Re-approving finalized deposit -> 409 already_finalized (no double credit)
  const depSecond = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { depositId },
    body: { nextStatus: 'Approved', reviewNotes: 'Duplicate' },
  });
  assert.equal(depSecond.statusCode, 409);
  assert.equal(depSecond.body.reason, 'already_finalized');
  assert.equal(store.get('users/tg_7001')?.demoBalanceEtb, 350);

  // 2. Player submits withdrawal request (100 ETB) -> holds funds in both users & botPlayers
  const withdraw1 = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player' },
    body: {
      action: 'withdraw_request',
      amountEtb: 100,
      method: 'Telebirr (Manual)',
      accountMask: '+251911000111',
    },
  });
  assert.equal(withdraw1.statusCode, 201);
  const payoutId1 = String((withdraw1.body.withdrawal as { requestId: string }).requestId);
  assert.equal(store.get('users/tg_7001')?.demoBalanceEtb, 250);
  assert.equal(store.get('botPlayers/7001')?.demoBalanceEtb, 250);

  // Direct jump Pending -> Completed rejected with 409 invalid_transition
  const badJump = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Completed', reviewNotes: 'Skipping review' },
  });
  assert.equal(badJump.statusCode, 409);
  assert.equal(badJump.body.reason, 'invalid_transition');

  // Valid pipeline: Pending -> Under Review -> Approved -> Completed
  const stepReview = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Under Review', reviewNotes: 'Checking account' },
  });
  assert.equal(stepReview.statusCode, 200);

  const stepApprove = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Approved', reviewNotes: 'Approved for transfer' },
  });
  assert.equal(stepApprove.statusCode, 200);

  // Backwards Approved -> Pending rejected with 409 invalid_transition
  const badBackwards = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Pending', reviewNotes: 'Cannot revert' },
  });
  assert.equal(badBackwards.statusCode, 409);
  assert.equal(badBackwards.body.reason, 'invalid_transition');

  const stepComplete = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Completed', reviewNotes: 'Transferred' },
  });
  assert.equal(stepComplete.statusCode, 200);

  // Terminal Completed -> Rejected blocked (409 already_finalized)
  const afterComplete = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId1 },
    body: { nextStatus: 'Rejected', reviewNotes: 'Too late' },
  });
  assert.equal(afterComplete.statusCode, 409);
  assert.equal(afterComplete.body.reason, 'already_finalized');

  // 3. Second withdrawal rejected -> refunds 50 ETB atomically once
  const withdraw2 = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player' },
    body: {
      action: 'withdraw_request',
      amountEtb: 50,
      method: 'CBE Birr (Manual)',
      accountMask: '1000123456789',
    },
  });
  assert.equal(withdraw2.statusCode, 201);
  const payoutId2 = String((withdraw2.body.withdrawal as { requestId: string }).requestId);
  assert.equal(store.get('users/tg_7001')?.demoBalanceEtb, 200);

  const reject2 = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    query: { requestId: payoutId2 },
    body: { nextStatus: 'Rejected', reviewNotes: 'Invalid account' },
  });
  assert.equal(reject2.statusCode, 200);
  assert.equal(store.get('users/tg_7001')?.demoBalanceEtb, 250);
  assert.equal(store.get('botPlayers/7001')?.demoBalanceEtb, 250);

  // 4. GET /api/player/state reports accurate 20 ETB entryFeeDemo and 24 ETB split prizeDemo
  const stateRes = await invokeHandler(playerStateHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-player' },
  });
  assert.equal(stateRes.statusCode, 200);
  const wallet = stateRes.body.wallet as Record<string, unknown>;
  assert.equal(wallet.availableBalanceEtb, 250);
  const history = stateRes.body.gameHistory as Array<Record<string, unknown>>;
  assert.equal(history.length, 1);
  assert.equal(history[0].entryFeeDemo, 20);
  assert.equal(history[0].prizeDemo, 24);
});
