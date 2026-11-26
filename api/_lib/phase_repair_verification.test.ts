import test from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTelegramWebhookHandler } from './telegramHandler.ts';
import {
  createBingoCallTtsHandler,
  createDrawBallHandler,
  createSchedulerStatusHandler,
  createSchedulerTickHandler,
  createStartGameHandler,
  createVerifyWinnerHandler,
} from './gameHandler.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import { createPlayerWalletHandler } from './playerHandler.ts';
import { createAdminReconcileRoomsHandler } from './adminHandler.ts';
import { createStatusHandler } from '../backend/status.ts';
import {
  createFirestoreGameStore,
  isRoomDueForSchedulerTick,
  PersistentGameAuthorityService,
} from './gamePersistence.ts';
import { PersistentAdminService } from './adminPersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { BoundedRateLimiter } from './http.ts';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import {
  getAuthorizedAdminTelegramIds,
  mintServerSessionToken,
} from '../../src/utils/adminAuthority.ts';
import {
  MAIN_MENU_BUTTONS,
  ONBOARDING_START_BUTTON_TEXT,
  ONBOARDING_START_CALLBACK_DATA,
  SHARE_CONTACT_BUTTON_TEXT,
} from '../../src/utils/telegramBot.ts';
import { generateDeterministicCard } from '../../src/game/rules.ts';

interface MockDoc {
  id: string;
  path: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  get: (field: string) => unknown;
  ref: MockDocRef;
}

interface MockDocRef {
  id: string;
  path: string;
  get: () => Promise<MockDoc>;
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
  update: (data: Record<string, unknown>) => Promise<void>;
  delete: () => Promise<void>;
  collection: (name: string) => MockCollectionRef;
}

interface MockCollectionRef {
  path: string;
  doc: (id?: string) => MockDocRef;
  get: () => Promise<{ docs: MockDoc[]; size: number; empty: boolean }>;
  where: (field: string, op: string, value: unknown) => MockQuery;
  orderBy: (field: string, dir?: 'asc' | 'desc') => MockQuery;
  limit: (n: number) => MockQuery;
}

interface MockQuery {
  where: (field: string, op: string, value: unknown) => MockQuery;
  orderBy: (field: string, dir?: 'asc' | 'desc') => MockQuery;
  limit: (n: number) => MockQuery;
  get: () => Promise<{ docs: MockDoc[]; size: number; empty: boolean }>;
}

