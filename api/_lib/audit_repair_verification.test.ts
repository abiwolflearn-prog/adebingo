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
import { createDrawBallHandler, createSchedulerTickHandler } from './gameHandler.ts';
import {
  createFirestoreGameStore,
  PersistentGameAuthorityService,
} from './gamePersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { createPlayerStateHandler, createPlayerWalletHandler } from './playerHandler.ts';
import { createAdminOverviewHandler } from './adminHandler.ts';
import { AdeyBingoTelegramBotEngine } from '../../src/utils/telegramBot.ts';
import { normalizeTelegramPhoneNumber, verifyTelegramSharedContact } from '../../src/utils/telegramVerify.ts';
import { initTelegramMiniApp } from '../../src/utils/telegram.ts';

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
        if (!store.has(path)) {
          throw new Error(`NOT_FOUND: ${path}`);
        }
        store.set(path, { ...store.get(path)!, ...clone(data) });
      },
      async delete() {
        store.delete(path);
      },
    };
  }

  function listCollectionDocs(prefix: string) {
    const docs: Array<ReturnType<typeof makeSnap>> = [];
    for (const [key, value] of store.entries()) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const remainder = key.slice(prefix.length + 1);
      if (remainder.includes('/')) continue;
      docs.push(makeSnap(remainder, key, value));
    }
    return docs;
  }

  function makeQuery(
    prefix: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    orderField?: string,
    orderDir: 'asc' | 'desc' = 'asc',
    limitN?: number
  ) {
    const q = {
      _prefix: prefix,
      where(field: string, op: string, value: unknown) {
        return makeQuery(prefix, [...filters, { field, op, value }], orderField, orderDir, limitN);
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        return makeQuery(prefix, filters, field, dir, limitN);
      },
      limit(n: number) {
        return makeQuery(prefix, filters, orderField, orderDir, n);
      },
      async get() {
        let docs = listCollectionDocs(prefix);
        for (const f of filters) {
          docs = docs.filter((d) => {
            const val = d.get(f.field);
            if (f.op === '==') return val === f.value;
            if (f.op === '>=') return Number(val) >= Number(f.value);
            if (f.op === '<=') return Number(val) <= Number(f.value);
            return true;
          });
        }
        if (orderField) {
          docs.sort((a, b) => {
            const av = a.get(orderField);
            const bv = b.get(orderField);
            if (av === bv) return 0;
            const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
            return orderDir === 'desc' ? -cmp : cmp;
          });
        }
        if (typeof limitN === 'number') {
          docs = docs.slice(0, limitN);
        }
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
    return q;
  }

  function makeCollectionRef(prefix: string) {
    return {
      ...makeQuery(prefix),
      doc(id: string) {
        return makeDocRef(`${prefix}/${id}`);
      },
    };
  }

  const db = {
    collection(name: string) {
      return makeCollectionRef(name);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = txQueue.then(async () => {
        const snapshot = new Map<string, DocData>();
        for (const [k, v] of store.entries()) snapshot.set(k, clone(v));
        const writes: Array<() => void> = [];
        const tx = {
          async get(refOrQuery: { path?: string; get: () => Promise<unknown> }) {
            return await refOrQuery.get();
          },
          set(ref: { path: string }, data: DocData, opts?: { merge?: boolean }) {
            writes.push(() => {
              if (opts?.merge && store.has(ref.path)) {
                store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
              } else {
                store.set(ref.path, clone(data));
              }
            });
          },
          update(ref: { path: string }, data: DocData) {
            writes.push(() => {
              if (!store.has(ref.path)) throw new Error(`NOT_FOUND: ${ref.path}`);
              store.set(ref.path, { ...store.get(ref.path)!, ...clone(data) });
            });
          },
          delete(ref: { path: string }) {
            writes.push(() => {
              store.delete(ref.path);
            });
          },
        };
        try {
          const result = await fn(tx);
          for (const w of writes) w();
          return result;
        } catch (err) {
          store.clear();
          for (const [k, v] of snapshot.entries()) store.set(k, v);
          throw err;
        }
      });
      txQueue = run.catch(() => undefined);
      return run;
    },
  };

  return { db: db as unknown as Firestore, store };
}

function makeReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}): VercelRequest {
  return {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    body: opts.body,
    query: opts.query ?? {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = undefined;
  const res = {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    end() {
      return res;
    },
  };
  return {
    res: res as unknown as VercelResponse,
    getStatus: () => statusCode,
    getBody: () => body as Record<string, unknown>,
  };
}

function buildSignedInitData(
  botToken: string,
  userObj: { id: number; first_name: string; last_name?: string; username?: string },
  authDateSec: number,
  startParam?: string
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDateSec));
  params.set('query_id', `AAHdF6IQAAAAAN0XohDhrOrc_${userObj.id}`);
  params.set('user', JSON.stringify(userObj));
  if (startParam) params.set('start_param', startParam);
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const TEST_BOT_TOKEN = '123456789:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQR';
const TEST_WEBHOOK_SECRET = 'adeybingo_audit_webhook_secret_2026';

// ============================================================================
// TEST 1: Amharic /start Welcome (New vs Returning), Native ReplyKeyboard +
//         request_contact Delivery, and Zero Fake Default Users
// ============================================================================
test('Audit Repair 1: /start differentiates new vs returning Amharic welcome, delivers ReplyKeyboardMarkup with request_contact, and creates zero fake users', async () => {
  const { db } = createInMemoryFirestore();
  const store = createFirestoreTelegramStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(store, replay, 'https://adebingo-3nta.vercel.app/');

  const sentPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch = (async (url: string, init?: { body?: string }) => {
    sentPayloads.push({
      url: String(url),
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return { ok: true, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;

  const webhook = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    getWebhookSecret: () => TEST_WEBHOOK_SECRET,
    fetchImpl: mockFetch,
    limiter: new BoundedRateLimiter(),
  });

  // 1. Brand-new user sends /start
  const r1 = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 50001,
        message: {
          chat: { id: 910001, type: 'private' },
          from: { id: 910001, first_name: 'Selam', username: 'selam_et' },
          text: '/start',
        },
      },
    }),
    r1.res
  );
  assert.equal(r1.getStatus(), 200);
  const body1 = r1.getBody();
  assert.equal(body1.ok, true);
  assert.equal(body1.language, 'am');
  assert.equal(body1.securityCode, 'onboarding_welcome');
  assert.match(String(body1.text), /Welcome to AdeyBingo! 🎉/);
  assert.match(String(body1.text), /ወደ አዴይ ቢንጎ እንኳን በደህና መጡ! 🎉/);

  // Step 1 sends 1 message with inline Start / ጀምር button (no Play button yet)
  assert.equal(sentPayloads.length, 1);
  const step1Markup = sentPayloads[0].body.reply_markup as {
    keyboard?: unknown;
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: unknown }>>;
  };
  assert.ok(Array.isArray(step1Markup?.inline_keyboard), 'Step 1 /start must deliver inline_keyboard');
  assert.equal(step1Markup?.keyboard, undefined, 'Step 1 must NOT combine keyboard with inline_keyboard');
  assert.ok(
    step1Markup.inline_keyboard!.flat().some((b) => b.callback_data === 'cb:onboarding_start' && b.text === 'Start / ጀምር')
  );

  // Step 2: User clicks Start / ጀምር -> sends ReplyKeyboardMarkup with native request_contact: true ONLY
  const rStart = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 500015,
        callback_query: {
          id: 'cbq_onboard_500015',
          from: { id: 910001, first_name: 'Selam', username: 'selam_et' },
          message: { chat: { id: 910001, type: 'private' } },
          data: 'cb:onboarding_start',
        },
      },
    }),
    rStart.res
  );
  assert.equal(rStart.getStatus(), 200);
  const contactPayload = sentPayloads.find(
    (p) => p.url.includes('/sendMessage') && Boolean((p.body.reply_markup as { keyboard?: unknown })?.keyboard)
  );
  assert.ok(contactPayload, 'Step 2 must send ReplyKeyboardMarkup with request_contact: true');
  const replyMarkup1 = contactPayload!.body.reply_markup as {
    keyboard?: Array<Array<{ text: string; request_contact?: boolean }>>;
    inline_keyboard?: unknown;
  };
  assert.equal(replyMarkup1?.inline_keyboard, undefined);
  assert.ok(replyMarkup1.keyboard!.flat().some((b) => b.request_contact === true));

  // Step 3: User shares authentic phone contact -> removes keyboard & sends persistent 8-button main menu
  const rContact = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 500016,
        message: {
          chat: { id: 910001, type: 'private' },
          from: { id: 910001, first_name: 'Selam', username: 'selam_et' },
          contact: { phone_number: '+251911910001', first_name: 'Selam', user_id: 910001 },
        },
      },
    }),
    rContact.res
  );
  assert.equal(rContact.getStatus(), 200);
  assert.equal(rContact.getBody().registrationStatus, 'verified');

  // 2. Returning verified user sends /start again -> warm returning greeting, no duplicate 15 ETB credit
  const r2 = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 50002,
        message: {
          chat: { id: 910001, type: 'private' },
          from: { id: 910001, first_name: 'Selam', username: 'selam_et' },
          text: '/start',
        },
      },
    }),
    r2.res
  );
  assert.equal(r2.getStatus(), 200);
  const body2 = r2.getBody();
  assert.match(String(body2.text), /እንኳን.*በደህና ተመለሱ/);
  const savedPlayer = await store.getPlayer(910001);
  assert.equal(savedPlayer?.demoBalanceEtb, 15, 'Returning /start must not double-credit 15 ETB');

  // 3. Outside Telegram WebApp (including forged ?tgId= URL query params), initTelegramMiniApp must NEVER fabricate fake user IDs
  const prevWindow = (globalThis as Record<string, unknown>).window;
  try {
    (globalThis as Record<string, unknown>).window = {
      location: { search: '?tgId=8842109&firstName=Abebe&lastName=Bikila&username=abebe_et' },
    };
    const guestWithUrlOverride = initTelegramMiniApp();
    assert.equal(guestWithUrlOverride.id, 0);
    assert.equal(guestWithUrlOverride.isTelegramWebApp, false);

    // Unsigned Telegram.WebApp with empty initData must also stay unauthenticated guest
    (globalThis as Record<string, unknown>).window = {
      location: { search: '' },
      Telegram: {
        WebApp: {
          initData: '',
          initDataUnsafe: { user: { id: 8842109, first_name: 'Abebe', username: 'abebe_et' } },
        },
      },
    };
    const guestWithoutSignedInit = initTelegramMiniApp();
    assert.equal(guestWithoutSignedInit.id, 0);
    assert.equal(guestWithoutSignedInit.isTelegramWebApp, false);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

// ============================================================================
// TEST 2: Referral Reward Lifecycle (+20 ETB Inviter / 15 ETB Invitee),
//         Dual Confirmation, Ledger Sync, and Abuse/Duplicate Prevention
// ============================================================================
test('Audit Repair 2: Referral lifecycle credits +20 ETB inviter & 15 ETB invitee, notifies both users, syncs ledger, and blocks self/returning/duplicate claims', async () => {
  const { db, store: rawStore } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(tgStore, replay, 'https://adebingo-3nta.vercel.app/');

  const sentMessages: Array<{ chat_id: number; text: string }> = [];
  const mockFetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) {
      const parsed = JSON.parse(init.body) as { chat_id?: number; text?: string };
      if (parsed.chat_id && parsed.text) {
        sentMessages.push({ chat_id: parsed.chat_id, text: parsed.text });
      }
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;

  const webhook = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    getWebhookSecret: () => TEST_WEBHOOK_SECRET,
    fetchImpl: mockFetch,
    limiter: new BoundedRateLimiter(),
  });

  // 1. Inviter registers via /start -> 15 ETB
  const invStart = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60001,
        message: {
          chat: { id: 920001, type: 'private' },
          from: { id: 920001, first_name: 'Dawit', username: 'dawit_inv' },
          text: '/start',
        },
      },
    }),
    invStart.res
  );
  assert.equal(invStart.getStatus(), 200);
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 15);

  // 2. Verify inviter's official referral link from /invite
  const invLinkRes = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60002,
        message: {
          chat: { id: 920001, type: 'private' },
          from: { id: 920001, first_name: 'Dawit', username: 'dawit_inv' },
          text: '/invite',
        },
      },
    }),
    invLinkRes.res
  );
  assert.match(
    String(invLinkRes.getBody().text),
    /https:\/\/t\.me\/AdeyBingoGameBot\?start=ADEY-920001/
  );

  // 3. New invited player opens /start ADEY-920001
  sentMessages.length = 0;
  const inviteeStart = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60003,
        message: {
          chat: { id: 920002, type: 'private' },
          from: { id: 920002, first_name: 'Hanna', username: 'hanna_new' },
          text: '/start ADEY-920001',
        },
      },
    }),
    inviteeStart.res
  );
  assert.equal(inviteeStart.getStatus(), 200);
  assert.match(String(inviteeStart.getBody().text), /15\.00 ETB/);
  assert.match(String(inviteeStart.getBody().text), /\+20\.00 ETB/);

  // Both inviter (920001) and invitee (920002) received real-time Telegram confirmation messages!
  assert.ok(
    sentMessages.some((m) => m.chat_id === 920002 && m.text.includes('15.00 ETB')),
    'Invitee must receive welcome + reward confirmation'
  );
  assert.ok(
    sentMessages.some((m) => m.chat_id === 920001 && m.text.includes('20')),
    'Inviter must receive real-time +20 ETB referral confirmation'
  );

  // Balances & transaction ledgers are synchronized
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 35);
  assert.equal((await tgStore.getPlayer(920002))?.demoBalanceEtb, 15);
  assert.ok(rawStore.has('transactions/tx_ref_inviter_920002'), 'Inviter referral ledger tx must exist');
  assert.ok(rawStore.has('transactions/tx_init_tg_920002'), 'Invitee initial 15 ETB ledger tx must exist');

  // 4. Duplicate /start ADEY-920001 by same invitee with new update_id -> NO second credit
  const dupStart = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60004,
        message: {
          chat: { id: 920002, type: 'private' },
          from: { id: 920002, first_name: 'Hanna', username: 'hanna_new' },
          text: '/start ADEY-920001',
        },
      },
    }),
    dupStart.res
  );
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 35);

  // 5. Existing user (registered previously without referral) attempts /start ADEY-920001 -> BLOCKED!
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60005,
        message: {
          chat: { id: 920003, type: 'private' },
          from: { id: 920003, first_name: 'OldUser', username: 'old_user' },
          text: '/start',
        },
      },
    }),
    makeRes().res
  );
  const existingTryRef = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60006,
        message: {
          chat: { id: 920003, type: 'private' },
          from: { id: 920003, first_name: 'OldUser', username: 'old_user' },
          text: '/start ADEY-920001',
        },
      },
    }),
    existingTryRef.res
  );
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 35, 'Returning user must not retroactively credit inviter');
  assert.match(String(existingTryRef.getBody().text), /ቀደም ብሎ ተመዝግቧል/);

  // 6. Self-referral rejected cleanly
  const selfRef = makeRes();
  await webhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 60007,
        message: {
          chat: { id: 920001, type: 'private' },
          from: { id: 920001, first_name: 'Dawit', username: 'dawit_inv' },
          text: '/start ADEY-920001',
        },
      },
    }),
    selfRef.res
  );
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 35);
  assert.match(String(selfRef.getBody().text), /የራስዎን/);

  // 7. Mini App /api/telegram/auth with start_param queues referral_confirmation for inviter
  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_tok_${telegramUserId}`,
    }),
    limiter: new BoundedRateLimiter(),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const initData = buildSignedInitData(
    TEST_BOT_TOKEN,
    { id: 920004, first_name: 'Bereket', username: 'bereket_mini' },
    nowSec,
    'ADEY-920001'
  );
  const authRes = makeRes();
  await authHandler(makeReq({ body: { initData } }), authRes.res);
  assert.equal(authRes.getStatus(), 200);
  assert.equal((await tgStore.getPlayer(920001))?.demoBalanceEtb, 55);
  const outbox = await tgStore.listNotifications(20);
  assert.ok(
    outbox.some((n) => n.event === 'referral_confirmation' && n.telegramUserId === 920001),
    'Mini App referral must queue referral_confirmation for inviter'
  );

  // 8. In-memory AdeyBingoTelegramBotEngine also syncs wallet ledger transactions for initial 15 ETB & +20 ETB referral
  const engine = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');
  engine.handleIncomingUpdate({ senderTelegramId: 1001, firstName: 'Inviter', username: 'inv1', text: '/start' });
  const engRefRes = engine.handleIncomingUpdate({
    senderTelegramId: 1002,
    firstName: 'Invitee',
    username: 'inv2',
    text: '/start ADEY-1001',
  });
  assert.ok(engRefRes.inviterNotification, 'In-memory engine must attach inviterNotification');
  assert.equal(engine.getPlayerByTelegramId(1001)?.demoBalanceEtb, 35);
  const walletHist = engine.handleIncomingUpdate({
    senderTelegramId: 1001,
    firstName: 'Inviter',
    username: 'inv1',
    callbackData: 'cb:wallet_history',
  });
  assert.match(walletHist.text, /ADB-REF-1002/);
  assert.match(walletHist.text, /\+20\.00 ETB/);
});

// ============================================================================
// TEST 3: Native Contact Sharing, Ethiopian Phone Normalization,
//         Duplicate Phone Blocking & Zero Fabricated phoneVerified
// ============================================================================
test('Audit Repair 3: Native contact sharing normalizes Ethiopian formats, blocks duplicates & mismatches, and never fabricates phoneVerified', async () => {
  // 1. Canonical Ethiopian phone normalization
  assert.equal(normalizeTelegramPhoneNumber('0911223344'), '+251911223344');
  assert.equal(normalizeTelegramPhoneNumber('0711223344'), '+251711223344');
  assert.equal(normalizeTelegramPhoneNumber('00251911223344'), '+251911223344');
  assert.equal(normalizeTelegramPhoneNumber('251-911-223-344'), '+251911223344');
  assert.equal(normalizeTelegramPhoneNumber('+251 (911) 223-344'), '+251911223344');

  // Invalid all-zero number rejected
  const invalidCheck = verifyTelegramSharedContact({
    senderTelegramId: 930001,
    contact: { phone_number: '0000000000', user_id: 930001 },
  });
  assert.equal(invalidCheck.valid, false);
  assert.equal(invalidCheck.reason, 'invalid_phone_format');

  // 2. PersistentTelegramBotService duplicate check across 0911... vs +251911...
  const { db } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(tgStore, replay, 'https://adebingo-3nta.vercel.app/');

  // Plain-text phone rejected
  const plainRes = await botService.handleIncomingUpdate({
    updateId: 70001,
    chatId: 930001,
    chatType: 'private',
    senderTelegramId: 930001,
    firstName: 'Rahel',
    username: 'rahel',
    text: '+251911223344',
  });
  assert.equal(plainRes.ok, false);
  assert.equal(plainRes.securityCode, 'plain_text_phone_rejected');
  assert.equal((await tgStore.getPlayer(930001))?.phoneVerified ?? false, false);

  // Forwarded contact (mismatched user_id) rejected
  const mismatchRes = await botService.handleIncomingUpdate({
    updateId: 70002,
    chatId: 930001,
    chatType: 'private',
    senderTelegramId: 930001,
    firstName: 'Rahel',
    username: 'rahel',
    contact: { phone_number: '0911223344', user_id: 999999, first_name: 'Other' },
  });
  assert.equal(mismatchRes.ok, false);
  assert.equal(mismatchRes.securityCode, 'contact_owner_mismatch');

  // Sender-owned local Ethiopian format (0911223344) succeeds
  const okContact = await botService.handleIncomingUpdate({
    updateId: 70003,
    chatId: 930001,
    chatType: 'private',
    senderTelegramId: 930001,
    firstName: 'Rahel',
    username: 'rahel',
    contact: { phone_number: '0911223344', user_id: 930001, first_name: 'Rahel' },
  });
  assert.equal(okContact.ok, true);
  assert.equal(okContact.securityCode, 'contact_verified');
  assert.equal((await tgStore.getPlayer(930001))?.phoneVerified, true);

  // Second Telegram user trying to verify the SAME number in +251 international format -> BLOCKED!
  const dupPhone = await botService.handleIncomingUpdate({
    updateId: 70004,
    chatId: 930002,
    chatType: 'private',
    senderTelegramId: 930002,
    firstName: 'Second',
    username: 'second',
    contact: { phone_number: '+251911223344', user_id: 930002, first_name: 'Second' },
  });
  assert.equal(dupPhone.ok, false);
  assert.equal(dupPhone.securityCode, 'duplicate_phone_number');

  // Already-verified user trying to overwrite with a different number -> LOCKED!
  const lockedOverwrite = await botService.handleIncomingUpdate({
    updateId: 70005,
    chatId: 930001,
    chatType: 'private',
    senderTelegramId: 930001,
    firstName: 'Rahel',
    username: 'rahel',
    contact: { phone_number: '+251922334455', user_id: 930001, first_name: 'Rahel' },
  });
  assert.equal(lockedOverwrite.ok, false);
  assert.equal(lockedOverwrite.securityCode, 'verified_contact_locked');

  // 3. In-memory AdeyBingoTelegramBotEngine also enforces duplicate_phone_number and verified_contact_locked
  const engine = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');
  const e1 = engine.handleIncomingUpdate({
    senderTelegramId: 2001,
    firstName: 'A',
    username: 'a',
    contact: { phone_number: '0911556677', user_id: 2001 },
  });
  assert.equal(e1.ok, true);
  const e2 = engine.handleIncomingUpdate({
    senderTelegramId: 2002,
    firstName: 'B',
    username: 'b',
    contact: { phone_number: '+251911556677', user_id: 2002 },
  });
  assert.equal(e2.ok, false);
  assert.equal(e2.securityCode, 'duplicate_phone_number');
  const e3 = engine.handleIncomingUpdate({
    senderTelegramId: 2001,
    firstName: 'A',
    username: 'a',
    contact: { phone_number: '+251922556677', user_id: 2001 },
  });
  assert.equal(e3.ok, false);
  assert.equal(e3.securityCode, 'verified_contact_locked');
});

// ============================================================================
// TEST 4: Every Telegram Bot Menu Button (Reply Keyboard, Inline Callbacks,
//         Slash Commands, New User Before /start, Custom Labels & Auth Guard)
// ============================================================================
test('Audit Repair 4: Every bot menu button, slash command, inline callback, custom label, and admin guard works for new and existing users', async () => {
  const { db } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(tgStore, replay, 'https://adebingo-3nta.vercel.app/');

  let updateCounter = 80000;
  const sendText = (tgId: number, text: string) =>
    botService.handleIncomingUpdate({
      updateId: ++updateCounter,
      chatId: tgId,
      chatType: 'private',
      senderTelegramId: tgId,
      firstName: 'Tesfaye',
      username: `u_${tgId}`,
      text,
    });
  const sendCb = (tgId: number, callbackData: string) =>
    botService.handleIncomingUpdate({
      updateId: ++updateCounter,
      chatId: tgId,
      chatType: 'private',
      callbackQueryId: `cb_${updateCounter}`,
      senderTelegramId: tgId,
      firstName: 'Tesfaye',
      username: `u_${tgId}`,
      callbackData,
    });

  // 1. Brand-new user sends /start and verifies phone contact -> receives 15.00 ETB starter balance
  const startNewUser = await sendText(940001, '/start');
  assert.equal(startNewUser.ok, true);
  await botService.handleIncomingUpdate({
    updateId: ++updateCounter,
    chatId: 940001,
    chatType: 'private',
    senderTelegramId: 940001,
    firstName: 'Tesfaye',
    username: 'u_940001',
    contact: { phone_number: '+251911940001', first_name: 'Tesfaye', user_id: 940001 },
  });
  const newUserWallet = await sendText(940001, '💰 የእኔ ቦርሳ');
  assert.equal(newUserWallet.ok, true);
  assert.match(newUserWallet.text, /15\.00 ETB/);

  // Verify user 940002 before testing every verified main menu button and callback
  await sendText(940002, '/start');
  await botService.handleIncomingUpdate({
    updateId: ++updateCounter,
    chatId: 940002,
    chatType: 'private',
    senderTelegramId: 940002,
    firstName: 'Tesfaye',
    username: 'u_940002',
    contact: { phone_number: '+251911940002', first_name: 'Tesfaye', user_id: 940002 },
  });

  // 2. Test every single Reply Keyboard button (bilingual + legacy aliases) & slash command
  const menuTextInputs = [
    '/start',
    '🎮 ጨዋታ ጀምር | Play',
    '💰 ገንዘብ አስገባ | Deposit',
    '/deposit',
    '💸 ገንዘብ አውጣ | Withdraw',
    '/withdraw',
    '🆘 እገዛ | Support',
    '/support',
    '🎁 ጓደኛ ጋብዝ | Invite Friends',
    '/invite',
    '👤 መለያዬ | My Account',
    '/profile',
    '🌐 ቋንቋ ቀይር | Change Language',
    '/language',
    '🏠 ዋና ምናሌ | Main Menu',
    '💰 የእኔ ቦርሳ',
    '/wallet',
    '🏆 የደረጃ ሰንጠረዥ',
    '/leaderboard',
    '📜 የጨዋታ ታሪክ',
    '/history',
    '/help',
    '/terms',
  ];
  for (const input of menuTextInputs) {
    const res = await sendText(940002, input);
    assert.equal(res.ok, true, `Menu command/button "${input}" must succeed`);
    assert.ok(res.text.length > 10, `Menu command/button "${input}" must return descriptive text`);
  }

  // 3. Test every contextual Inline Keyboard callback
  const validCallbacks = [
    'cb:play_bingo',
    'cb:my_wallet',
    'cb:wallet_refresh',
    'cb:wallet_history',
    'cb:deposit',
    'cb:deposit_method:telebirr',
    'cb:deposit_amount:100',
    'cb:deposit_status',
    'cb:withdraw',
    'cb:withdraw_method:cbe_birr',
    'cb:withdraw_status',
    'cb:invite_friends',
    'cb:referral_copy',
    'cb:leaderboard',
    'cb:game_history',
    'cb:my_profile',
    'cb:copy_telegram_id',
    'cb:support',
    'cb:language',
    'lang:en',
    'lang:am',
    'cb:main_menu',
  ];
  for (const cb of validCallbacks) {
    const res = await sendCb(940002, cb);
    assert.equal(res.ok, true, `Callback "${cb}" must succeed`);
  }

  // 4. Invalid deposit amount callback returns explicit ok: false error (no silent fallthrough)
  const badDeposit = await sendCb(940002, 'cb:deposit_amount:1');
  assert.equal(badDeposit.ok, false);
  assert.equal(badDeposit.securityCode, 'invalid_deposit_amount');

  // 5. Insufficient withdrawal balance rejected safely (15 ETB < 50 ETB)
  const badWithdraw = await sendCb(940002, 'cb:withdraw_amount:50');
  assert.equal(badWithdraw.ok, false);
  assert.equal(badWithdraw.securityCode, 'insufficient_demo_balance');

  // 6. Unauthorized /admin and admin:panel safely blocked in player bot
  const adminCmd = await sendText(940002, '/admin');
  assert.equal(adminCmd.ok, false);
  assert.equal(adminCmd.securityCode, 'admin_command_forbidden_in_player_bot');
  const adminCb = await sendCb(940002, 'admin:dashboard');
  assert.equal(adminCb.ok, false);
  assert.equal(adminCb.securityCode, 'admin_command_forbidden_in_player_bot');

  // 7. Duplicate callback_query_id blocked (no duplicate deposit created)
  const dupCb1 = await botService.handleIncomingUpdate({
    chatId: 940002,
    chatType: 'private',
    callbackQueryId: 'cb_once_only_999',
    senderTelegramId: 940002,
    firstName: 'Tesfaye',
    username: 'u_940002',
    callbackData: 'cb:deposit_amount:50',
  });
  assert.equal(dupCb1.ok, true);
  const dupCb2 = await botService.handleIncomingUpdate({
    chatId: 940002,
    chatType: 'private',
    callbackQueryId: 'cb_once_only_999',
    senderTelegramId: 940002,
    firstName: 'Tesfaye',
    username: 'u_940002',
    callbackData: 'cb:deposit_amount:50',
  });
  assert.equal(dupCb2.ok, false);
  assert.equal(dupCb2.securityCode, 'duplicate_callback_query');
});

// ============================================================================
// TEST 5: Identical Player Experience (Inviter vs Invited), All Game Timers,
//         Automatic Transitions, Concurrent Sessions, and Permission Boundaries
// ============================================================================
test('Audit Repair 5: Inviter and invited players share identical rooms/timers/balls; full server-authoritative timer lifecycle never stalls at 00:00; admin permissions enforced', async () => {
  const { db, store: rawStore } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const gameStore = createFirestoreGameStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const gameService = new PersistentGameAuthorityService(gameStore, replay);

  // Provision phone-verified inviter (950001), invited player (950002), and 3rd player (950003)
  await tgStore.savePlayerAndBinding({ telegramUserId: 950001, firstName: 'Inviter', username: 'inv_a', language: 'am' });
  await tgStore.savePlayerAndBinding({ telegramUserId: 950002, firstName: 'Invited', username: 'inv_b', language: 'am' });
  await tgStore.processReferralDeepLink!({
    inviteeTelegramId: 950002,
    inviteeName: 'Invited',
    inviteeUsername: 'inv_b',
    referralCode: 'ADEY-950001',
  });
  await tgStore.savePlayerAndBinding({ telegramUserId: 950003, firstName: 'Third', username: 'plr_c', language: 'am' });
  for (const uid of ['tg_950001', 'tg_950002', 'tg_950003']) {
    rawStore.set(`users/${uid}`, { ...(rawStore.get(`users/${uid}`) || {}), phoneVerified: true });
  }

  const makeAuthDeps = (): AuthBackendDeps => ({
    verifyIdToken: async (tok: string): Promise<DecodedIdTokenLike> => {
      if (tok === 'tok_inviter') {
        return { uid: 'tg_950001', telegram_id: 950001, telegram_verified: true, name: 'Inviter' };
      }
      if (tok === 'tok_invited') {
        return { uid: 'tg_950002', telegram_id: 950002, telegram_verified: true, name: 'Invited' };
      }
      if (tok === 'tok_third') {
        return { uid: 'tg_950003', telegram_id: 950003, telegram_verified: true, name: 'Third' };
      }
      if (tok === 'tok_admin') {
        return { uid: 'tg_8842109', telegram_id: 8842109, telegram_verified: true, name: 'Owner' };
      }
      throw new Error('Invalid token');
    },
    isAdminUid: async (uid: string) => uid === 'tg_8842109',
  });

  const authDeps = makeAuthDeps();
  const roomsHandler = createRoomsHandler({ getDb: () => db, authDeps });
  const reserveHandler = createReserveCardHandler({ getDb: () => db, authDeps });
  const playerStateHandler = createPlayerStateHandler({ getDb: () => db, authDeps });
  const adminOverviewHandler = createAdminOverviewHandler({ getDb: () => db, authDeps });
  const drawBallHandler = createDrawBallHandler({ getDb: () => db, authDeps });

  // 1. Inviter and Invited player see IDENTICAL rooms, prices, timers, and status
  const invRoomsRes = makeRes();
  await roomsHandler(makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_inviter' } }), invRoomsRes.res);
  const invitedRoomsRes = makeRes();
  await roomsHandler(makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_invited' } }), invitedRoomsRes.res);
  assert.equal(invRoomsRes.getStatus(), 200);
  assert.equal(invitedRoomsRes.getStatus(), 200);
  const invRooms = invRoomsRes.getBody().rooms as Array<Record<string, unknown>>;
  const invitedRooms = invitedRoomsRes.getBody().rooms as Array<Record<string, unknown>>;
  assert.equal(invRooms.length, invitedRooms.length);
  for (let i = 0; i < invRooms.length; i++) {
    assert.equal(invRooms[i].roomId, invitedRooms[i].roomId);
    assert.equal(invRooms[i].cardPrice, invitedRooms[i].cardPrice);
    assert.equal(invRooms[i].status, invitedRooms[i].status);
    assert.equal(invRooms[i].registrationDeadlineMs, invitedRooms[i].registrationDeadlineMs);
    assert.ok(Number(invRooms[i].registrationDeadlineMs) > 0, 'Registration deadline must be initialized');
  }

  // Only account-specific state differs (name, balance, referral code)
  const invStateRes = makeRes();
  await playerStateHandler(makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_inviter' } }), invStateRes.res);
  const invitedStateRes = makeRes();
  await playerStateHandler(makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_invited' } }), invitedStateRes.res);
  assert.equal((invStateRes.getBody().wallet as Record<string, unknown>).availableBalanceEtb, 35);
  assert.equal((invitedStateRes.getBody().wallet as Record<string, unknown>).availableBalanceEtb, 15);
  assert.equal((invStateRes.getBody().profile as Record<string, unknown>).referralCode, 'ADEY-950001');
  assert.equal((invitedStateRes.getBody().profile as Record<string, unknown>).referralCode, 'ADEY-950002');

  // 2. Concurrent card reservations by inviter & invited player (2 players < minPlayers 3)
  const [res1, res2] = await Promise.all([
    (async () => {
      const r = makeRes();
      await reserveHandler(
        makeReq({
          headers: { authorization: 'Bearer tok_inviter' },
          body: { roomId: 'adey-main', cardId: 10 },
        }),
        r.res
      );
      return r;
    })(),
    (async () => {
      const r = makeRes();
      await reserveHandler(
        makeReq({
          headers: { authorization: 'Bearer tok_invited' },
          body: { roomId: 'adey-main', cardId: 20 },
        }),
        r.res
      );
      return r;
    })(),
  ]);
  assert.equal(res1.getStatus(), 200);
  assert.equal(res2.getStatus(), 200);

  // 3. Registration deadline expires with only 2 players -> automatic registration extension (cards preserved!)
  const roomDoc1 = rawStore.get('rooms/adey-main')!;
  const expiredTime1 = Number(roomDoc1.registrationDeadlineMs) + 1000;
  const extTick = await gameService.tickRoomScheduler({
    roomId: 'adey-main',
    nowMs: expiredTime1,
    workerId: 'test_worker',
  });
  assert.equal(extTick.action, 'registration_extended');
  assert.equal(extTick.status, 'countdown');
  assert.equal(extTick.confirmedPlayersCount, 2);
  assert.ok(extTick.registrationDeadlineMs > expiredTime1, 'Extended registration deadline must be in the future (never stuck at 00:00)');

  // 4. 3rd player reserves card -> registration expires -> AUTOMATICALLY transitions to live game!
  const res3 = makeRes();
  await reserveHandler(
    makeReq({
      headers: { authorization: 'Bearer tok_third' },
      body: { roomId: 'adey-main', cardId: 30 },
    }),
    res3.res
  );
  assert.equal(res3.getStatus(), 200);

  const startTime = extTick.registrationDeadlineMs + 500;
  const startTick = await gameService.tickRoomScheduler({
    roomId: 'adey-main',
    nowMs: startTime,
    workerId: 'test_worker',
  });
  assert.equal(startTick.action, 'game_auto_started');
  assert.equal(startTick.status, 'live');
  assert.equal(startTick.calledNumbers?.length, 1);
  assert.ok(startTick.nextBallDrawAtMs > startTime);

  // 5. Premature tick BEFORE nextBallDrawAtMs -> NOOP (prevents premature or duplicate draws)
  const earlyTick = await gameService.tickRoomScheduler({
    roomId: 'adey-main',
    nowMs: startTime + 500,
    workerId: 'test_worker',
  });
  assert.equal(earlyTick.action, 'noop');

  // 6. Advance live ball draws until winner auto-settled; verify NO duplicate balls & valid intermission timer
  let cursorNow = startTick.nextBallDrawAtMs + 50;
  let settledTick = startTick;
  for (let step = 0; step < 80; step++) {
    const tick = await gameService.tickRoomScheduler({
      roomId: 'adey-main',
      nowMs: cursorNow,
      workerId: 'test_worker',
    });
    if (tick.calledNumbers) {
      assert.equal(
        new Set(tick.calledNumbers).size,
        tick.calledNumbers.length,
        'Called numbers must never contain duplicates'
      );
    }
    if (tick.action === 'winner_auto_settled') {
      settledTick = tick;
      break;
    }
    cursorNow = (tick.nextBallDrawAtMs || cursorNow + 3000) + 50;
  }
  assert.equal(settledTick.action, 'winner_auto_settled');
  assert.equal(settledTick.status, 'completed');
  assert.ok(settledTick.intermissionEndsAtMs > cursorNow, 'Intermission deadline must be set after completion');

  // Verify verified players keep phoneVerified: true and unverified players are never auto-verified
  for (const uid of ['tg_950001', 'tg_950002', 'tg_950003']) {
    assert.equal(rawStore.get(`users/${uid}`)?.phoneVerified, true);
  }

  // 7. During intermission -> stays completed; once intermission expires -> AUTOMATICALLY creates next round!
  const duringIntermission = await gameService.tickRoomScheduler({
    roomId: 'adey-main',
    nowMs: cursorNow + 500,
    workerId: 'test_worker',
  });
  assert.equal(duringIntermission.action, 'noop');
  assert.equal(duringIntermission.status, 'completed');

  const nextRoundTime = settledTick.intermissionEndsAtMs + 500;
  const nextRoundTick = await gameService.tickRoomScheduler({
    roomId: 'adey-main',
    nowMs: nextRoundTime,
    workerId: 'test_worker',
  });
  assert.equal(nextRoundTick.action, 'next_game_auto_created');
  assert.equal(nextRoundTick.status, 'countdown');
  assert.equal(nextRoundTick.roundNumber, 2);
  assert.ok(nextRoundTick.registrationDeadlineMs > nextRoundTime);

  // 8. Admin vs Player permission boundaries: inviter & invited get 403 on admin & draw endpoints
  const playerAdminTry = makeRes();
  await adminOverviewHandler(
    makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_invited' } }),
    playerAdminTry.res
  );
  assert.equal(playerAdminTry.getStatus(), 403);

  const playerDrawTry = makeRes();
  await drawBallHandler(
    makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer tok_inviter' },
      body: { roomId: 'adey-main' },
    }),
    playerDrawTry.res
  );
  assert.equal(playerDrawTry.getStatus(), 403);

  // Verified Admin receives 200 on admin overview
  const adminOkRes = makeRes();
  await adminOverviewHandler(
    makeReq({ method: 'GET', headers: { authorization: 'Bearer tok_admin' } }),
    adminOkRes.res
  );
  assert.equal(adminOkRes.getStatus(), 200);

  // Scheduler endpoint works with CRON_SECRET when no player is actively viewing
  const schedulerHandler = createSchedulerTickHandler({
    getDb: () => db,
    authDeps,
    getCronSecret: () => 'audit_cron_secret_1234',
  });
  const cronRes = makeRes();
  await schedulerHandler(
    makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer audit_cron_secret_1234' },
      body: { roomId: 'adey-main' },
    }),
    cronRes.res
  );
  assert.equal(cronRes.getStatus(), 200);
});

// ============================================================================
// TEST 6: Confirmed Defect Regressions — Language Selection Account Isolation,
//         Telegram Delivery Failure Reporting, Client Contact Forgery Rejection,
//         and Cross-Channel Referral Idempotency (Bot /start + Mini App Auth)
// ============================================================================
test('Audit Repair 6: Confirmed defect regressions (language isolation, webhook failure accuracy, bot-command contact block, cross-channel referral idempotency)', async () => {
  const { db, store: rawStore } = createInMemoryFirestore();
  const tgStore = createFirestoreTelegramStore(db);
  const replay = new PersistentReplayGuard(createFirestoreReplayAdapter(db));
  const botService = new PersistentTelegramBotService(tgStore, replay, 'https://adebingo-3nta.vercel.app/');

  // 1. Language selection for an unregistered user must NOT create a player account, balance, or tx
  const langRes = await botService.handleIncomingUpdate({
    updateId: 880001,
    callbackQueryId: 'cb_lang_unreg_1',
    senderTelegramId: 990001,
    chatId: 990001,
    chatType: 'private',
    firstName: 'UnregUser',
    username: 'unreg_user',
    callbackData: 'lang:en',
  });
  assert.equal(langRes.ok, true);
  assert.equal(langRes.language, 'en');
  assert.equal(langRes.registrationStatus, 'unregistered');
  assert.equal(rawStore.has('botPlayers/990001'), false, 'setLanguage must not create botPlayers doc');
  assert.equal(rawStore.has('users/tg_990001'), false, 'setLanguage must not create users doc');
  assert.equal(rawStore.has('transactions/tx_init_tg_990001'), false, 'setLanguage must not create initial bonus tx');

  // Direct store.setLanguage on unregistered user also creates zero docs
  await tgStore.setLanguage(990002, 'en');
  assert.equal(rawStore.has('botPlayers/990002'), false);
  assert.equal(rawStore.has('users/tg_990002'), false);

  // Language selection for an EXISTING registered user updates both botPlayers & users
  await tgStore.savePlayerAndBinding({
    telegramUserId: 990003,
    firstName: 'ExistingPlayer',
    username: 'existing_p',
    language: 'am',
  });
  await tgStore.setLanguage(990003, 'en');
  assert.equal(rawStore.get('botPlayers/990003')?.language, 'en');
  assert.equal(rawStore.get('users/tg_990003')?.language, 'en');

  // 2. Webhook accurately reports Telegram API failure if secondary inline message fails on verified /start
  await tgStore.savePlayerAndBinding({
    telegramUserId: 990004,
    firstName: 'DeliveryTest',
    username: 'deliv_test',
    language: 'am',
  });
  rawStore.set('botPlayers/990004', { ...(rawStore.get('botPlayers/990004') || {}), phoneVerified: true });
  rawStore.set('users/tg_990004', { ...(rawStore.get('users/tg_990004') || {}), phoneVerified: true });
  let callNum = 0;
  const failSecondFetch = (async () => {
    callNum += 1;
    if (callNum === 1) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return {
      ok: false,
      json: async () => ({ ok: false, description: 'Bad Request: inline failed' }),
    };
  }) as unknown as typeof fetch;

  const failingWebhook = createTelegramWebhookHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    getWebhookSecret: () => TEST_WEBHOOK_SECRET,
    fetchImpl: failSecondFetch,
    limiter: new BoundedRateLimiter(),
  });
  const failRes = makeRes();
  await failingWebhook(
    makeReq({
      headers: { 'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET },
      body: {
        update_id: 880002,
        message: {
          chat: { id: 990004, type: 'private' },
          from: { id: 990004, first_name: 'DeliveryTest', username: 'deliv_test' },
          text: '/start',
        },
      },
    }),
    failRes.res
  );
  assert.equal(failRes.getStatus(), 200);
  assert.equal(failRes.getBody().deliveredToTelegramApi, false);
  assert.match(String(failRes.getBody().telegramDeliveryNote), /inline failed/i);

  // 3. Client-forged contact payload on /api/telegram/bot-command is blocked with 403
  const authDeps: AuthBackendDeps = {
    verifyIdToken: async (tok: string): Promise<DecodedIdTokenLike> => {
      if (tok === 'tok_990003') {
        return {
          uid: 'tg_990003',
          telegram_id: 990003,
          telegram_verified: true,
          name: 'ExistingPlayer',
        };
      }
      throw new Error('invalid token');
    },
    isAdminUid: async () => false,
  };
  const botCmdHandler = createBotCommandHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const forgedContactRes = makeRes();
  await botCmdHandler(
    makeReq({
      headers: { authorization: 'Bearer tok_990003' },
      body: {
        text: '',
        contact: { phone_number: '+251911000111', first_name: 'ExistingPlayer', user_id: 990003 },
      },
    }),
    forgedContactRes.res
  );
  assert.equal(forgedContactRes.getStatus(), 403);
  assert.equal(forgedContactRes.getBody().reason, 'native_telegram_contact_required');
  assert.equal(rawStore.get('users/tg_990003')?.phoneVerified, false);

  // 4. Cross-channel referral idempotency: Bot /start ADEY-... followed by Mini App /api/telegram/auth with same start_param
  await tgStore.savePlayerAndBinding({
    telegramUserId: 991001,
    firstName: 'InviterCross',
    username: 'inviter_cross',
    language: 'am',
  });

  // Step A: Brand-new invitee joins via Bot /start ADEY-991001
  const botRefStart = await botService.handleIncomingUpdate({
    updateId: 880010,
    senderTelegramId: 991002,
    chatId: 991002,
    chatType: 'private',
    firstName: 'InviteeCross',
    username: 'invitee_cross',
    text: '/start ADEY-991001',
  });
  assert.equal(botRefStart.ok, true);
  assert.equal(rawStore.get('users/tg_991001')?.demoBalanceEtb, 35);
  assert.equal(rawStore.get('users/tg_991002')?.demoBalanceEtb, 15);

  // Step B: Same invitee then opens Mini App /api/telegram/auth with start_param=ADEY-991001
  const nowUnix = Math.floor(Date.now() / 1000);
  const authHandler = createTelegramAuthHandler({
    getDb: () => db,
    getBotToken: () => TEST_BOT_TOKEN,
    nowUnixSeconds: () => nowUnix,
    mintCustomToken: async ({ telegramUserId }) => ({
      uid: `tg_${telegramUserId}`,
      customToken: `custom_${telegramUserId}`,
    }),
    limiter: new BoundedRateLimiter(),
  });
  const miniAppRes = makeRes();
  await authHandler(
    makeReq({
      body: {
        initData: buildSignedInitData(
          TEST_BOT_TOKEN,
          { id: 991002, first_name: 'InviteeCross', username: 'invitee_cross' },
          nowUnix,
          'ADEY-991001'
        ),
      },
    }),
    miniAppRes.res
  );
  assert.equal(miniAppRes.getStatus(), 200);
  assert.equal((miniAppRes.getBody().referralApplied as { applied?: boolean })?.applied, false);
  // Inviter still has exactly 35 ETB (NO duplicate +20 ETB!) and exactly ONE referral tx
  assert.equal(rawStore.get('users/tg_991001')?.demoBalanceEtb, 35);
  assert.equal(rawStore.get('botPlayers/991001')?.demoBalanceEtb, 35);
  assert.equal(rawStore.get('users/tg_991002')?.demoBalanceEtb, 15);
  const refTxCount = Array.from(rawStore.entries()).filter(
    ([k, v]) => k.startsWith('transactions/') && v.type === 'referral_bonus' && v.userId === 'tg_991001'
  ).length;
  assert.equal(refTxCount, 1);

  // Step C: Existing user who previously registered WITHOUT referral opens Mini App with start_param=ADEY-991001 -> NOT eligible!
  const returningMiniAppRes = makeRes();
  await authHandler(
    makeReq({
      body: {
        initData: buildSignedInitData(
          TEST_BOT_TOKEN,
          { id: 990003, first_name: 'ExistingPlayer', username: 'existing_p' },
          nowUnix + 1,
          'ADEY-991001'
        ),
      },
    }),
    returningMiniAppRes.res
  );
  assert.equal(returningMiniAppRes.getStatus(), 200);
  assert.equal(
    (returningMiniAppRes.getBody().referralApplied as { applied?: boolean; reason?: string })?.applied,
    false
  );
  assert.equal(
    (returningMiniAppRes.getBody().referralApplied as { reason?: string })?.reason,
    'existing_account_not_eligible'
  );
  assert.equal(rawStore.get('users/tg_991001')?.demoBalanceEtb, 35);

  // Step D: Existing user who previously registered WITHOUT referral also cannot retroactively claim via POST /api/player/wallet apply_promo!
  const walletHandler = createPlayerWalletHandler({
    getDb: () => db,
    authDeps,
    limiter: new BoundedRateLimiter(),
  });
  const retroPromoRes = makeRes();
  await walletHandler(
    makeReq({
      headers: { authorization: 'Bearer tok_990003' },
      body: { action: 'apply_promo', code: 'ADEY-991001', idempotencyKey: 'retro_ref_attempt_1' },
    }),
    retroPromoRes.res
  );
  assert.equal(retroPromoRes.getStatus(), 409);
  assert.equal(retroPromoRes.getBody().reason, 'existing_account_not_eligible');
  assert.equal(rawStore.get('users/tg_991001')?.demoBalanceEtb, 35);
  assert.equal(rawStore.get('botPlayers/991001')?.demoBalanceEtb, 35);
});
