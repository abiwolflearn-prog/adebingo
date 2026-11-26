import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTelegramAuthHandler,
  createTelegramRouterHandler,
  createTelegramWebhookHandler,
} from './telegramHandler.ts';
import { createPlayerStateHandler } from './playerHandler.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import { BoundedRateLimiter } from './http.ts';
import {
  extractInitDataFromUrlHash,
  inspectTelegramLaunchContext,
} from '../../src/utils/telegram.ts';
import { TelegramMenuButtonConfigurator } from '../../src/utils/telegramMenuButton.ts';
import {
  buildBotMainMenuMarkup,
  MAIN_MENU_BUTTONS,
  SHARE_CONTACT_BUTTON_TEXT,
} from '../../src/utils/telegramBot.ts';

const TEST_BOT_TOKEN = '8123456789:AAH_TEST_TOKEN_SECRET_DO_NOT_LOG_998877';
const TEST_WEBHOOK_SECRET = 'adeybingo_webhook_secret_token_test_12345';
const CANONICAL_MINI_APP_URL = 'https://adebingo-3nta.vercel.app/';

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
        if (!store.has(path)) throw new Error(`NOT_FOUND: ${path}`);
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

function buildSignedInitData(params: {
  botToken: string;
  user: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  authDate: number;
  queryId?: string;
  startParam?: string;
}): { rawInitData: string; hash: string } {
  const entries: Record<string, string> = {
    auth_date: String(params.authDate),
    query_id: params.queryId || `AAE_${params.user.id}_${params.authDate}`,
    user: JSON.stringify(params.user),
  };
  if (params.startParam) {
    entries.start_param = params.startParam;
  }

  const dataCheckString = Object.keys(entries)
    .sort()
    .map((key) => `${key}=${entries[key]}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(params.botToken)
    .digest();

  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) {
    searchParams.set(k, v);
  }
  searchParams.set('hash', hash);
  return { rawInitData: searchParams.toString(), hash };
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }
) {
  let statusCode = 200;
  let payload: unknown = undefined;
  const headersOut: Record<string, string> = {};

  const req = {
    method: opts.method || 'POST',
    url: opts.url || '/api/telegram/auth',
    headers: {
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
    query: opts.query || {},
    body: opts.body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      headersOut[k.toLowerCase()] = v;
      return this;
    },
    json(data: unknown) {
      payload = data;
      return this;
    },
    end(data?: unknown) {
      if (data !== undefined && payload === undefined) payload = data;
      return this;
    },
  } as unknown as VercelResponse;

  await handler(req, res);
  return { statusCode, body: payload as Record<string, any>, headers: headersOut };
}

function captureConsoleLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const captured: string[] = [];

  const record = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
    );
  };
  console.info = record;
  console.warn = record;
  console.error = record;

  return fn()
    .then((result) => ({ result, logs: captured.join('\n') }))
    .finally(() => {
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
    });
}

test('Scenario 1: Opening Mini App via Telegram bot menu button configures canonical URL, extracts #tgWebAppData, and authenticates cleanly', async () => {
  const { db } = createInMemoryFirestore();
  const nowUnix = 1770000000;
  let configuredMenuUrl = '';
  let configuredMenuType = '';

  const configurator = new TelegramMenuButtonConfigurator();
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/getChatMenuButton')) {
      return new Response(JSON.stringify({ ok: true, result: { type: 'default' } }), { status: 200 });
    }
    if (url.includes('/setChatMenuButton')) {
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        menu_button?: { type?: string; web_app?: { url?: string } };
      };
      configuredMenuType = parsed.menu_button?.type || '';
      configuredMenuUrl = parsed.menu_button?.web_app?.url || '';
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  const router = createTelegramRouterHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    fetchImpl: mockFetch,
    configurator,
    autoConfigureMenuButton: true,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `mock-firebase-custom-token-${telegramUserId}`,
    }),
  });

  const { rawInitData, hash } = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5001001, first_name: 'Selam', username: 'selam_menu', language_code: 'am' },
    authDate: nowUnix - 12,
  });

  // Simulate Telegram opening the Mini App via Menu Button with URL fragment `#tgWebAppData=...`
  const menuLaunchHash = `#tgWebAppData=${encodeURIComponent(rawInitData)}&tgWebAppVersion=7.10&tgWebAppPlatform=android`;
  const extractedInitData = extractInitDataFromUrlHash(menuLaunchHash);
  assert.equal(extractedInitData, rawInitData, 'Must extract untouched signed initData from #tgWebAppData');

  const { result: res, logs } = await captureConsoleLogs(() =>
    invokeHandler(router, {
      method: 'POST',
      url: '/api/telegram/auth',
      query: { route: 'auth' },
      body: { initData: extractedInitData },
    })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(configuredMenuType, 'web_app');
  assert.equal(configuredMenuUrl, CANONICAL_MINI_APP_URL);
  assert.equal(res.body.uid, 'tg_5001001');
  assert.equal(res.body.customToken, 'mock-firebase-custom-token-5001001');
  assert.ok(typeof res.body.sessionToken === 'string' && res.body.sessionToken.length > 20);
  assert.deepEqual(res.body.authDiagnostics, {
    initDataPresent: true,
    botTokenConfigured: true,
    telegramHashValid: true,
    telegramUserIdExtracted: true,
    backendAuthSucceeded: true,
    firebaseCustomTokenMinted: true,
    phoneVerificationPending: true,
    errorCode: null,
  });

  // Ensure secrets never leak into logs or responses
  const serializedResponse = JSON.stringify(res.body);
  assert.equal(logs.includes(TEST_BOT_TOKEN), false, 'Bot token must never be logged');
  assert.equal(logs.includes(rawInitData), false, 'Raw initData must never be logged');
  assert.equal(logs.includes(hash), false, 'HMAC hash must never be logged');
  assert.equal(serializedResponse.includes(TEST_BOT_TOKEN), false, 'Bot token must never appear in response');
  assert.equal(serializedResponse.includes(hash), false, 'HMAC hash must never appear in response');
});

test('Scenario 2: Opening Mini App via bot Play button uses matching canonical URL and authenticates with same bot token', async () => {
  const { db } = createInMemoryFirestore();
  const nowUnix = 1770001000;

  // Verify verified bot Play button (both reply keyboard & inline button) points to exact canonical Mini App URL
  const markupFromBot = buildBotMainMenuMarkup('am', CANONICAL_MINI_APP_URL, true);
  assert.ok(markupFromBot.keyboard && markupFromBot.keyboard[0]);
  assert.equal(markupFromBot.keyboard[0][0].text, MAIN_MENU_BUTTONS.play);
  assert.equal(markupFromBot.keyboard[0][0].web_app?.url, CANONICAL_MINI_APP_URL);
  assert.ok(markupFromBot.inline_keyboard && markupFromBot.inline_keyboard[0]);
  assert.equal(markupFromBot.inline_keyboard[0][0].text, MAIN_MENU_BUTTONS.play);
  assert.equal(markupFromBot.inline_keyboard[0][0].web_app?.url, CANONICAL_MINI_APP_URL);

  // Also ensure the unverified menu does NOT expose a direct web_app launch button
  const unverifiedMarkup = buildBotMainMenuMarkup('am', CANONICAL_MINI_APP_URL, false);
  assert.ok(unverifiedMarkup.keyboard && unverifiedMarkup.keyboard[0]);
  assert.equal(unverifiedMarkup.keyboard[0][0].text, SHARE_CONTACT_BUTTON_TEXT);
  assert.equal(unverifiedMarkup.keyboard[0][0].request_contact, true);
  assert.equal(unverifiedMarkup.keyboard[0][0].web_app, undefined);
  assert.equal(unverifiedMarkup.inline_keyboard, undefined);

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `play-btn-token-${telegramUserId}`,
    }),
  });

  const { rawInitData } = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5002002, first_name: 'Dawit', username: 'dawit_play' },
    authDate: nowUnix - 5,
  });

  const res = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: rawInitData },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.uid, 'tg_5002002');
  assert.equal(res.body.authDiagnostics.telegramHashValid, true);
  assert.equal(res.body.authDiagnostics.backendAuthSucceeded, true);
  assert.equal(res.body.authDiagnostics.firebaseCustomTokenMinted, true);
});

