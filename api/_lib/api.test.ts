import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import { BoundedRateLimiter } from './http.ts';
import { createStatusHandler } from '../backend/status.ts';
import {
  createBotCommandHandler,
  createBotStateHandler,
  createNotifyHandler,
  createRegisterWebhookHandler,
  createTelegramAuthHandler,
  createTelegramRouterHandler,
  createTelegramWebhookHandler,
  createValidateInitDataHandler,
  createWebhookInfoHandler,
} from './telegramHandler.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import {
  createDrawBallHandler,
  createGameRouterHandler,
  createResetRoundHandler,
  createStartGameHandler,
  createVerifyWinnerHandler,
} from './gameHandler.ts';
import {
  createPlayerRouterHandler,
  createPlayerStateHandler,
  createPlayerWalletHandler,
} from './playerHandler.ts';
import {
  createAdminBotAnnounceHandler,
  createAdminBotConfigHandler,
  createAdminDepositReviewHandler,
  createAdminDepositsHandler,
  createAdminNotificationsHandler,
  createAdminNotificationsSendHandler,
  createAdminOverviewHandler,
  createAdminPayoutReviewHandler,
  createAdminPayoutsHandler,
  createAdminReferralsHandler,
  createAdminRoomUpdateHandler,
  createAdminRoomsHandler,
  createAdminRouterHandler,
  createAdminSessionExchangeHandler,
  createAdminSettingsHandler,
  createAdminUserStatusHandler,
  createAdminUsersHandler,
} from './adminHandler.ts';
import { checkCardWin, generateDeterministicCard } from '../../src/game/rules.ts';

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
              throw new Error(
                'Firestore transactions require all reads to be executed before all writes.'
              );
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
        for (const write of pendingWrites) write();
        return result;
      });
      txQueue = run.catch(() => undefined);
      return await run;
    },
  };

  return {
    db: fakeFirestore as unknown as Firestore,
    store,
  };
}

function buildSignedInitData(
  botToken: string,
  authDate: number,
  userObj: Record<string, unknown> = {
    id: 778899,
    first_name: 'Selam',
    last_name: 'Tadesse',
    username: 'selam_addis',
    language_code: 'am',
  }
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc');
  params.set('user', JSON.stringify(userObj));

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    entries.push([key, value]);
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string | string[]>;
    ip?: string;
  } = {}
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  if (
    options.body !== undefined &&
    headers['content-type'] === undefined &&
    typeof options.body === 'object'
  ) {
    headers['content-type'] = 'application/json';
  }
  if (!headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = options.ip || '198.51.100.10';
  }

  let statusCode = 200;
  const respHeaders: Record<string, string> = {};
  let jsonBody: Record<string, unknown> = {};

  const invokeOptions = options as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string | string[]>;
    ip?: string;
  };

  const req = {
    url: invokeOptions.url || '/',
    method: invokeOptions.method || 'GET',
    headers,
    body: invokeOptions.body,
    query: invokeOptions.query || {},
    socket: { remoteAddress: invokeOptions.ip || '198.51.100.10' },
  } as unknown as VercelRequest;

  const res = {
    setHeader(name: string, val: string) {
      respHeaders[name.toLowerCase()] = String(val);
    },
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
  return { statusCode, headers: respHeaders, body: jsonBody };
}

function createMockAuthDeps(tokenMap: Record<string, DecodedIdTokenLike>, adminUids: string[] = []): AuthBackendDeps {
  const adminSet = new Set(adminUids);
  return {
    async verifyIdToken(idToken: string): Promise<DecodedIdTokenLike> {
      const found = tokenMap[idToken];
      if (!found) {
        throw new Error('Invalid or expired token');
      }
      return found;
    },
    async isAdminUid(uid: string): Promise<boolean> {
      return adminSet.has(uid);
    },
    async getUserDisplayName(uid: string): Promise<string | null> {
      return `Player ${uid}`;
    },
  };
}

