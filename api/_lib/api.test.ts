import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { AuthBackendDeps, DecodedIdTokenLike } from './auth.ts';
import { BoundedRateLimiter } from './http.ts';
import { createStatusHandler } from '../backend/status.ts';
import { createTelegramAuthHandler } from '../telegram/auth.ts';
import { createValidateInitDataHandler } from '../telegram/validate-init-data.ts';
import { createTelegramWebhookHandler } from '../telegram/webhook.ts';
import { createRegisterWebhookHandler } from '../telegram/register-webhook.ts';
import { createWebhookInfoHandler } from '../telegram/webhook-info.ts';
import { createBotCommandHandler } from '../telegram/bot-command.ts';
import { createNotifyHandler } from '../telegram/notify.ts';
import { createBotStateHandler } from '../telegram/bot-state.ts';
import { createRoomsHandler } from '../rooms/index.ts';
import { createReserveCardHandler } from '../cards/reserve.ts';
import { createStartGameHandler } from '../game/start.ts';
import { createDrawBallHandler } from '../game/draw-ball.ts';
import { createResetRoundHandler } from '../game/reset-round.ts';
import { createVerifyWinnerHandler } from '../game/verify-winner.ts';
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

  const pairs: string[] = [];
  params.forEach((value, key) => {
    pairs.push(`${key}=${value}`);
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
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

  const req = {
    method: options.method || 'GET',
    headers,
    body: options.body,
    query: options.query || {},
    socket: { remoteAddress: options.ip || '198.51.100.10' },
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

  // Valid initData -> 200 with canonical tg_<id> and Firebase customToken
  const okRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.uid, 'tg_778899');
  assert.equal(okRes.body.customToken, 'custom_token_for_tg_778899');
  assert.equal(store.get('telegramBindings/tg_778899')?.uid, 'tg_778899');
  assert.equal(store.get('users/tg_778899')?.demoBalanceEtb, 250);

  // Replayed initData -> 409 Conflict
  const replayRes = await invokeHandler(authHandler, {
    method: 'POST',
    body: { initData: validInit },
  });
  assert.equal(replayRes.statusCode, 409);
  assert.equal(replayRes.body.reason, 'replay_detected');

  // Validate-init-data endpoint also enforces persistent replay & rejects actionNonce override
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
  const valReplay = await invokeHandler(validateHandler, {
    method: 'POST',
    body: { initData: secondInit },
  });
  assert.equal(valReplay.statusCode, 409);
  assert.equal(valReplay.body.reason, 'replay_detected');
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
  assert.ok(prize >= 50);
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