test('Scenario 3: Opening website directly in Chrome without Telegram reports not_in_telegram / missing_init_data cleanly', async () => {
  const { db } = createInMemoryFirestore();
  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    limiter: new BoundedRateLimiter(),
  });

  // In Node / standard browser without Telegram WebView globals or #tgWebAppData
  assert.equal(extractInitDataFromUrlHash(''), '');
  assert.equal(extractInitDataFromUrlHash('#section=rooms'), '');
  const launchCtx = inspectTelegramLaunchContext();
  assert.equal(launchCtx.launchedInTelegram, false);
  assert.equal(launchCtx.isTelegramWebApp, false);
  assert.equal(launchCtx.initData, '');
  assert.equal(launchCtx.initDataSource, 'none');

  // Direct API probe with empty initData returns clear 400 missing_init_data + diagnostics
  const res = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: '' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'missing_init_data');
  assert.deepEqual(res.body.authDiagnostics, {
    initDataPresent: false,
    botTokenConfigured: true,
    telegramHashValid: false,
    telegramUserIdExtracted: false,
    backendAuthSucceeded: false,
    firebaseCustomTokenMinted: false,
    phoneVerificationPending: false,
    errorCode: 'missing_init_data',
  });
});

test('Scenario 4: Expired, tampered, missing-hash, or transient-failure initData payloads return specific error codes and do NOT prematurely burn replay guard on 503', async () => {
  const { db } = createInMemoryFirestore();
  const nowUnix = 1770002000;
  let shouldFailMint = true;

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => {
      if (shouldFailMint) {
        throw new Error('Permission iam.serviceAccounts.signBlob denied on resource');
      }
      return {
        uid: `tg_${telegramUserId}`,
        customToken: `recovered-token-${telegramUserId}`,
      };
    },
  });

  // 4a. Expired initData (older than 3600s)
  const expired = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5004001, first_name: 'OldSession' },
    authDate: nowUnix - 7200,
  });
  const expiredRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: expired.rawInitData },
  });
  assert.equal(expiredRes.statusCode, 401);
  assert.equal(expiredRes.body.error, 'expired_auth_date');
  assert.equal(expiredRes.body.authDiagnostics.initDataPresent, true);
  assert.equal(expiredRes.body.authDiagnostics.errorCode, 'expired_auth_date');

  // 4b. Tampered / wrong bot token signature
  const wrongToken = buildSignedInitData({
    botToken: '9999999999:AAH_WRONG_BOT_TOKEN_FOR_SIGNATURE_MISMATCH',
    user: { id: 5004002, first_name: 'Spoofed' },
    authDate: nowUnix - 10,
  });
  const tamperedRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: wrongToken.rawInitData },
  });
  assert.equal(tamperedRes.statusCode, 401);
  assert.equal(tamperedRes.body.error, 'signature_mismatch');
  assert.equal(tamperedRes.body.authDiagnostics.telegramHashValid, false);
  assert.equal(tamperedRes.body.authDiagnostics.errorCode, 'signature_mismatch');

  // 4c. Missing hash parameter
  const missingHashRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: `auth_date=${nowUnix}&user=%7B%22id%22%3A5004003%7D` },
  });
  assert.equal(missingHashRes.statusCode, 400);
  assert.equal(missingHashRes.body.error, 'missing_hash');
  assert.equal(missingHashRes.body.authDiagnostics.errorCode, 'missing_hash');

  // 4d. Transient custom-token minting failure (503) MUST NOT burn the replay guard
  const validPayload = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5004004, first_name: 'RetryPlayer' },
    authDate: nowUnix - 5,
  });

  const failedMintRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validPayload.rawInitData },
  });
  assert.equal(failedMintRes.statusCode, 503);
  assert.equal(failedMintRes.body.error, 'iam_sign_blob_permission_denied');
  assert.equal(failedMintRes.body.authDiagnostics.telegramHashValid, true);
  assert.equal(failedMintRes.body.authDiagnostics.telegramUserIdExtracted, true);
  assert.equal(failedMintRes.body.authDiagnostics.firebaseCustomTokenMinted, false);
  assert.equal(failedMintRes.body.authDiagnostics.errorCode, 'iam_sign_blob_permission_denied');

  // Now recover IAM minting and retry the EXACT same valid initData -> MUST SUCCEED (not 409!)
  shouldFailMint = false;
  const retryRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validPayload.rawInitData },
  });
  assert.equal(retryRes.statusCode, 200);
  assert.equal(retryRes.body.ok, true);
  assert.equal(retryRes.body.customToken, 'recovered-token-5004004');
  assert.equal(retryRes.body.authDiagnostics.firebaseCustomTokenMinted, true);

  // Replaying it a SECOND time AFTER success MUST still return 409 replay_detected (anti-replay intact!)
  const replayRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validPayload.rawInitData },
  });
  assert.equal(replayRes.statusCode, 409);
  assert.equal(replayRes.body.error, 'replay_detected');
  assert.equal(replayRes.body.authDiagnostics.errorCode, 'replay_detected');
});