function createInMemoryFirestore() {
  const store = new Map<string, Record<string, unknown>>();
  let autoId = 1;

  const clone = <T,>(v: T): T =>
    v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);

  const makeSnap = (path: string, ref: MockDocRef): MockDoc => {
    const raw = store.get(path);
    const id = path.split('/').pop() || '';
    return {
      id,
      path,
      exists: raw !== undefined,
      data: () => (raw ? clone(raw) : undefined),
      get: (field: string) => (raw ? clone(raw[field]) : undefined),
      ref,
    };
  };

  const makeDocRef = (path: string): MockDocRef => {
    const id = path.split('/').pop() || '';
    const ref: MockDocRef = {
      id,
      path,
      async get() {
        return makeSnap(path, ref);
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        if (opts?.merge && store.has(path)) {
          store.set(path, { ...store.get(path)!, ...clone(data) });
        } else {
          store.set(path, clone(data));
        }
      },
      async update(data: Record<string, unknown>) {
        if (!store.has(path)) throw new Error(`Doc not found: ${path}`);
        store.set(path, { ...store.get(path)!, ...clone(data) });
      },
      async delete() {
        store.delete(path);
      },
      collection(sub: string) {
        return makeColRef(`${path}/${sub}`);
      },
    };
    return ref;
  };

  const listCollectionDocs = (colPath: string): MockDoc[] => {
    const prefix = `${colPath}/`;
    const docs: MockDoc[] = [];
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) {
          docs.push(makeSnap(key, makeDocRef(key)));
        }
      }
    }
    return docs;
  };

  const makeQuery = (
    colPath: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    order: { field: string; dir: 'asc' | 'desc' } | null = null,
    limitCount: number | null = null
  ): MockQuery => ({
    where(field, op, value) {
      return makeQuery(colPath, [...filters, { field, op, value }], order, limitCount);
    },
    orderBy(field, dir = 'asc') {
      return makeQuery(colPath, filters, { field, dir }, limitCount);
    },
    limit(n) {
      return makeQuery(colPath, filters, order, n);
    },
    async get() {
      let docs = listCollectionDocs(colPath).filter((d) =>
        filters.every((f) => {
          const v = d.get(f.field);
          if (f.op === '==') return v === f.value;
          if (f.op === '>=') return Number(v) >= Number(f.value);
          if (f.op === '<=') return Number(v) <= Number(f.value);
          return true;
        })
      );
      if (order) {
        docs = docs.sort((a, b) => {
          const av = String(a.get(order.field) ?? '');
          const bv = String(b.get(order.field) ?? '');
          return order.dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
        });
      }
      if (limitCount !== null) {
        docs = docs.slice(0, limitCount);
      }
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });

  const makeColRef = (colPath: string): MockCollectionRef => ({
    path: colPath,
    doc(id?: string) {
      const docId = id || `auto_${autoId++}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
    async get() {
      const docs = listCollectionDocs(colPath);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
    where(field, op, value) {
      return makeQuery(colPath, [{ field, op, value }]);
    },
    orderBy(field, dir = 'asc') {
      return makeQuery(colPath, [], { field, dir });
    },
    limit(n) {
      return makeQuery(colPath, [], null, n);
    },
  });

  const db = {
    collection(name: string) {
      return makeColRef(name);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        get: async (target: MockDocRef | MockQuery) => target.get(),
        create: (ref: MockDocRef, data: Record<string, unknown>) => {
          if (store.has(ref.path)) {
            const err = new Error(`ALREADY_EXISTS: ${ref.path}`) as Error & { code: number };
            err.code = 6;
            throw err;
          }
          store.set(ref.path, clone(data));
        },
        set: (ref: MockDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          if (opts?.merge && store.has(ref.path)) {
            store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
          } else {
            store.set(ref.path, clone(data));
          }
        },
        update: (ref: MockDocRef, data: Record<string, unknown>) => {
          if (!store.has(ref.path)) throw new Error(`NOT_FOUND: ${ref.path}`);
          store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
        },
        delete: (ref: MockDocRef) => {
          store.delete(ref.path);
        },
      };
      return await fn(tx);
    },
  };

  return { db: db as unknown as Firestore, store };
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const req = {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    query: opts.query || {},
    body: opts.body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;
  const res = {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as VercelResponse;

  await handler(req, res);
  return { statusCode, body: payload };
}

function createMockAuthDeps(
  tokens: Record<string, DecodedIdTokenLike>,
  adminUids: string[] = []
): AuthBackendDeps {
  return {
    verifyIdToken: async (tok: string) => {
      const hit = tokens[tok];
      if (!hit) throw new Error('invalid_token');
      return hit;
    },
    isAdminUid: async (uid: string) => adminUids.includes(uid),
  };
}

const TEST_BOT_TOKEN = '987654321:AAH_phase_repair_test_token';
const TEST_WEBHOOK_SECRET = 'phase_repair_webhook_secret_token';

// ============================================================================
// PHASE 1: Exact 3-Step Onboarding, Contact Verification, 8 Bilingual Buttons,
//          Duplicate-Tap Idempotency & Unverified API Bypass Blocking
// ============================================================================
test('Phase 1: Exact 3-step Telegram onboarding, contact security, remove_keyboard, all 8 bilingual buttons, and unverified API gate', async () => {
  const { db, store } = createInMemoryFirestore();
  const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const mockFetch = (async (url: string, init?: { body?: string }) => {
    const method = String(url).split('/').pop() || '';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    telegramCalls.push({ method, body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramCalls.length } }) };
  }) as unknown as typeof fetch;

  const webhook = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    getWebhookSecret: () => TEST_WEBHOOK_SECRET,
    fetchImpl: mockFetch,
    limiter: new BoundedRateLimiter(),
  });

  // STEP 1: /start -> exact bilingual welcome + Start / ጀምር inline button, NO Play button
  const step1 = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10001,
      message: {
        chat: { id: 700101, type: 'private' },
        from: { id: 700101, first_name: 'Hana', username: 'hana_et' },
        text: '/start',
      },
    },
  });
  assert.equal(step1.statusCode, 200);
  assert.equal(step1.body.securityCode, 'onboarding_welcome');
  assert.match(String(step1.body.text), /Welcome to AdeyBingo! 🎉/);
  assert.match(String(step1.body.text), /To get started, press the Start button below\./);
  assert.match(String(step1.body.text), /ወደ አዴይ ቢንጎ እንኳን በደህና መጡ! 🎉/);
  assert.match(String(step1.body.text), /ለመጀመር ከታች ያለውን የጀምር ቁልፍ ይጫኑ።/);

  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].method, 'sendMessage');
  const s1Markup = telegramCalls[0].body.reply_markup as {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: unknown }>>;
    keyboard?: unknown;
  };
  assert.equal(s1Markup.keyboard, undefined);
  assert.ok(
    s1Markup.inline_keyboard
      ?.flat()
      .some((b) => b.text === ONBOARDING_START_BUTTON_TEXT && b.callback_data === ONBOARDING_START_CALLBACK_DATA)
  );
  assert.ok(!s1Markup.inline_keyboard?.flat().some((b) => Boolean(b.web_app)));

  // Unverified player cannot bypass onboarding via direct Mini App API calls!
  const authDeps = createMockAuthDeps(
    { 'tok-unverified': { uid: 'tg_700101', telegram_id: 700101, telegram_verified: true, name: 'Hana' } },
    []
  );
  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const startHandler = createStartGameHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const drawHandler = createDrawBallHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const verifyHandler = createVerifyWinnerHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const walletHandler = createPlayerWalletHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });

  for (const [label, res] of [
    ['reserve', await invokeHandler(reserveHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { roomId: 'adey-main', cardId: 1 } })],
    ['start', await invokeHandler(startHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { roomId: 'adey-main' } })],
    ['draw', await invokeHandler(drawHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { roomId: 'adey-main' } })],
    ['verify', await invokeHandler(verifyHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { roomId: 'adey-main', cardId: 1, markedNumbers: [1, 2, 3, 4] } })],
    ['deposit', await invokeHandler(walletHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { action: 'deposit_request', amountEtb: 100, provider: 'Telebirr' } })],
    ['withdraw', await invokeHandler(walletHandler, { method: 'POST', headers: { authorization: 'Bearer tok-unverified' }, body: { action: 'withdraw_request', amountEtb: 10, method: 'Telebirr' } })],
  ] as const) {
    assert.equal(res.statusCode, 403, `Unverified user must get 403 on ${label}`);
    assert.equal(res.body.reason, 'phone_verification_required', `Reason must be phone_verification_required on ${label}`);
  }

  // STEP 2: User presses Start / ጀምር -> callback acknowledged + ReplyKeyboardMarkup with request_contact: true
  telegramCalls.length = 0;
  const step2 = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10002,
      callback_query: {
        id: 'cbq_step2_700101',
        from: { id: 700101, first_name: 'Hana', username: 'hana_et' },
        message: { chat: { id: 700101, type: 'private' } },
        data: ONBOARDING_START_CALLBACK_DATA,
      },
    },
  });
  assert.equal(step2.statusCode, 200);
  assert.equal(step2.body.securityCode, 'onboarding_request_contact');
  assert.match(String(step2.body.text), /Please share your Telegram phone number to verify your account before playing\./);
  assert.match(String(step2.body.text), /ከመጫወትዎ በፊት መለያዎን ለማረጋገጥ የቴሌግራም ስልክ ቁጥርዎን ያጋሩ።/);
  assert.ok(telegramCalls.some((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cbq_step2_700101'));
  const sendContactCall = telegramCalls.find((c) => c.method === 'sendMessage');
  assert.ok(sendContactCall);
  const contactKb = (sendContactCall!.body.reply_markup as { keyboard?: Array<Array<{ text: string; request_contact?: boolean }>> })?.keyboard?.flat() || [];
  assert.ok(contactKb.some((b) => b.request_contact === true && b.text === SHARE_CONTACT_BUTTON_TEXT));

  // Security check: Reject typed phone number & reject mismatched contact.user_id
  const typedPhone = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10003,
      message: {
        chat: { id: 700101, type: 'private' },
        from: { id: 700101, first_name: 'Hana' },
        text: '+251911700101',
      },
    },
  });
  assert.equal(typedPhone.body.ok, false);
  assert.equal(store.get('users/tg_700101')?.phoneVerified, false);

  const spoofedContact = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10004,
      message: {
        chat: { id: 700101, type: 'private' },
        from: { id: 700101, first_name: 'Hana' },
        contact: { phone_number: '+251911700101', first_name: 'Other', user_id: 999999 },
      },
    },
  });
  assert.equal(spoofedContact.body.ok, false);
  assert.equal(spoofedContact.body.securityCode, 'contact_owner_mismatch');
  assert.equal(store.get('users/tg_700101')?.phoneVerified, false);

  // STEP 3: Authentic contact -> verifies user, removes contact keyboard, sends persistent 8-button main menu
  telegramCalls.length = 0;
  const step3 = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10005,
      message: {
        chat: { id: 700101, type: 'private' },
        from: { id: 700101, first_name: 'Hana', username: 'hana_et' },
        contact: { phone_number: '+251911700101', first_name: 'Hana', user_id: 700101 },
      },
    },
  });
  assert.equal(step3.statusCode, 200);
  assert.equal(step3.body.ok, true);
  assert.equal(step3.body.registrationStatus, 'verified');
  assert.equal(store.get('users/tg_700101')?.phoneVerified, true);
  assert.equal(store.get('users/tg_700101')?.demoBalanceEtb, 15);
  assert.equal(store.get('users/tg_700101/private/contact')?.phoneVerified, true);

  // Must send remove_keyboard first, then follow-up persistent 8-button main menu
  const msgCalls = telegramCalls.filter((c) => c.method === 'sendMessage');
  assert.ok(msgCalls.length >= 2);
  assert.equal((msgCalls[0].body.reply_markup as { remove_keyboard?: boolean })?.remove_keyboard, true);
  const mainMenuButtons = (
    msgCalls[1].body.reply_markup as { keyboard?: Array<Array<{ text: string; web_app?: { url: string } }>> }
  )?.keyboard?.flat() || [];
  for (const label of Object.values(MAIN_MENU_BUTTONS)) {
    assert.ok(mainMenuButtons.some((b) => b.text === label), `Missing main menu button: ${label}`);
  }
  const playBtn = mainMenuButtons.find((b) => b.text === MAIN_MENU_BUTTONS.play);
  assert.equal(playBtn?.web_app?.url, 'https://adebingo-3nta.vercel.app/');

  // Duplicate contact submission must NOT duplicate 15 ETB starter balance
  const dupContact = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 10006,
      message: {
        chat: { id: 700101, type: 'private' },
        from: { id: 700101, first_name: 'Hana', username: 'hana_et' },
        contact: { phone_number: '+251911700101', first_name: 'Hana', user_id: 700101 },
      },
    },
  });
  assert.equal(dupContact.statusCode, 200);
  assert.equal(dupContact.body.securityCode, 'contact_already_verified');
  assert.equal(store.get('users/tg_700101')?.demoBalanceEtb, 15);

  // STEP 4: Every one of the 8 bilingual main menu buttons responds accurately
  let uidCounter = 10100;
  for (const caption of Object.values(MAIN_MENU_BUTTONS)) {
    const r = await invokeHandler(webhook, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: ++uidCounter,
        message: {
          chat: { id: 700101, type: 'private' },
          from: { id: 700101, first_name: 'Hana', username: 'hana_et' },
          text: caption,
        },
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true, `Button ${caption} must succeed`);
  }

  // Rapid duplicate tap on deposit_amount:100 creates ONLY ONE deposit request
  const dep1 = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: ++uidCounter,
      callback_query: {
        id: 'cbq_dep_tap_1',
        from: { id: 700101, first_name: 'Hana' },
        message: { chat: { id: 700101, type: 'private' } },
        data: 'cb:deposit_amount:100',
      },
    },
  });
  const dep2 = await invokeHandler(webhook, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: ++uidCounter,
      callback_query: {
        id: 'cbq_dep_tap_2',
        from: { id: 700101, first_name: 'Hana' },
        message: { chat: { id: 700101, type: 'private' } },
        data: 'cb:deposit_amount:100',
      },
    },
  });
  assert.equal(dep1.body.securityCode, 'deposit_request_created');
  assert.equal(dep2.body.securityCode, 'duplicate_action_tap_blocked');
  const depositDocs = [...store.keys()].filter((k) => k.startsWith('depositRequests/'));
  assert.equal(depositDocs.length, 1, 'Rapid double-tap must create at most 1 deposit request');
});

// ============================================================================
// PHASE 2: CRON_SECRET Auth, Stale Deadline Recovery, Safe Reconciliation
// ============================================================================
test('Phase 2: CRON_SECRET fail-closed auth, scheduler-status protection, stale deadline<=0 recovery, safe dryRun/backup reconciliation, and status report', async () => {
  const { db, store } = createInMemoryFirestore();
  const gameStore = createFirestoreGameStore(db);
  await gameStore.ensureDefaultRooms();

  // Newly created rooms MUST have initialized positive registrationDeadlineMs
  for (const roomId of ['adey-main', 'meskel-gold', 'addis-express']) {
    const deadline = Number(store.get(`rooms/${roomId}`)?.registrationDeadlineMs ?? 0);
    assert.ok(deadline > Date.now() - 5000, `${roomId} must initialize registrationDeadlineMs > 0`);
  }

  // Stale room with registrationDeadlineMs: 0 is detected as due immediately
  assert.equal(
    isRoomDueForSchedulerTick(
      {
        status: 'countdown',
        registrationDeadlineMs: 0,
      },
      Date.now()
    ),
    true
  );

  // Missing CRON_SECRET -> 503 fail-closed on both /api/game/tick and /api/game/scheduler-status
  const unconfiguredTick = createSchedulerTickHandler({
    getDb: () => db,
    getCronSecret: () => '',
    limiter: new BoundedRateLimiter(),
  });
  const unconfiguredStatus = createSchedulerStatusHandler({
    getDb: () => db,
    getCronSecret: () => '',
    limiter: new BoundedRateLimiter(),
  });
  assert.equal((await invokeHandler(unconfiguredTick, { method: 'POST', body: {} })).statusCode, 503);
  assert.equal((await invokeHandler(unconfiguredStatus, { method: 'GET' })).statusCode, 503);

  // Configured CRON_SECRET -> rejects wrong secret (401), accepts Bearer CRON_SECRET (200)
  const cronSecret = 'super_secret_external_cron_token_2026';
  const tickHandler = createSchedulerTickHandler({
    getDb: () => db,
    getCronSecret: () => cronSecret,
    limiter: new BoundedRateLimiter(),
  });
  const statusHandler = createSchedulerStatusHandler({
    getDb: () => db,
    getCronSecret: () => cronSecret,
    limiter: new BoundedRateLimiter(),
  });

  // Set adey-main stale deadline = 0 and verify /api/game/tick repairs it automatically
  store.set('rooms/adey-main', { ...(store.get('rooms/adey-main') || {}), registrationDeadlineMs: 0 });
  assert.equal(
    (await invokeHandler(tickHandler, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).statusCode,
    401
  );
  assert.equal(
    (await invokeHandler(statusHandler, { method: 'GET', headers: { authorization: 'Bearer wrong' } })).statusCode,
    401
  );

  const okTick = await invokeHandler(tickHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${cronSecret}` },
    body: { roomId: 'adey-main' },
  });
  assert.equal(okTick.statusCode, 200);
  assert.ok(Number(store.get('rooms/adey-main')?.registrationDeadlineMs) > Date.now());

  const okStatus = await invokeHandler(statusHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(okStatus.statusCode, 200);
  assert.equal(okStatus.body.cronSecretConfigured, true);

  // /api/backend/status reports cronSecretConfigured without leaking the secret
  const prevCron = process.env.CRON_SECRET;
  process.env.CRON_SECRET = cronSecret;
  try {
    const backendStatus = await invokeHandler(
      createStatusHandler({
        checkFirestore: async () => ({
          reachable: true,
          status: 'ok',
          databaseId: 'test-db',
          latencyMs: 5,
        }),
      }),
      { method: 'GET' }
    );
    assert.equal(backendStatus.statusCode, 200);
    assert.equal(backendStatus.body.cronSecretConfigured, true);
    assert.equal(backendStatus.body.schedulerMode, 'external_cron_3_to_5s');
    assert.ok(!JSON.stringify(backendStatus.body).includes(cronSecret));
  } finally {
    if (prevCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;
  }

  // Safe room reconciliation: dryRun preview -> approval_required -> backup + apply
  store.set('rooms/meskel-gold', { ...(store.get('rooms/meskel-gold') || {}), activePlayersCount: 42 });
  const adminAuthDeps = createMockAuthDeps(
    { 'admin-tok': { uid: 'admin_1', email: 'owner@example.com', email_verified: true, name: 'Owner' } },
    ['admin_1']
  );
  const reconcileHandler = createAdminReconcileRoomsHandler({
    getDb: () => db,
    authDeps: adminAuthDeps,
    limiter: new BoundedRateLimiter(),
  });
  const preview = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: { roomId: 'meskel-gold' },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.dryRun, true);
  assert.equal(store.get('rooms/meskel-gold')?.activePlayersCount, 42);

  const missingApproval = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: { roomId: 'meskel-gold', dryRun: false },
  });
  assert.equal(missingApproval.statusCode, 400);
  assert.equal(missingApproval.body.reason, 'approval_required');

  const applied = await invokeHandler(reconcileHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-tok' },
    body: { roomId: 'meskel-gold', dryRun: false, confirmApply: true },
  });
  assert.equal(applied.statusCode, 200);
  assert.equal(store.get('rooms/meskel-gold')?.activePlayersCount, 0);
  assert.equal(((applied.body.backupIds as string[]) || []).length, 1);
});