test('Telegram auth & initData validation reject invalid, expired, replayed, and override payloads while minting canonical tg_<id> tokens', async () => {
  const { db, store } = createStrictInMemoryFirestore();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const nowUnix = 1_760_000_000;

  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_token_for_tg_${telegramUserId}`,
    }),
  });

  // Wrong HTTP method -> 405
  const methodErr = await invokeHandler(authHandler, { method: 'GET' });
  assert.equal(methodErr.statusCode, 405);

  // Missing initData -> 400
  const missingErr = await invokeHandler(authHandler, { method: 'POST', body: {} });
  assert.equal(missingErr.statusCode, 400);
  assert.equal(missingErr.body.reason, 'missing_init_data');

  // Tampered initData -> 401
  const validInit = buildSignedInitData(botToken, nowUnix - 10, {
    id: 778899,
    first_name: 'Selam',
    last_name: 'Tadesse',
    username: 'selam_addis',
    language_code: 'am',
  });
  const tamperedInit = validInit.replace('Selam', 'Hacker');
  const tamperedRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: tamperedInit },
  });
  assert.equal(tamperedRes.statusCode, 401);
  assert.equal(tamperedRes.body.reason, 'signature_mismatch');

  // Expired initData -> 401
  const expiredInit = buildSignedInitData(botToken, nowUnix - 7200);
  const expiredRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: expiredInit },
  });
  assert.equal(expiredRes.statusCode, 401);
  assert.equal(expiredRes.body.reason, 'expired_auth_date');

  // Caller-supplied uid/telegramUserId override -> 400 rejected
  const overrideAttempt = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit, firebaseUid: 'tg_999999', telegramUserId: 999999 },
  });
  assert.equal(overrideAttempt.statusCode, 400);
  assert.equal(overrideAttempt.body.reason, 'client_identity_override_rejected');

  // Valid initData -> 200 with canonical tg_<id>, verifiedTelegramId, and Firebase customToken
  const okRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.uid, 'tg_778899');
  assert.equal(okRes.body.verifiedTelegramId, 778899);
  assert.equal(okRes.body.customToken, 'custom_token_for_tg_778899');
  assert.equal(store.get('telegramBindings/tg_778899')?.uid, 'tg_778899');
  assert.equal(store.get('users/tg_778899')?.demoBalanceEtb, 15);
  assert.equal(okRes.body.isAdmin, false);
  assert.equal(okRes.body.role, 'player');

  // Replayed initData -> 409 Conflict
  const replayRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit },
  });
  assert.equal(replayRes.statusCode, 409);
  assert.equal(replayRes.body.reason, 'replay_detected');

  // Validate-init-data endpoint also enforces persistent replay & rejects actionNonce / telegramId override
  const validateHandler = createValidateInitDataHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
  });
  const nonceBypass = await invokeHandler(validateHandler, {
    method: 'POST',
    body: { initData: validInit, actionNonce: 'bypass-attempt' },
  });
  assert.equal(nonceBypass.statusCode, 400);
  assert.equal(nonceBypass.body.reason, 'client_identity_override_rejected');

  const tgIdBypass = await invokeHandler(validateHandler, {
    method: 'POST',
    body: { initData: validInit, telegramId: 999999 },
  });
  assert.equal(tgIdBypass.statusCode, 400);
  assert.equal(tgIdBypass.body.reason, 'client_identity_override_rejected');

  const secondInit = buildSignedInitData(botToken, nowUnix - 5, {
    id: 554433,
    first_name: 'Dawit',
  });
  const valOk = await invokeHandler(validateHandler, {
    method: 'POST',
    body: { initData: secondInit },
  });
  assert.equal(valOk.statusCode, 200);
  assert.equal(valOk.body.verified, true);
  assert.equal(valOk.body.verifiedTelegramId, 554433);
  const valReplay = await invokeHandler(validateHandler, {
    method: 'POST',
    body: { initData: secondInit },
  });
  assert.equal(valReplay.statusCode, 409);
  assert.equal(valReplay.body.reason, 'replay_detected');

  // Missing or placeholder bot token -> 503 missing_bot_token (never 401 signature_mismatch)
  const unconfiguredAuthHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => 'MY_TELEGRAM_BOT_TOKEN',
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
  });
  const missingTokenRes = await invokeHandler(unconfiguredAuthHandler, {
    method: 'POST',
    body: { initData: validInit },
  });
  assert.equal(missingTokenRes.statusCode, 503);
  assert.equal(missingTokenRes.body.reason, 'missing_bot_token');
  assert.equal(
    (missingTokenRes.body.diagnostics as { failureCategory?: string } | undefined)?.failureCategory,
    'backend_environment_configuration'
  );

  // Missing hash -> 400 missing_hash with safe diagnostics
  const missingHashInit = validInit.replace(/&hash=[0-9a-f]+/i, '');
  const missingHashRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: missingHashInit },
  });
  assert.equal(missingHashRes.statusCode, 400);
  assert.equal(missingHashRes.body.reason, 'missing_hash');

  // Malformed query string -> 400 malformed_init_data
  const malformedRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: 'not_a_query_string' },
  });
  assert.equal(malformedRes.statusCode, 400);
  assert.equal(malformedRes.body.reason, 'malformed_init_data');

  // Non-string initData or initDataUnsafe override rejected -> 400
  const nonStringRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: { user: { id: 778899 } } },
  });
  assert.equal(nonStringRes.statusCode, 400);
  assert.equal(nonStringRes.body.reason, 'malformed_init_data');

  const unsafeOverrideRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit, initDataUnsafe: { user: { id: 778899 } } },
  });
  assert.equal(unsafeOverrideRes.statusCode, 400);
  assert.equal(unsafeOverrideRes.body.reason, 'client_identity_override_rejected');
});

test('Telegram webhook & secret-protected endpoints enforce fail-closed secret, replay protection, private chat rules, and no firebaseUid overrides', async () => {
  const { db, store } = createStrictInMemoryFirestore();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const webhookSecret = 'super-secret-webhook-token-2026';
  let telegramSendCalls = 0;

  const mockFetch: typeof fetch = async () => {
    telegramSendCalls += 1;
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    } as unknown as Response;
  };

  // Missing server secret -> fail-closed 503 (never fail-open!)
  const unconfiguredWebhook = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => '',
    isAdminReady: () => true,
    limiter: new BoundedRateLimiter(),
  });
  const missingServerSecretRes = await invokeHandler(unconfiguredWebhook, {
    method: 'POST',
    body: { update_id: 1, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/start' } },
  });
  assert.equal(missingServerSecretRes.statusCode, 503);
  assert.equal(missingServerSecretRes.body.reason, 'missing_webhook_secret');

  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    fetchImpl: mockFetch,
    nowUnixSeconds: () => 1_760_000_000,
    limiter: new BoundedRateLimiter(),
  });

  // Missing header -> 401
  const noSecretHeader = await invokeHandler(webhookHandler, {
    method: 'POST',
    body: { update_id: 100 },
  });
  assert.equal(noSecretHeader.statusCode, 401);
  assert.equal(noSecretHeader.body.reason, 'invalid_webhook_secret_token');

  // Wrong header -> 401
  const wrongSecretHeader = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    body: { update_id: 100 },
  });
  assert.equal(wrongSecretHeader.statusCode, 401);

  // Arbitrary firebaseUid rejected -> 400
  const spoofedUid = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 101,
      firebaseUid: 'victim_uid',
      message: { from: { id: 778899 }, chat: { id: 778899, type: 'private' }, text: '/start' },
    },
  });
  assert.equal(spoofedUid.statusCode, 400);
  assert.equal(spoofedUid.body.reason, 'client_identity_override_rejected');

  // Group chat /start blocked -> 403 private_chat_required
  const groupStart = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 102,
      message: { from: { id: 778899 }, chat: { id: -10012345, type: 'group' }, text: '/start' },
    },
  });
  assert.equal(groupStart.statusCode, 403);
  assert.equal(groupStart.body.reason, 'private_chat_required');

  // Valid private /start -> 200 and persisted
  const validStart = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 103,
      message: {
        from: { id: 778899, first_name: 'Selam', username: 'selam_addis' },
        chat: { id: 778899, type: 'private' },
        text: '/start',
      },
    },
  });
  assert.equal(validStart.statusCode, 200);
  assert.equal(validStart.body.ok, true);
  assert.equal(telegramSendCalls, 1);
  assert.equal(store.get('telegramBindings/tg_778899')?.uid, 'tg_778899');

  // Duplicate webhook update_id -> 409 and does NOT call Telegram API again
  const duplicateUpdate = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 103,
      message: {
        from: { id: 778899, first_name: 'Selam' },
        chat: { id: 778899, type: 'private' },
        text: '/start',
      },
    },
  });
  assert.equal(duplicateUpdate.statusCode, 409);
  assert.equal(duplicateUpdate.body.reason, 'replay_detected');
  assert.equal(telegramSendCalls, 1);

  // Other secret-protected endpoints reject missing/bad secret
  const infoHandler = createWebhookInfoHandler({
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    limiter: new BoundedRateLimiter(),
  });
  const badInfo = await invokeHandler(infoHandler, { method: 'GET' });
  assert.equal(badInfo.statusCode, 401);

  const registerHandler = createRegisterWebhookHandler({
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    limiter: new BoundedRateLimiter(),
  });
  const badRegister = await invokeHandler(registerHandler, { method: 'POST', body: {} });
  assert.equal(badRegister.statusCode, 401);

  const botStateHandler = createBotStateHandler({
    getDb: () => db,
    getWebhookSecret: () => webhookSecret,
    limiter: new BoundedRateLimiter(),
  });
  const badBotState = await invokeHandler(botStateHandler, {
    method: 'GET',
    query: { telegramUserId: '778899' },
  });
  assert.equal(badBotState.statusCode, 401);
});

test('Game & room API endpoints enforce authentication, host/admin authorization, override protection, card limits, balance, idempotency, state transitions, and winner crediting', async () => {
  const { db, store } = createStrictInMemoryFirestore();

  const authDeps = createMockAuthDeps(
    {
      'tok-admin': {
        uid: 'admin_1',
        email: 'abelbimrew868@gmail.com',
        email_verified: true,
        name: 'Admin Abebe',
      },
      'tok-host': {
        uid: 'tg_1001',
        telegram_verified: true,
        telegram_id: 1001,
        name: 'Dawit Host',
      },
      'tok-player2': {
        uid: 'tg_2002',
        telegram_verified: true,
        telegram_id: 2002,
        name: 'Marta Player',
      },
      'tok-player3': {
        uid: 'tg_3003',
        telegram_verified: true,
        telegram_id: 3003,
        name: 'Kaleb Player',
      },
      'tok-broke': {
        uid: 'tg_4004',
        telegram_verified: true,
        telegram_id: 4004,
        name: 'Broke Player',
      },
      'tok-ghost': {
        uid: 'tg_5005',
        telegram_verified: true,
        telegram_id: 5005,
        name: 'Ghost Winner',
      },
      'tok-unverified': {
        uid: 'unverified_99',
        email: 'unverified@example.com',
        email_verified: false,
      },
    },
    ['admin_1']
  );

  // Seed user profiles (notice tg_5005 intentionally omitted to test missing winner profile!)
  for (const [uid, bal] of [
    ['tg_1001', 250],
    ['tg_2002', 250],
    ['tg_3003', 250],
    ['tg_4004', 5],
  ] as const) {
    store.set(`users/${uid}`, {
      uid,
      telegramUserId: uid,
      displayName: `Player ${uid}`,
      username: `@${uid}`,
      language: 'am',
      phoneVerified: true,
      demoBalanceEtb: bal,
    });
  }

  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const startHandler = createStartGameHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const drawHandler = createDrawBallHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const resetHandler = createResetRoundHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const verifyHandler = createVerifyWinnerHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const botCmdHandler = createBotCommandHandler({ getDb: () => db, authDeps, limiter: new BoundedRateLimiter() });
  const notifyHandler = createNotifyHandler({
    getDb: () => db,
    getWebhookSecret: () => 'webhook-secret-12345',
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const statusHandler = createStatusHandler({ limiter: new BoundedRateLimiter() });

  // Status endpoint works without leaking secrets
  const statusRes = await invokeHandler(statusHandler, { method: 'GET' });
  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.body.mode, 'demo_sandbox');
  assert.equal('FIREBASE_SERVICE_ACCOUNT_KEY' in statusRes.body, false);

  // 1. Unauthenticated & unverified requests rejected across protected endpoints
  for (const h of [roomsHandler, reserveHandler, startHandler, drawHandler, resetHandler, verifyHandler, botCmdHandler, notifyHandler]) {
    const unauth = await invokeHandler(h, {
      method: h === roomsHandler ? 'GET' : 'POST',
      body: h === roomsHandler ? undefined : {},
    });
    assert.equal(unauth.statusCode, 401);
  }
  const unverifiedCall = await invokeHandler(roomsHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-unverified' },
  });
  assert.equal(unverifiedCall.statusCode, 403);
  assert.equal(unverifiedCall.body.reason, 'unverified_identity');

  // Bot command rejects spoofed senderTelegramId
  const spoofBotCmd = await invokeHandler(botCmdHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { senderTelegramId: 1001, text: '/help' },
  });
  assert.equal(spoofBotCmd.statusCode, 403);
  assert.equal(spoofBotCmd.body.reason, 'client_identity_override_rejected');

  // 2. Non-admin cannot create room; Admin creates room hosted by tg_1001
  const nonAdminCreate = await invokeHandler(roomsHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', nameAm: 'ቪአይፒ', nameEn: 'VIP Room', cardPrice: 10 },
  });
  assert.equal(nonAdminCreate.statusCode, 403);
  assert.equal(nonAdminCreate.body.reason, 'admin_required');

  const adminCreate = await invokeHandler(roomsHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    body: {
      roomId: 'vip-room',
      nameAm: 'ቪአይፒ ክፍል',
      nameEn: 'VIP Hall',
      cardPrice: 10,
      hostUid: 'tg_1001',
    },
  });
  assert.equal(adminCreate.statusCode, 201);

  const listRoomsRes = await invokeHandler(roomsHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-player2' },
  });
  assert.equal(listRoomsRes.statusCode, 200);
  assert.ok(Array.isArray(listRoomsRes.body.rooms));
  assert.ok((listRoomsRes.body.rooms as Array<{ roomId: string }>).some((r) => r.roomId === 'vip-room'));

  // 3. Attempts to manipulate playerUid / demoBalanceEtb on card reserve rejected -> 403
  const spoofReserve = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', cardId: 11, playerUid: 'tg_1001', demoBalanceEtb: 99999 },
  });
  assert.equal(spoofReserve.statusCode, 403);
  assert.equal(spoofReserve.body.reason, 'client_override_rejected');

  // Insufficient balance rejected -> 400
  const brokeReserve = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-broke' },
    body: { roomId: 'vip-room', cardId: 20, action: 'reserve' },
  });
  assert.equal(brokeReserve.statusCode, 400);
  assert.equal(brokeReserve.body.reason, 'insufficient_balance');
  assert.equal(store.get('users/tg_4004')?.demoBalanceEtb, 5);

  // Duplicate reservation with same idempotency key -> 409 & charged only once
  const res1 = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-player2',
      'x-idempotency-key': 'idem-card-11',
    },
    body: { roomId: 'vip-room', cardId: 11, action: 'reserve' },
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.updatedBalanceEtb, 240);

  const res1Dup = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-player2',
      'x-idempotency-key': 'idem-card-11',
    },
    body: { roomId: 'vip-room', cardId: 11, action: 'reserve' },
  });
  assert.equal(res1Dup.statusCode, 409);
  assert.equal(res1Dup.body.reason, 'duplicate_request');
  assert.equal(store.get('users/tg_2002')?.demoBalanceEtb, 240);

  // Duplicate reserve without idempotency key (action: 'reserve') does NOT release or charge
  const res1DupAction = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', cardId: 11, action: 'reserve' },
  });
  assert.equal(res1DupAction.statusCode, 409);
  assert.equal(res1DupAction.body.reason, 'card_already_reserved');
  assert.equal(store.get('users/tg_2002')?.demoBalanceEtb, 240);

  // Reserve 3 more cards for tg_2002 (total 4) and reject 5th card -> 409 max_4_cards_reached
  for (const cid of [12, 13, 14]) {
    const r = await invokeHandler(reserveHandler, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-player2' },
      body: { roomId: 'vip-room', cardId: cid, action: 'reserve' },
    });
    assert.equal(r.statusCode, 200);
  }
  const fifthCard = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', cardId: 15, action: 'reserve' },
  });
  assert.equal(fifthCard.statusCode, 409);
  assert.equal(fifthCard.body.reason, 'max_4_cards_reached');

  // Cannot start game when fewer than 3 active players -> 409 eligibility_not_met
  const prematureStart = await invokeHandler(startHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(prematureStart.statusCode, 409);
  assert.equal(prematureStart.body.reason, 'eligibility_not_met');

  // Two more players join (tg_1001 and tg_3003) -> total 3 active players
  const hostJoin = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room', cardId: 21, action: 'reserve' },
  });
  assert.equal(hostJoin.statusCode, 200);

  const p3Join = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player3' },
    body: { roomId: 'vip-room', cardId: 22, action: 'reserve' },
  });
  assert.equal(p3Join.statusCode, 200);

  // Non-host player cannot start game -> 403 unauthorized_caller
  const nonHostStart = await invokeHandler(startHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(nonHostStart.statusCode, 403);
  assert.equal(nonHostStart.body.reason, 'unauthorized_caller');

  // Host starts game -> 200 live with 1 CSPRNG ball
  const startOk = await invokeHandler(startHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(startOk.statusCode, 200);
  assert.equal(store.get('rooms/vip-room')?.status, 'live');

  // Starting an already live game -> 409 game_already_live
  const startAgain = await invokeHandler(startHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(startAgain.statusCode, 409);
  assert.equal(startAgain.body.reason, 'game_already_live');

  // Reserving card while room is live -> 409 room_already_live
  const reserveWhileLive = await invokeHandler(reserveHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player3' },
    body: { roomId: 'vip-room', cardId: 25, action: 'reserve' },
  });
  assert.equal(reserveWhileLive.statusCode, 409);
  assert.equal(reserveWhileLive.body.reason, 'room_already_live');

  // Non-host trying to draw ball or spoof hostUid -> 403
  const nonHostDraw = await invokeHandler(drawHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(nonHostDraw.statusCode, 403);
  assert.equal(nonHostDraw.body.reason, 'unauthorized_caller');

  const spoofHostDraw = await invokeHandler(drawHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', hostUid: 'tg_2002' },
  });
  assert.equal(spoofHostDraw.statusCode, 403);
  assert.equal(spoofHostDraw.body.reason, 'client_override_rejected');

  // Duplicate draw nonce -> 409 replay_detected
  const draw1 = await invokeHandler(drawHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-host',
      'x-idempotency-key': 'draw-vip-1',
    },
    body: { roomId: 'vip-room' },
  });
  assert.equal(draw1.statusCode, 200);

  const draw1Dup = await invokeHandler(drawHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-host',
      'x-idempotency-key': 'draw-vip-1',
    },
    body: { roomId: 'vip-room' },
  });
  assert.equal(draw1Dup.statusCode, 409);
  assert.equal(draw1Dup.body.reason, 'replay_detected');

  // Forged calledNumbers & forged prize in verify-winner:
  // 1) Spoofed prize/winnerUid -> 403 client_override_rejected
  const spoofPrizeClaim = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: {
      roomId: 'vip-room',
      cardId: 11,
      markedNumbers: [1, 2, 3, 4],
      demoPrizeEtb: 99999,
      winnerUid: 'tg_2002',
    },
  });
  assert.equal(spoofPrizeClaim.statusCode, 403);
  assert.equal(spoofPrizeClaim.body.reason, 'client_override_rejected');

  // 2) Client sends fake calledNumbers matching card 11 top row before they are actually drawn -> 400 pattern_not_satisfied
  const card11TopRow = generateDeterministicCard(11).grid[0].filter((n) => n !== 0);
  const forgedCallsClaim = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: {
      roomId: 'vip-room',
      cardId: 11,
      calledNumbers: card11TopRow,
      markedNumbers: card11TopRow,
    },
  });
  assert.equal(forgedCallsClaim.statusCode, 400);
  assert.equal(forgedCallsClaim.body.reason, 'pattern_not_satisfied');

  // Draw remaining balls so all 75 are called
  let totalCalled = Number(draw1.body.totalCalled);
  while (totalCalled < 75) {
    const d = await invokeHandler(drawHandler, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-host' },
      body: { roomId: 'vip-room' },
    });
    assert.equal(d.statusCode, 200);
    totalCalled = Number(d.body.totalCalled);
  }

  // Missing winner user profile (tg_5005) -> 404 winner_profile_not_found WITHOUT completing game
  store.set('rooms/vip-room/players/tg_5005', {
    playerId: 'tg_5005',
    roomId: 'vip-room',
    displayName: 'Ghost',
    telegramUserId: 'tg_5005',
    cardIds: [19],
  });
  store.set('rooms/vip-room/cards/19', {
    cardId: 19,
    roomId: 'vip-room',
    ownerId: 'tg_5005',
    ownerName: 'Ghost',
    serial: 'ADB-019',
  });
  const card19TopRow = generateDeterministicCard(19).grid[0].filter((n) => n !== 0);
  const missingProfileClaim = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-ghost' },
    body: { roomId: 'vip-room', cardId: 19, markedNumbers: card19TopRow },
  });
  assert.equal(missingProfileClaim.statusCode, 404);
  assert.equal(missingProfileClaim.body.reason, 'winner_profile_not_found');
  assert.equal(store.get('games/game_vip-room_live')?.status, 'live');

  // Legitimate winner claim by tg_2002 on card 11 -> 200, credits balance once
  const balBeforeWin = Number(store.get('users/tg_2002')?.demoBalanceEtb);
  assert.equal(checkCardWin(generateDeterministicCard(11), card11TopRow, store.get('games/game_vip-room_live')?.calledNumbers as number[], true).won, true);

  const validWin = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-player2',
      'x-idempotency-key': 'win-vip-r1',
    },
    body: { roomId: 'vip-room', cardId: 11, markedNumbers: card11TopRow },
  });
  assert.equal(validWin.statusCode, 200);
  assert.equal(validWin.body.verified, true);
  const prize = Number(validWin.body.demoPrizeEtb);
  // Strict 80% prize pool cap: 3 confirmed players * 10 ETB = 30 ETB collected -> 80% = 24 ETB (never exceeds prize pool)
  assert.equal(prize, 24);
  assert.equal(store.get('users/tg_2002')?.demoBalanceEtb, balBeforeWin + prize);
  assert.equal(store.get('games/game_vip-room_live')?.status, 'completed');

  // Duplicate payout attempts (with same key OR different key on completed game) -> 409, no double credit
  const dupWinSameKey = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok-player2',
      'x-idempotency-key': 'win-vip-r1',
    },
    body: { roomId: 'vip-room', cardId: 11, markedNumbers: card11TopRow },
  });
  assert.equal(dupWinSameKey.statusCode, 409);
  assert.equal(store.get('users/tg_2002')?.demoBalanceEtb, balBeforeWin + prize);

  const dupWinNewKey = await invokeHandler(verifyHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room', cardId: 11, markedNumbers: card11TopRow },
  });
  assert.equal(dupWinNewKey.statusCode, 409);
  assert.equal(dupWinNewKey.body.reason, 'game_already_completed');
  assert.equal(store.get('users/tg_2002')?.demoBalanceEtb, balBeforeWin + prize);

  // Drawing on completed game -> 409 game_already_completed
  const drawAfterWin = await invokeHandler(drawHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(drawAfterWin.statusCode, 409);
  assert.equal(drawAfterWin.body.reason, 'game_already_completed');

  // Non-host cannot reset round -> 403; Host resets round -> 200 countdown round 2
  const nonHostReset = await invokeHandler(resetHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-player2' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(nonHostReset.statusCode, 403);

  const hostReset = await invokeHandler(resetHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-host' },
    body: { roomId: 'vip-room' },
  });
  assert.equal(hostReset.statusCode, 200);
  assert.equal(store.get('games/game_vip-room_live')?.roundNumber, 2);
  assert.equal(store.get('rooms/vip-room')?.status, 'countdown');
});

test('API handlers enforce Content-Type, payload limits, malformed JSON rejection, and rate limiting', async () => {
  const limiter = new BoundedRateLimiter();
  const statusHandler = createStatusHandler({ limiter });
  const validateHandler = createValidateInitDataHandler({
    getBotToken: () => '123456:TEST_ADEYBINGO_BOT_TOKEN',
    limiter: new BoundedRateLimiter(),
  });

  // Unsupported media type -> 415
  const badCt = await invokeHandler(validateHandler, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"initData":"abc"}',
  });
  assert.equal(badCt.statusCode, 415);

  // Malformed JSON -> 400
  const badJson = await invokeHandler(validateHandler, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-valid-json',
  });
  assert.equal(badJson.statusCode, 400);

  // Oversized payload -> 413
  const bigBody = { initData: 'x'.repeat(20 * 1024) };
  const bigRes = await invokeHandler(validateHandler, {
    method: 'POST',
    body: bigBody,
  });
  assert.equal(bigRes.statusCode, 413);

  // Rate limiting triggers 429 with Retry-After after 60 requests
  for (let i = 0; i < 60; i++) {
    const ok = await invokeHandler(statusHandler, { method: 'GET', ip: '203.0.113.5' });
    assert.equal(ok.statusCode, 200);
  }
  const throttled = await invokeHandler(statusHandler, { method: 'GET', ip: '203.0.113.5' });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.body.reason, 'rate_limit_exceeded');
  assert.ok(Number(throttled.headers['retry-after']) >= 1);
});

test('Milestone 4.2: Admin Serverless API blocks preset identityMode bypass (403), enforces 401/403/200 RBAC, executes transactional deposit credits & payout refunds, chains SHA-256 audit logs, and processes Telegram callbacks with replay protection', async () => {
  const { db, store } = createStrictInMemoryFirestore();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const sessionSecret = 'test_milestone_4_2_session_secret';
  const webhookSecret = 'webhook_secret_m42';
  const nowUnix = Math.floor(Date.now() / 1000);

  const authDeps: AuthBackendDeps = {
    ...createMockAuthDeps(
      {
        'tok-admin-fb': {
          uid: 'tg_8842109',
          email: 'abelbimrew868@gmail.com',
          email_verified: true,
          name: 'Abebe Bikila (Lead Admin)',
        },
        'tok-player-fb': {
          uid: 'tg_7777777',
          telegram_verified: true,
          telegram_id: 7777777,
          name: 'Dawit Mekonnen',
        },
      },
      ['tg_8842109']
    ),
    getSessionSecret: () => sessionSecret,
  };

  // Explicitly seed test fixtures (production ensureSeedData does not create fake users/payments)
  store.set('users/tg_8842109', {
    uid: 'tg_8842109',
    telegramUserId: 'tg_8842109',
    displayName: 'Abebe Bikila',
    username: '@abebe_adey',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 450,
    accountStatus: 'active',
  });
  store.set('users/tg_7777777', {
    uid: 'tg_7777777',
    telegramUserId: 'tg_7777777',
    displayName: 'Dawit Mekonnen',
    username: '@dawit_m',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 185,
    accountStatus: 'active',
  });
  store.set('depositRequests/DEP-2026-401', {
    id: 'DEP-2026-401',
    uid: 'tg_7777777',
    telegramUserId: 7777777,
    playerName: 'Dawit Mekonnen',
    method: 'Telebirr',
    amountEtb: 100,
    referenceCode: 'TB-TEST-401',
    status: 'Pending',
    demoSandboxOnly: true,
    createdAt: new Date(nowUnix * 1000).toISOString(),
  });
  store.set('payoutRequests/PO-2026-901', {
    id: 'PO-2026-901',
    uid: 'tg_7777777',
    telegramUserId: 7777777,
    playerName: 'Dawit Mekonnen',
    method: 'Telebirr',
    accountMask: '+251 9•• ••• 210',
    requestedAmountEtb: 75,
    status: 'Pending',
    demoSandboxOnly: true,
    requestedAt: new Date(nowUnix * 1000).toISOString(),
  });

  const sharedDeps = {
    getDb: () => db,
    getBotToken: () => botToken,
    authDeps,
    limiter: new BoundedRateLimiter(),
  };

  const sessionExchangeHandler = createAdminSessionExchangeHandler(sharedDeps);
  const overviewHandler = createAdminOverviewHandler(sharedDeps);
  const usersHandler = createAdminUsersHandler(sharedDeps);
  const userStatusHandler = createAdminUserStatusHandler(sharedDeps);
  const depositsHandler = createAdminDepositsHandler(sharedDeps);
  const depositReviewHandler = createAdminDepositReviewHandler(sharedDeps);
  const payoutsHandler = createAdminPayoutsHandler(sharedDeps);
  const payoutReviewHandler = createAdminPayoutReviewHandler(sharedDeps);
  const roomsAdminHandler = createAdminRoomsHandler(sharedDeps);
  const roomUpdateHandler = createAdminRoomUpdateHandler(sharedDeps);
  const referralsHandler = createAdminReferralsHandler(sharedDeps);
  const botConfigHandler = createAdminBotConfigHandler(sharedDeps);
  const botAnnounceHandler = createAdminBotAnnounceHandler(sharedDeps);
  const notificationsHandler = createAdminNotificationsHandler(sharedDeps);
  const notificationSendHandler = createAdminNotificationsSendHandler(sharedDeps);
  const settingsHandler = createAdminSettingsHandler(sharedDeps);

  // 1. Unauthenticated access to /api/admin/overview -> 401
  const unauthOverview = await invokeHandler(overviewHandler, { method: 'GET' });
  assert.equal(unauthOverview.statusCode, 401);

  // 2. Normal player access to /api/admin/overview -> 403
  const playerOverview = await invokeHandler(overviewHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-player-fb' },
  });
  assert.equal(playerOverview.statusCode, 403);
  assert.equal(playerOverview.body.reason, 'admin_required');

  // 3. Preset identityMode: "admin" request -> rejected (403)
  const presetBypass = await invokeHandler(sessionExchangeHandler, {
    method: 'POST',
    body: { identityMode: 'admin', role: 'admin' },
  });
  assert.equal(presetBypass.statusCode, 403);
  assert.equal(presetBypass.body.ok, false);
  assert.equal(presetBypass.body.reason, 'preset_identity_bypass_removed');

  // 4. Verified admin access to /api/admin/overview -> 200
  const adminOverview = await invokeHandler(overviewHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-admin-fb' },
  });
  assert.equal(adminOverview.statusCode, 200);
  assert.equal(adminOverview.body.ok, true);
  assert.ok(adminOverview.body.overview);

  // Also verify signed Telegram initData exchange for allowlisted admin TG #8842109
  const adminInitData = buildSignedInitData(botToken, nowUnix - 5, {
    id: 8842109,
    first_name: 'Abebe',
    last_name: 'Bikila',
    username: 'abebe_adey',
    language_code: 'am',
  });
  const exchangeAdminRes = await invokeHandler(sessionExchangeHandler, {
    method: 'POST',
    body: { initData: adminInitData },
  });
  assert.equal(exchangeAdminRes.statusCode, 200);
  assert.equal(exchangeAdminRes.body.authorized, true);
  const mintedAdminToken = String(exchangeAdminRes.body.token);
  assert.ok(mintedAdminToken.length > 20);

  // 5. Admin deposit approval updates user balance transactionally in Firestore
  const listDeps = await invokeHandler(depositsHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(listDeps.statusCode, 200);
  const dawitBalBeforeDep = Number(store.get('users/tg_7777777')?.demoBalanceEtb);
  assert.equal(dawitBalBeforeDep, 185);

  const approveDepRes = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { depositId: 'DEP-2026-401' },
    body: {
      nextStatus: 'Approved',
      reviewNotes: 'Approved Telebirr Demo Receipt in Milestone 4.2 test',
    },
  });
  assert.equal(approveDepRes.statusCode, 200);
  assert.equal((approveDepRes.body.deposit as { status: string }).status, 'Approved');
  assert.equal(Number(store.get('users/tg_7777777')?.demoBalanceEtb), dawitBalBeforeDep + 100);
  assert.equal(store.get('depositRequests/DEP-2026-401')?.status, 'Approved');

  // Re-reviewing an already-approved deposit is rejected (409) so balance cannot be double-credited
  const duplicateApproveDep = await invokeHandler(depositReviewHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { depositId: 'DEP-2026-401' },
    body: { nextStatus: 'Approved', reviewNotes: 'Duplicate attempt' },
  });
  assert.equal(duplicateApproveDep.statusCode, 409);
  assert.equal(Number(store.get('users/tg_7777777')?.demoBalanceEtb), dawitBalBeforeDep + 100);

  // 6. Admin payout rejection refunds user balance transactionally in Firestore
  const listPayouts = await invokeHandler(payoutsHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(listPayouts.statusCode, 200);
  const dawitBalBeforePayout = Number(store.get('users/tg_7777777')?.demoBalanceEtb);
  assert.equal(dawitBalBeforePayout, 285);

  const rejectPayoutRes = await invokeHandler(payoutReviewHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { requestId: 'PO-2026-901' },
    body: {
      nextStatus: 'Rejected',
      reviewNotes: 'Rejected in Demo Sandbox & refunded 75 ETB to player',
    },
  });
  assert.equal(rejectPayoutRes.statusCode, 200);
  assert.equal((rejectPayoutRes.body.payout as { status: string }).status, 'Rejected');
  assert.equal(Number(store.get('users/tg_7777777')?.demoBalanceEtb), dawitBalBeforePayout + 75);
  assert.equal(store.get('payoutRequests/PO-2026-901')?.status, 'Rejected');

  // Self-suspension is blocked (403) while suspending a player succeeds
  const selfSuspend = await invokeHandler(userStatusHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { uid: 'tg_8842109' },
    body: { accountStatus: 'suspended', reason: 'Attempt self-suspend' },
  });
  assert.equal(selfSuspend.statusCode, 403);
  assert.equal(selfSuspend.body.reason, 'self_suspension_forbidden');

  const suspendPlayer = await invokeHandler(userStatusHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { uid: 'tg_7777777' },
    body: { accountStatus: 'suspended', reason: 'Test suspension' },
  });
  assert.equal(suspendPlayer.statusCode, 200);
  assert.equal(store.get('users/tg_7777777')?.accountStatus, 'suspended');

  // Verify remaining admin endpoints (users, rooms, referrals, bot config, announce, notifications)
  const usersList = await invokeHandler(usersHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { q: '7777777' },
  });
  assert.equal(usersList.statusCode, 200);

  const roomsList = await invokeHandler(roomsAdminHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(roomsList.statusCode, 200);

  const roomUpd = await invokeHandler(roomUpdateHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    query: { roomId: 'adey-main' },
    body: { cardPriceEtb: 15, status: 'countdown' },
  });
  assert.equal(roomUpd.statusCode, 200);
  assert.equal(store.get('rooms/adey-main')?.cardPriceEtb, 15);

  const refList = await invokeHandler(referralsHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(refList.statusCode, 200);

  const botCfgUpd = await invokeHandler(botConfigHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    body: {
      customWelcomeAm: '🌟 አዲስ የአደይ ቢንጎ አቀባበል!',
      customWelcomeEn: '🌟 Custom ADEYBINGO Welcome!',
    },
  });
  assert.equal(botCfgUpd.statusCode, 200);
  assert.equal(store.get('botConfig/default')?.customWelcomeEn, '🌟 Custom ADEYBINGO Welcome!');

  const announceRes = await invokeHandler(botAnnounceHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    body: {
      titleAm: 'ልዩ ዙር',
      titleEn: 'Special Round',
      bodyAm: 'አሁን ይቀላቀሉ',
      bodyEn: 'Join now',
    },
  });
  assert.equal(announceRes.statusCode, 200);

  const notifList = await invokeHandler(notificationsHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(notifList.statusCode, 200);

  const notifSend = await invokeHandler(notificationSendHandler, {
    method: 'POST',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
    body: {
      telegramUserId: 7777777,
      title: 'Admin Alert',
      body: 'Hello Dawit',
    },
  });
  assert.equal(notifSend.statusCode, 200);

  // 7. Admin actions create SHA-256 chained audit logs in Firestore
  const settingsRes = await invokeHandler(settingsHandler, {
    method: 'GET',
    headers: { authorization: `Bearer ${mintedAdminToken}` },
  });
  assert.equal(settingsRes.statusCode, 200);
  const settingsObj = settingsRes.body.settings as {
    auditChainIntegrity: { valid: boolean; totalEntries: number };
  };
  assert.equal(settingsObj.auditChainIntegrity.valid, true);
  assert.ok(settingsObj.auditChainIntegrity.totalEntries >= 6);

  // 8 & 9. Telegram webhook processes cb:my_wallet (200), calls answerCallbackQuery, and rejects duplicate callback_query.id (409)
  const telegramApiCalls: string[] = [];
  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    fetchImpl: async (url) => {
      telegramApiCalls.push(String(url));
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response;
    },
  });

  const walletCallbackRes = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 9001,
      callback_query: {
        id: 'cbq_wallet_unique_1',
        from: {
          id: 7777777,
          first_name: 'Dawit',
          username: 'dawit_m',
        },
        message: {
          chat: { id: 7777777, type: 'private' },
        },
        data: 'cb:my_wallet',
      },
    },
  });
  assert.equal(walletCallbackRes.statusCode, 200);
  assert.equal(walletCallbackRes.body.ok, true);
  assert.match(String(walletCallbackRes.body.text), /360\.00 ETB/);
  assert.ok(telegramApiCalls.some((u) => u.includes('/sendMessage')));
  assert.ok(telegramApiCalls.some((u) => u.includes('/answerCallbackQuery')));

  // Duplicate callback_query.id with a new update_id is rejected with 409
  const dupCallbackRes = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 9002,
      callback_query: {
        id: 'cbq_wallet_unique_1',
        from: {
          id: 7777777,
          first_name: 'Dawit',
          username: 'dawit_m',
        },
        message: {
          chat: { id: 7777777, type: 'private' },
        },
        data: 'cb:my_wallet',
      },
    },
  });
  assert.equal(dupCallbackRes.statusCode, 409);
  assert.equal(dupCallbackRes.body.reason, 'duplicate_callback_query');
});

test('Milestone 5: /api/telegram/auth defaults new users to Amharic even when language_code is en, retains user language switch, and webhook callbackAnswerText + deposit/withdraw persistence work', async () => {
  const { db, store } = createStrictInMemoryFirestore();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const webhookSecret = 'webhook_secret_m5';
  const nowUnix = 1_760_000_000;
  const answerBodies: Array<Record<string, unknown>> = [];

  const authHandler = createTelegramAuthHandler({
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

  // 1. New user with Telegram client language_code='en' MUST default to Amharic ('am')
  const enClientInit = buildSignedInitData(botToken, nowUnix - 10, {
    id: 665544,
    first_name: 'Biniyam',
    username: 'biniyam_et',
    language_code: 'en',
  });
  const authRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: enClientInit },
  });
  assert.equal(authRes.statusCode, 200);
  assert.equal((authRes.body.profile as { language?: string }).language, 'am');
  assert.equal(store.get('users/tg_665544')?.language, 'am');

  // 2. Webhook switches language via lang:en callback and passes callbackAnswerText to answerCallbackQuery
  const webhookHandler = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/answerCallbackQuery') && typeof init?.body === 'string') {
        answerBodies.push(JSON.parse(init.body));
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response;
    },
  });

  const switchEnRes = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 9501,
      callback_query: {
        id: 'cbq_m5_lang_en',
        from: { id: 665544, first_name: 'Biniyam', username: 'biniyam_et' },
        message: { chat: { id: 665544, type: 'private' } },
        data: 'lang:en',
      },
    },
  });
  assert.equal(switchEnRes.statusCode, 200);
  assert.equal(switchEnRes.body.language, 'en');
  assert.ok(answerBodies.length === 1 && typeof answerBodies[0].text === 'string');

  // 3. Subsequent /api/telegram/auth retains saved 'en' preference
  const secondAuthInit = buildSignedInitData(botToken, nowUnix - 2, {
    id: 665544,
    first_name: 'Biniyam',
    username: 'biniyam_et',
    language_code: 'am',
  });
  const authRes2 = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: secondAuthInit },
  });
  assert.equal(authRes2.statusCode, 200);
  assert.equal((authRes2.body.profile as { language?: string }).language, 'en');

  // 4. Bot deposit & withdraw requests submitted via webhook are persisted for admin review
  const depCb = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 9502,
      callback_query: {
        id: 'cbq_m5_dep_100',
        from: { id: 665544, first_name: 'Biniyam', username: 'biniyam_et' },
        message: { chat: { id: 665544, type: 'private' } },
        data: 'cb:deposit_amount:100',
      },
    },
  });
  assert.equal(depCb.statusCode, 200);
  assert.equal(depCb.body.securityCode, 'deposit_request_created');

  // Credit verified funds before testing 50 ETB withdrawal (new account starts with 15 ETB)
  store.set('users/tg_665544', { ...(store.get('users/tg_665544') || {}), demoBalanceEtb: 115 });
  store.set('botPlayers/665544', { ...(store.get('botPlayers/665544') || {}), demoBalanceEtb: 115 });

  const wdrCb = await invokeHandler(webhookHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {
      update_id: 9503,
      callback_query: {
        id: 'cbq_m5_wdr_50',
        from: { id: 665544, first_name: 'Biniyam', username: 'biniyam_et' },
        message: { chat: { id: 665544, type: 'private' } },
        data: 'cb:withdraw_amount:50',
      },
    },
  });
  assert.equal(wdrCb.statusCode, 200);
  assert.equal(wdrCb.body.securityCode, 'withdraw_request_created');

  // Verify deposits/payouts exist in Firestore and are visible to admin endpoints
  const adminDeps = createAdminDepositsHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    authDeps: createMockAuthDeps(
      {
        'tok-admin-m5': {
          uid: 'tg_8842109',
          email: 'abelbimrew868@gmail.com',
          email_verified: true,
        },
      },
      ['tg_8842109']
    ),
    limiter: new BoundedRateLimiter(),
  });
  const depListRes = await invokeHandler(adminDeps, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-admin-m5' },
  });
  assert.equal(depListRes.statusCode, 200);
  const deposits = depListRes.body.deposits as Array<{ uid: string; amountEtb: number }>;
  assert.ok(deposits.some((d) => d.uid === 'tg_665544' && d.amountEtb === 100));
});

test('Milestone 5 Player API: /api/player/state returns 0 ETB on fresh users, computes verified winnings & leaderboard, and /api/player/wallet handles promo/referral, deposit, and withdrawal checks securely', async () => {
  const { db, store } = createStrictInMemoryFirestore();

  const authDeps = createMockAuthDeps(
    {
      'tok-fresh': {
        uid: 'tg_910001',
        telegram_verified: true,
        telegram_id: 910001,
        name: 'Fresh Player',
      },
      'tok-winner': {
        uid: 'tg_920002',
        telegram_verified: true,
        telegram_id: 920002,
        name: 'Selam Winner',
      },
    },
    []
  );

  // Seed winner profile + verified bingo_win transaction + promo code
  store.set('users/tg_920002', {
    uid: 'tg_920002',
    telegramUserId: 'tg_920002',
    displayName: 'Selam Winner',
    username: '@selam_w',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 140,
  });
  store.set('botPlayers/920002', {
    telegramUserId: 920002,
    firebaseUid: 'tg_920002',
    firstName: 'Selam',
    username: 'selam_w',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 140,
    wins: 2,
    totalWonEtb: 140,
    referralCode: 'ADEY-920002',
  });
  store.set('transactions/tx_win_1', {
    transactionId: 'tx_win_1',
    userId: 'tg_920002',
    type: 'bingo_win',
    amountEtb: 90,
    status: 'demo_completed',
    description: 'Card #7 Row 1',
    reference: 'WIN-001',
    createdAt: '2026-11-14T10:00:00.000Z',
  });
  store.set('promoCodes/ADEY50', {
    code: 'ADEY50',
    bonusEtb: 50,
    active: true,
  });

  const stateHandler = createPlayerStateHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const walletHandler = createPlayerWalletHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // 1. Unauthenticated access rejected with 401
  const unauthState = await invokeHandler(stateHandler, { method: 'GET' });
  assert.equal(unauthState.statusCode, 401);

  const unauthWallet = await invokeHandler(walletHandler, {
    method: 'POST',
    body: { action: 'apply_promo', code: 'ADEY50' },
  });
  assert.equal(unauthWallet.statusCode, 401);

  // 2. Fresh user with no stored balance receives strictly 0 ETB (never fabricated 250) and empty transactions
  const freshState = await invokeHandler(stateHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-fresh' },
  });
  assert.equal(freshState.statusCode, 200);
  assert.equal((freshState.body.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 0);
  assert.equal((freshState.body.wallet as { winningsBalanceEtb: number }).winningsBalanceEtb, 0);
  assert.deepEqual(freshState.body.transactions, []);

  // 3. Seeded winner receives verified balance, winningsBalanceEtb=90, and leaderboard entry
  const winnerState = await invokeHandler(stateHandler, {
    method: 'GET',
    headers: { authorization: 'Bearer tok-winner' },
  });
  assert.equal(winnerState.statusCode, 200);
  assert.equal((winnerState.body.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 140);
  assert.equal((winnerState.body.wallet as { winningsBalanceEtb: number }).winningsBalanceEtb, 90);
  const lb = winnerState.body.leaderboard as Array<{ uid: string; winningsEtb: number }>;
  assert.ok(lb.some((e) => e.uid === 'tg_920002' && e.winningsEtb === 90));

  // 4. Client balance/uid override attempt rejected with 403
  const spoofRes = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'deposit_request', amountEtb: 100, demoBalanceEtb: 9999 },
  });
  assert.equal(spoofRes.statusCode, 403);
  assert.equal(spoofRes.body.reason, 'client_override_rejected');

  // 5. Fresh user cannot withdraw 50 ETB when balance is 0 ETB -> 400 insufficient_balance
  const emptyWithdraw = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'withdraw_request', amountEtb: 50, method: 'Telebirr (Demo)' },
  });
  assert.equal(emptyWithdraw.statusCode, 400);
  assert.equal(emptyWithdraw.body.reason, 'insufficient_demo_balance');

  // 6. Fresh user redeems promo code ADEY50 -> +50 ETB once, duplicate rejected (409)
  const promoOk = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'apply_promo', code: 'ADEY50' },
  });
  assert.equal(promoOk.statusCode, 200);
  assert.equal(promoOk.body.bonusEtb, 50);
  assert.equal(promoOk.body.updatedBalanceEtb, 50);

  const promoDup = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'apply_promo', code: 'ADEY50' },
  });
  assert.equal(promoDup.statusCode, 409);

  // 7. Deposit request creates pending record without fabricating instant balance credit
  const depReq = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'deposit_request', amountEtb: 100, provider: 'CBE Birr (Demo)' },
  });
  assert.equal(depReq.statusCode, 201);
  assert.equal(store.get('users/tg_910001')?.demoBalanceEtb, 50);

  // 8. Withdrawal request succeeds against verified 50 ETB balance and records pending payout
  const wdrOk = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-fresh' },
    body: { action: 'withdraw_request', amountEtb: 25, method: 'Telebirr (Demo)' },
  });
  assert.equal(wdrOk.statusCode, 201);
  const createdWithdrawal = wdrOk.body.withdrawal as { requestId: string; status: string; requestedAmountEtb: number };
  assert.equal(createdWithdrawal.status, 'Pending');
  assert.equal(createdWithdrawal.requestedAmountEtb, 25);
  assert.equal(store.get(`payoutRequests/${createdWithdrawal.requestId}`)?.status, 'Pending');

  // 9. Self-referral rejected
  const selfRef = await invokeHandler(walletHandler, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-winner' },
    body: { action: 'apply_promo', code: 'ADEY-920002' },
  });
  assert.equal(selfRef.statusCode, 400);
});

test('Consolidated Vercel catch-all routers (admin, telegram, game, player) route all sub-paths and dynamic segments accurately', async () => {
  const { db, store } = createStrictInMemoryFirestore();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const webhookSecret = 'webhook_secret_router_test';
  const sessionSecret = 'router_test_session_secret_2026';
  const nowUnix = 1_760_000_000;

  const authDeps: AuthBackendDeps = {
    ...createMockAuthDeps(
      {
        'tok-admin': {
          uid: 'tg_8842109',
          email: 'abelbimrew868@gmail.com',
          email_verified: true,
          telegram_verified: true,
          telegram_id: 8842109,
          name: 'Admin Abebe',
        },
        'tok-player': {
          uid: 'tg_7777777',
          telegram_verified: true,
          telegram_id: 7777777,
          name: 'Dawit Player',
        },
      },
      ['tg_8842109']
    ),
    getSessionSecret: () => sessionSecret,
  };

  store.set('users/tg_8842109', {
    uid: 'tg_8842109',
    telegramUserId: 'tg_8842109',
    displayName: 'Admin Abebe',
    username: '@abebe_adey',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 500,
    accountStatus: 'active',
  });
  store.set('users/tg_7777777', {
    uid: 'tg_7777777',
    telegramUserId: 'tg_7777777',
    displayName: 'Dawit Mekonnen',
    username: '@dawit_m',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 185,
    accountStatus: 'active',
  });
  store.set('depositRequests/DEP-2026-401', {
    id: 'DEP-2026-401',
    uid: 'tg_7777777',
    telegramUserId: 7777777,
    playerName: 'Dawit Mekonnen',
    method: 'Telebirr',
    amountEtb: 100,
    referenceCode: 'TB-ROUTER-401',
    status: 'Pending',
    demoSandboxOnly: true,
    createdAt: new Date(nowUnix * 1000).toISOString(),
  });
  store.set('payoutRequests/PO-2026-901', {
    id: 'PO-2026-901',
    uid: 'tg_7777777',
    telegramUserId: 7777777,
    playerName: 'Dawit Mekonnen',
    method: 'Telebirr',
    accountMask: '+251 9•• ••• 210',
    requestedAmountEtb: 75,
    status: 'Pending',
    demoSandboxOnly: true,
    requestedAt: new Date(nowUnix * 1000).toISOString(),
  });

  const adminRouter = createAdminRouterHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const telegramRouter = createTelegramRouterHandler({
    getDb: () => db,
    getBotToken: () => botToken,
    getWebhookSecret: () => webhookSecret,
    isAdminReady: () => true,
    authDeps,
    nowUnixSeconds: () => nowUnix,
    limiter: new BoundedRateLimiter(),
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_${telegramUserId}`,
    }),
  });
  const gameRouter = createGameRouterHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const playerRouter = createPlayerRouterHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });

  // 1. Admin router: static & nested & dynamic routes via req.url and req.query.route
  const sessionRes = await invokeHandler(adminRouter, {
    method: 'GET',
    query: { route: 'session' },
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(sessionRes.statusCode, 200);
  assert.equal(sessionRes.body.authorized, true);

  const overviewRes = await invokeHandler(adminRouter, {
    method: 'GET',
    query: { route: 'overview' },
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(overviewRes.statusCode, 200);
  assert.equal(overviewRes.body.ok, true);

  const depReviewRes = await invokeHandler(adminRouter, {
    method: 'POST',
    query: { route: 'deposits/DEP-2026-401/review' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { nextStatus: 'Approved', reviewNotes: 'Consolidated router test' },
  });
  assert.equal(depReviewRes.statusCode, 200);

  const payoutReviewRes = await invokeHandler(adminRouter, {
    method: 'POST',
    query: { route: 'payouts/PO-2026-901/review' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { nextStatus: 'Under Review', reviewNotes: 'Checking' },
  });
  assert.equal(payoutReviewRes.statusCode, 200);

  const roomUpdateRes = await invokeHandler(adminRouter, {
    method: 'POST',
    query: { route: 'rooms/adey-main' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { cardPriceEtb: 20 },
  });
  assert.equal(roomUpdateRes.statusCode, 200);

  const userStatusRes = await invokeHandler(adminRouter, {
    method: 'POST',
    query: { route: 'users/tg_7777777/status' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { accountStatus: 'suspended', reason: 'Router test' },
  });
  assert.equal(userStatusRes.statusCode, 200);

  const unknownAdmin = await invokeHandler(adminRouter, {
    method: 'GET',
    query: { route: 'non-existent' },
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(unknownAdmin.statusCode, 404);

  // 2. Telegram router: validate-init-data, bot-state, bot-command
  const signedInit = buildSignedInitData(botToken, nowUnix - 5, {
    id: 8842109,
    first_name: 'Abebe',
    username: 'abebe_adey',
  });
  const tgValidate = await invokeHandler(telegramRouter, {
    method: 'POST',
    query: { route: 'validate-init-data' },
    body: { initData: signedInit },
  });
  assert.equal(tgValidate.statusCode, 200);
  assert.equal(tgValidate.body.verified, true);

  const tgBotCmd = await invokeHandler(telegramRouter, {
    method: 'POST',
    query: { route: 'bot-command' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { text: '/help' },
  });
  assert.equal(tgBotCmd.statusCode, 200);

  // 3. Player router: state & wallet
  const pState = await invokeHandler(playerRouter, {
    method: 'GET',
    query: { route: 'state' },
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(pState.statusCode, 200);
  assert.equal((pState.body.wallet as { availableBalanceEtb: number }).availableBalanceEtb, 500);

  const pWallet = await invokeHandler(playerRouter, {
    method: 'POST',
    query: { route: 'wallet' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { action: 'deposit_request', amountEtb: 50, provider: 'Telebirr (Demo)' },
  });
  assert.equal(pWallet.statusCode, 201);

  // 4. Game router: start (returns 404 room_not_found on missing room, proving route & auth dispatch)
  const gStart = await invokeHandler(gameRouter, {
    method: 'POST',
    query: { route: 'start' },
    headers: { authorization: 'Bearer tok-admin' },
    body: { roomId: 'missing-room' },
  });
  assert.equal(gStart.statusCode, 404);
  assert.equal(gStart.body.reason, 'room_not_found');

  // 5. Vercel rewrite format (/api/<group>?route=<subpath> and direct /api/<group>/<subpath>)
  const rewrittenAdminOverview = await invokeHandler(adminRouter, {
    url: '/api/admin?route=overview',
    method: 'GET',
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(rewrittenAdminOverview.statusCode, 200);
  assert.equal(rewrittenAdminOverview.body.ok, true);

  const rewrittenNestedSession = await invokeHandler(adminRouter, {
    url: '/api/admin?route=session/exchange',
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    body: {},
  });
  assert.equal(rewrittenNestedSession.statusCode, 200);
  assert.equal(rewrittenNestedSession.body.authorized, true);

  const directNestedAdminPath = await invokeHandler(adminRouter, {
    url: '/api/admin/bot/config',
    method: 'GET',
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(directNestedAdminPath.statusCode, 200);
  assert.equal(directNestedAdminPath.body.ok, true);

  const rewrittenTelegramCmd = await invokeHandler(telegramRouter, {
    url: '/api/telegram?route=bot-command',
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    body: { text: '/balance' },
  });
  assert.equal(rewrittenTelegramCmd.statusCode, 200);

  const rewrittenPlayerState = await invokeHandler(playerRouter, {
    url: '/api/player?route=state',
    method: 'GET',
    headers: { authorization: 'Bearer tok-admin' },
  });
  assert.equal(rewrittenPlayerState.statusCode, 200);

  const rewrittenGameStart = await invokeHandler(gameRouter, {
    url: '/api/game?route=start',
    method: 'POST',
    headers: { authorization: 'Bearer tok-admin' },
    body: { roomId: 'missing-room' },
  });
  assert.equal(rewrittenGameStart.statusCode, 404);
  assert.equal(rewrittenGameStart.body.reason, 'room_not_found');
});