test('Scenario 5: Valid Telegram account without shared contact authenticates BEFORE phone gate, accesses onboarding state, and is blocked from game actions', async () => {
  const { db } = createInMemoryFirestore();
  const nowUnix = Math.floor(Date.now() / 1000);

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `unverified-token-${telegramUserId}`,
    }),
  });

  const authDeps = {
    sessionSecret: TEST_BOT_TOKEN,
    async verifyIdToken() {
      throw new Error('use_session_token');
    },
    async isAdminUid(uid: string) {
      const snap = await db.collection('admins').doc(uid).get();
      return snap.exists;
    },
    async getUserDisplayName(uid: string) {
      const snap = await db.collection('users').doc(uid).get();
      return snap.exists ? String(snap.get('displayName') || '') || null : null;
    },
  };

  const playerStateHandler = createPlayerStateHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  const reserveCardHandler = createReserveCardHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  const { rawInitData } = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5005005, first_name: 'Hanna', username: 'hanna_new' },
    authDate: nowUnix - 10,
  });

  // Step 1: Telegram authentication MUST succeed even before contact sharing
  const authRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: rawInitData },
  });
  assert.equal(authRes.statusCode, 200);
  assert.equal(authRes.body.ok, true);
  assert.equal(authRes.body.profile.phoneVerified, false);
  assert.equal(authRes.body.authDiagnostics.backendAuthSucceeded, true);
  assert.equal(authRes.body.authDiagnostics.firebaseCustomTokenMinted, true);
  assert.equal(authRes.body.authDiagnostics.phoneVerificationPending, true);

  const sessionToken = authRes.body.sessionToken as string;
  assert.ok(sessionToken);

  // Step 2: Authenticated unverified user CAN fetch player state for onboarding UI without playing
  const stateRes = await invokeHandler(playerStateHandler, {
    method: 'GET',
    url: '/api/player/state',
    headers: { 'x-adey-session-token': sessionToken },
  });
  assert.equal(stateRes.statusCode, 200);
  assert.equal(stateRes.body.ok, true);
  assert.equal(stateRes.body.profile.phoneVerified, false);

  // Step 3: Attempting a game action (reserve card) MUST be blocked with 403 phone_verification_required
  const reserveRes = await invokeHandler(reserveCardHandler, {
    method: 'POST',
    url: '/api/cards/reserve',
    headers: {
      'x-adey-session-token': sessionToken,
      'x-idempotency-key': 'reserve-unverified-5005005-1',
    },
    body: { roomId: 'room-10', cardId: 12 },
  });
  assert.equal(reserveRes.statusCode, 403);
  assert.equal(reserveRes.body.error, 'phone_verification_required');
});