// ============================================================================
// PHASE 3 & 4: Referrals (15/20/0), Manual Co-Winner Split, Production TTS,
//              Real Telegram Outbox Dispatch, No Hardcoded 8842109 Admin
// ============================================================================
test('Phase 3 & 4: Manual co-winner splitting, /api/tts/bingo-call, real Telegram outbox delivery, and zero hardcoded 8842109 admin fallback', async () => {
  const { db, store } = createInMemoryFirestore();

  // 1. No hardcoded 8842109 admin fallback when ADEY_ADMIN_TELEGRAM_IDS is unset
  const prevAdmins = process.env.ADEY_ADMIN_TELEGRAM_IDS;
  delete process.env.ADEY_ADMIN_TELEGRAM_IDS;
  try {
    assert.deepEqual(getAuthorizedAdminTelegramIds(), []);
    const minted = mintServerSessionToken(
      { telegramUserId: 8842109, displayName: 'Legacy', username: 'legacy' },
      'test_secret_123456'
    );
    assert.equal(minted.actor.role, 'player');
  } finally {
    if (prevAdmins === undefined) delete process.env.ADEY_ADMIN_TELEGRAM_IDS;
    else process.env.ADEY_ADMIN_TELEGRAM_IDS = prevAdmins;
  }

  // 2. Manual verifyWinner splits 80% prize pool equally across simultaneous co-winners
  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  await gameStore.ensureDefaultRooms();

  for (const [uid, bal] of [
    ['tg_111', 50],
    ['tg_222', 50],
    ['tg_333', 50],
  ] as const) {
    store.set(`users/${uid}`, {
      uid,
      telegramUserId: uid,
      displayName: uid,
      username: uid,
      language: 'am',
      phoneVerified: true,
      demoBalanceEtb: bal,
    });
  }
  await gameService.reserveOrReleaseCard({ roomId: 'adey-main', cardId: 1, uid: 'tg_111', displayName: 'P1', telegramUserId: 'tg_111' });
  await gameService.reserveOrReleaseCard({ roomId: 'adey-main', cardId: 2, uid: 'tg_222', displayName: 'P2', telegramUserId: 'tg_222' });
  await gameService.reserveOrReleaseCard({ roomId: 'adey-main', cardId: 3, uid: 'tg_333', displayName: 'P3', telegramUserId: 'tg_333' });

  // Build calledNumbers that simultaneously complete top row of Card #1 AND Card #2 (but not #3)
  const card1Top = generateDeterministicCard(1).grid[0].filter((n) => n !== 0);
  const card2Top = generateDeterministicCard(2).grid[0].filter((n) => n !== 0);
  const unionCalls = Array.from(new Set([...card1Top, ...card2Top]));

  store.set('rooms/adey-main', { ...(store.get('rooms/adey-main') || {}), status: 'live', hostUid: 'tg_111' });
  store.set('games/game_adey-main_live', {
    gameId: 'game_adey-main_live',
    roomId: 'adey-main',
    hostUid: 'tg_111',
    roundNumber: 1,
    status: 'live',
    calledNumbers: unionCalls,
    latestBall: unionCalls[unionCalls.length - 1],
  });

  const claim = await gameService.verifyWinner({
    roomId: 'adey-main',
    gameId: 'game_adey-main_live',
    claimantUid: 'tg_111',
    playerName: 'P1',
    cardId: 1,
    markedNumbers: card1Top,
  });
  assert.equal(claim.verified, true);
  // 3 cards × 10 ETB = 30 ETB -> 80% prize pool = 24 ETB -> split equally across co-winners
  assert.equal(claim.winnersPrizePoolEtb, 24);
  const coWinners = claim.winners || [];
  assert.ok(coWinners.length >= 2);
  assert.ok(coWinners.some((w) => w.uid === 'tg_111'));
  assert.ok(coWinners.some((w) => w.uid === 'tg_222'));
  assert.equal(Number(coWinners.reduce((sum, w) => sum + w.prizeEtb, 0).toFixed(2)), 24);

  // 3. /api/tts/bingo-call validates ball input and returns clean 503 when GEMINI_API_KEY is unset
  const prevGemini = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const ttsHandler = createBingoCallTtsHandler({ limiter: new BoundedRateLimiter() });
    const badBall = await invokeHandler(ttsHandler, { method: 'GET', query: { number: '99' } });
    assert.equal(badBall.statusCode, 400);

    const noKey = await invokeHandler(ttsHandler, { method: 'GET', query: { number: '14', lang: 'am' } });
    assert.equal(noKey.statusCode, 503);
    assert.equal(noKey.body.reason, 'gemini_api_key_not_configured');
  } finally {
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
  }

  // 4. PersistentAdminService sends real Telegram Bot API sendMessage calls for notifications & announcements
  const outboxCalls: Array<{ chat_id: number; text: string }> = [];
  const adminService = new PersistentAdminService(db, {
    getBotToken: () => TEST_BOT_TOKEN,
    fetchImpl: (async (_url: string, init?: { body?: string }) => {
      if (init?.body) {
        const parsed = JSON.parse(init.body) as { chat_id: number; text: string };
        outboxCalls.push(parsed);
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch,
  });

  store.set('botPlayers/111', { telegramUserId: 111, firebaseUid: 'tg_111', firstName: 'P1', language: 'am' });
  const nowEpoch = Date.now();
  const adminActor = {
    uid: 'admin_owner',
    telegramUserId: 0,
    displayName: 'Owner',
    username: 'owner',
    role: 'admin' as const,
    authMethod: 'firebase_id_token' as const,
    issuedAt: nowEpoch,
    expiresAt: nowEpoch + 3600_000,
  };
  const notifRes = await adminService.sendNotification({
    telegramUserId: 111,
    title: 'Test Notice',
    body: 'Hello from AdeyBingo Admin',
    language: 'en',
    adminActor,
  });
  assert.equal(notifRes.ok, true);
  assert.equal(notifRes.notification?.deliveredViaBotApi, true);
  assert.ok(outboxCalls.some((c) => c.chat_id === 111 && c.text.includes('Hello from AdeyBingo Admin')));

  outboxCalls.length = 0;
  const annRes = await adminService.sendBotAnnouncement({
    titleAm: 'አዲስ ዙር',
    titleEn: 'New Round',
    bodyAm: 'አዲስ ዙር ተጀምሯል',
    bodyEn: 'New round started',
    adminActor,
  });
  assert.equal(annRes.ok, true);
  assert.ok(outboxCalls.some((c) => c.chat_id === 111 && c.text.includes('አዲስ ዙር ተጀምሯል')));
});