test('Scenario 6: Valid Telegram account with verified contact passes phone gate and keeps a valid session across screens and game actions', async () => {
  const { db } = createInMemoryFirestore();
  const nowUnix = Math.floor(Date.now() / 1000);

  // Step 1: Verify contact through the real Telegram webhook
  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    getWebhookSecret: () => TEST_WEBHOOK_SECRET,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
      })) as typeof fetch,
  });

  const webhookRes = await invokeHandler(webhookHandler, {
    method: 'POST',
    url: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
    body: {
      update_id: 9001001,
      message: {
        message_id: 55,
        date: nowUnix - 20,
        chat: { id: 5006006, type: 'private' },
        from: { id: 5006006, first_name: 'Abel', username: 'abel_verified' },
        contact: {
          phone_number: '+251911223344',
          first_name: 'Abel',
          user_id: 5006006,
        },
      },
    },
  });
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(webhookRes.body.ok, true);

  // Step 2: Open Mini App and authenticate
  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `verified-token-${telegramUserId}`,
    }),
  });

  const { rawInitData } = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5006006, first_name: 'Abel', username: 'abel_verified' },
    authDate: nowUnix - 5,
  });

  const authRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: rawInitData },
  });
  assert.equal(authRes.statusCode, 200);
  assert.equal(authRes.body.profile.phoneVerified, true);
  assert.equal(authRes.body.authDiagnostics.phoneVerificationPending, false);
  assert.equal(authRes.body.authDiagnostics.backendAuthSucceeded, true);
  assert.equal(authRes.body.authDiagnostics.firebaseCustomTokenMinted, true);

  const sessionToken = authRes.body.sessionToken as string;

  const authDeps = {
    sessionSecret: TEST_BOT_TOKEN,
    async verifyIdToken() {
      throw new Error('use_session_token');
    },
    async isAdminUid(uid: string) {
      const snap = await db.collection('admins').doc(uid).get();
      return snap.exists;
    },
    async getUserDisplayName(uid: string) {
      const snap = await db.collection('users').doc(uid).get();
      return snap.exists ? String(snap.get('displayName') || '') || null : null;
    },
  };

  // Step 3: Navigate across Mini App endpoints (player state -> rooms -> reserve card) using the same session token
  const playerStateHandler = createPlayerStateHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const roomsHandler = createRoomsHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const reserveCardHandler = createReserveCardHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  const stateRes = await invokeHandler(playerStateHandler, {
    method: 'GET',
    url: '/api/player/state',
    headers: { 'x-adey-session-token': sessionToken },
  });
  assert.equal(stateRes.statusCode, 200);
  assert.equal(stateRes.body.profile.phoneVerified, true);

  const roomsRes = await invokeHandler(roomsHandler, {
    method: 'GET',
    url: '/api/rooms',
    headers: { 'x-adey-session-token': sessionToken },
  });
  assert.equal(roomsRes.statusCode, 200);
  assert.ok(Array.isArray(roomsRes.body.rooms) && roomsRes.body.rooms.length > 0);
  const firstRoom = roomsRes.body.rooms[0] as { id?: string; roomId?: string };
  const targetRoomId = String(firstRoom.id || firstRoom.roomId);

  const reserveRes = await invokeHandler(reserveCardHandler, {
    method: 'POST',
    url: '/api/cards/reserve',
    headers: {
      'x-adey-session-token': sessionToken,
      'x-idempotency-key': 'reserve-verified-5006006-1',
    },
    body: { roomId: targetRoomId, cardId: 15 },
  });
  assert.equal(reserveRes.statusCode, 200);
  assert.equal(reserveRes.body.ok, true);
  assert.equal(reserveRes.body.cardId, 15);
});

test('Scenario 7: New player account gets 15 ETB initial balance & binding, while existing player preserves balance, language, and verification status', async () => {
  const { db, store } = createInMemoryFirestore();
  const nowUnix = 1770005000;

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `acct-token-${telegramUserId}`,
    }),
  });

  // 7a. Brand new player account
  const newPlayerPayload = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5007001, first_name: 'Mekdes', last_name: 'Tadesse', username: 'mekdes_new' },
    authDate: nowUnix - 10,
  });

  const newRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: newPlayerPayload.rawInitData },
  });
  assert.equal(newRes.statusCode, 200);
  assert.equal(newRes.body.uid, 'tg_5007001');
  assert.equal(newRes.body.profile.demoBalanceEtb, 15);
  assert.equal(newRes.body.profile.phoneVerified, false);
  assert.equal(newRes.body.profile.referralCode, 'ADEY-5007001');
  assert.equal(newRes.body.profile.language, 'am');

  // 7b. Existing player with prior balance (240 ETB), English language, and verified phone
  store.set('users/tg_5007002', {
    uid: 'tg_5007002',
    telegramUserId: 5007002,
    firstName: 'Yonas',
    lastName: 'Bekele',
    username: 'yonas_existing',
    language: 'en',
    demoBalanceEtb: 240,
    winningsBalanceEtb: 80,
    gamesPlayed: 9,
    gamesWon: 2,
    referralCode: 'ADEY-5007002',
    phoneVerified: true,
    phoneNumberMasked: '+251***5566',
    registeredAt: '2026-01-01T00:00:00.000Z',
  });
  store.set('telegramBindings/5007002', {
    telegramUserId: 5007002,
    uid: 'tg_5007002',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const existingPayload = buildSignedInitData({
    botToken: TEST_BOT_TOKEN,
    user: { id: 5007002, first_name: 'Yonas', last_name: 'Bekele', username: 'yonas_existing' },
    authDate: nowUnix - 8,
  });

  const existingRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: existingPayload.rawInitData },
  });
  assert.equal(existingRes.statusCode, 200);
  assert.equal(existingRes.body.uid, 'tg_5007002');
  assert.equal(existingRes.body.profile.demoBalanceEtb, 240);
  assert.equal(existingRes.body.profile.language, 'en');
  assert.equal(existingRes.body.profile.phoneVerified, true);
  assert.equal(existingRes.body.authDiagnostics.phoneVerificationPending, false);
});
