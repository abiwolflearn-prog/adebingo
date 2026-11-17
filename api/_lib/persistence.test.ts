import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  FIREBASE_DATABASE_ID,
  FIREBASE_PROJECT_ID,
  getAdminAuth,
  getAdminDb,
  getFirebaseAdminApp,
  getTelegramFirebaseUid,
  isFirebaseAdminConfigured,
  parseServiceAccountKey,
} from './firebaseAdmin.ts';
import {
  createFirestoreReplayAdapter,
  PersistentReplayGuard,
  REPLAY_GUARDS_COLLECTION,
} from './replayGuard.ts';
import {
  BOT_OUTBOX_COLLECTION,
  BOT_PLAYERS_COLLECTION,
  BOT_UPDATE_REPLAY_TTL_SECONDS,
  createFirestoreTelegramStore,
  PersistentTelegramBotService,
  verifyTelegramInitDataPersistent,
} from './telegramPersistence.ts';
import {
  createFirestoreGameStore,
  PersistentGameAuthorityService,
} from './gamePersistence.ts';
import {
  checkCardWin,
  generateDeterministicCard,
} from '../../src/game/rules.ts';

function buildSignedInitData(
  botToken: string,
  authDate: number,
  userObj: Record<string, unknown> = {
    id: 778899,
    first_name: 'Selam',
    last_name: 'Tadesse',
    username: 'selam_addis',
    language_code: 'am',
  },
  queryId = 'AAHdF6IQAAAAAN0XohDhrOrc'
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', queryId);
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

type DocData = Record<string, unknown>;

/**
 * Transactional in-memory Firestore harness that mirrors Cloud Firestore semantics:
 * - Serializes transactions under concurrent `Promise.all` contention.
 * - Strictly enforces Firestore's read-before-write transaction rule: any `tx.get()`
 *   after `tx.set()`, `tx.update()`, or `tx.delete()` throws an error.
 */
function createInMemoryFirestoreHarness() {
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
    const constructorName = (val as { constructor?: { name?: string } }).constructor?.name;
    if (constructorName === 'FieldValue' || constructorName === 'ServerTimestampTransform') {
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
        if (!current) {
          throw new Error(`Document does not exist: ${path}`);
        }
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
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    };
  }

  function makeCollectionRef(colPath: string) {
    const q = makeQuery(colPath);
    return {
      ...q,
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
          ops.push(() => {
            store.delete(ref.path);
          });
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
              if (!current) {
                throw new Error(`Document missing during tx.update: ${ref.path}`);
              }
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
        for (const write of pendingWrites) {
          write();
        }
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

test('Firestore harness enforces strict read-before-write transaction ordering', async () => {
  const { db } = createInMemoryFirestoreHarness();
  await assert.rejects(
    () =>
      db.runTransaction(async (tx) => {
        tx.set(db.collection('users').doc('tg_1'), { uid: 'tg_1' });
        await tx.get(db.collection('users').doc('tg_2'));
      }),
    /Firestore transactions require all reads to be executed before all writes/
  );
});

test('Firebase Admin parsing, escaped newline support, UID derivation, and singleton initialization', (t) => {
  const prevEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  t.after(() => {
    if (prevEnv === undefined) {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    } else {
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevEnv;
    }
  });

  assert.equal(parseServiceAccountKey(undefined), null);
  assert.equal(parseServiceAccountKey('   '), null);
  assert.equal(parseServiceAccountKey('{not-json'), null);
  assert.equal(parseServiceAccountKey(JSON.stringify({ project_id: FIREBASE_PROJECT_ID })), null);

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const escapedKey = privateKey.replace(/\n/g, '\\n');

  const rawJson = JSON.stringify({
    type: 'service_account',
    project_id: FIREBASE_PROJECT_ID,
    client_email: `firebase-adminsdk@${FIREBASE_PROJECT_ID}.iam.gserviceaccount.com`,
    private_key: escapedKey,
  });

  const parsedRaw = parseServiceAccountKey(rawJson);
  assert.ok(parsedRaw);
  assert.equal(parsedRaw.projectId, FIREBASE_PROJECT_ID);
  assert.ok(parsedRaw.privateKey?.includes('\n'));
  assert.equal(parsedRaw.privateKey?.includes('\\n'), false);

  const b64 = Buffer.from(rawJson, 'utf8').toString('base64');
  const parsedB64 = parseServiceAccountKey(b64);
  assert.ok(parsedB64);
  assert.equal(parsedB64.clientEmail, parsedRaw.clientEmail);
  assert.equal(parsedB64.privateKey, parsedRaw.privateKey);

  assert.equal(getTelegramFirebaseUid(10023456), 'tg_10023456');
  assert.throws(() => getTelegramFirebaseUid(0), RangeError);
  assert.throws(() => getTelegramFirebaseUid(-15), RangeError);
  assert.throws(() => getTelegramFirebaseUid(12.5), RangeError);
  assert.throws(() => getTelegramFirebaseUid(Number.NaN), RangeError);

  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = rawJson;
  assert.equal(isFirebaseAdminConfigured(), true);
  const app1 = getFirebaseAdminApp();
  const app2 = getFirebaseAdminApp();
  assert.equal(app1, app2);
  assert.equal(app1.options.projectId, FIREBASE_PROJECT_ID);

  const auth = getAdminAuth();
  assert.ok(auth);
  const db = getAdminDb();
  assert.equal(db.databaseId, FIREBASE_DATABASE_ID);
});

test('PersistentReplayGuard blocks reuse, survives concurrent Promise.all races, and supports TTL cleanup', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const adapter = createFirestoreReplayAdapter(db);
  const guard = new PersistentReplayGuard(adapter, 600);

  const invalid = await guard.consumeOnce('init_data', '   ');
  assert.equal(invalid.fresh, false);
  assert.equal(invalid.reason, 'invalid_key');

  const t0 = 1_750_000_000;
  const first = await guard.consumeOnce('init_data', 'hash_abc_123', {
    nowUnixSeconds: t0,
    ttlSeconds: 300,
  });
  assert.equal(first.fresh, true);
  assert.ok(first.keyHash);
  assert.equal(store.has(`${REPLAY_GUARDS_COLLECTION}/${first.keyHash}`), true);

  const secondGuardInstance = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 600);
  const replay = await secondGuardInstance.consumeOnce('init_data', 'hash_abc_123', {
    nowUnixSeconds: t0 + 10,
    ttlSeconds: 300,
  });
  assert.equal(replay.fresh, false);
  assert.equal(replay.reason, 'replay_detected');

  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, () =>
      guard.consumeOnce('tg_update', 'update_999001', {
        nowUnixSeconds: t0 + 15,
        ttlSeconds: 300,
      })
    )
  );
  assert.equal(concurrentResults.filter((r) => r.fresh).length, 1);
  assert.equal(
    concurrentResults.filter((r) => !r.fresh && r.reason === 'replay_detected').length,
    9
  );

  const deletedCount = await guard.cleanupExpired(t0 + 400, 50);
  assert.equal(deletedCount, 2);
  assert.equal(store.size, 0);

  const afterExpiry = await guard.consumeOnce('init_data', 'hash_abc_123', {
    nowUnixSeconds: t0 + 401,
    ttlSeconds: 300,
  });
  assert.equal(afterExpiry.fresh, true);
});

test('Persistent Telegram verification & bot store enforce 24h replay protection, private chat checks, safe UID/sender validation, and transaction ordering', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const botToken = '123456:TEST_ADEYBINGO_BOT_TOKEN';
  const nowUnix = Math.floor(Date.now() / 1000);

  assert.ok(BOT_UPDATE_REPLAY_TTL_SECONDS >= 86400);

  const rawInitData = buildSignedInitData(botToken, nowUnix, {
    id: 778899,
    first_name: 'Selam',
    last_name: 'Tadesse',
    username: 'selam_addis',
    language_code: 'am',
  });

  // Concurrent initData verification race against Firestore replay guard: only 1 succeeds
  const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
  const authRace = await Promise.all(
    Array.from({ length: 5 }, () =>
      verifyTelegramInitDataPersistent({
        rawInitData,
        botToken,
        replayGuard,
        nowUnixSeconds: nowUnix + 2,
        maxAgeSeconds: 3600,
      })
    )
  );
  assert.equal(authRace.filter((r) => r.valid).length, 1);
  assert.equal(authRace.filter((r) => !r.valid && r.reason === 'replay_detected').length, 4);

  // Subsequent call with the same initData is still blocked (no actionNonce bypass)
  const reuseInitData = await verifyTelegramInitDataPersistent({
    rawInitData,
    botToken,
    replayGuard,
    nowUnixSeconds: nowUnix + 5,
    maxAgeSeconds: 3600,
  });
  assert.equal(reuseInitData.valid, false);
  assert.equal(reuseInitData.reason, 'replay_detected');

  // Expired initData is rejected before touching replay store
  const expiredInitData = buildSignedInitData(botToken, nowUnix - 7200, {
    id: 778899,
    first_name: 'Selam',
  });
  const expiredRes = await verifyTelegramInitDataPersistent({
    rawInitData: expiredInitData,
    botToken,
    replayGuard,
    nowUnixSeconds: nowUnix,
    maxAgeSeconds: 3600,
  });
  assert.equal(expiredRes.valid, false);
  assert.equal(expiredRes.reason, 'expired_auth_date');

  const botStoreA = createFirestoreTelegramStore(db);
  const botA = new PersistentTelegramBotService(
    botStoreA,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600)
  );

  // Unsafe sender IDs and unsafe UID overrides are rejected
  for (const badId of [0, -42, 12.5, Number.NaN]) {
    const badRes = await botA.handleIncomingUpdate({
      senderTelegramId: badId,
      chatType: 'private',
      text: '/start',
      nowUnixSeconds: nowUnix,
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.securityCode, 'invalid_telegram_user_id');

    await assert.rejects(() => botStoreA.getPlayer(badId), RangeError);
  }

  const mismatchedUidRes = await botStoreA.savePlayerAndBinding({
    telegramUserId: 778899,
    uid: 'rogue_uid',
    firstName: 'Selam',
    username: 'selam_addis',
    language: 'am',
  });
  assert.equal(mismatchedUidRes.ok, false);
  assert.equal(mismatchedUidRes.reason, 'invalid_uid');

  // Non-private chat (group or mismatched chatId) rejected for /start and contact verification
  const groupStart = await botA.handleIncomingUpdate({
    updateId: 4998,
    senderTelegramId: 778899,
    chatId: -100999888,
    chatType: 'group',
    text: '/start',
    nowUnixSeconds: nowUnix,
  });
  assert.equal(groupStart.ok, false);
  assert.equal(groupStart.securityCode, 'private_chat_required');

  const groupContact = await botA.handleIncomingUpdate({
    updateId: 4999,
    senderTelegramId: 778899,
    chatId: 999999,
    chatType: 'private',
    contact: { phone_number: '+251911223344', user_id: 778899 },
    nowUnixSeconds: nowUnix,
  });
  assert.equal(groupContact.ok, false);
  assert.equal(groupContact.securityCode, 'private_chat_required');

  // 1. /start in private chat persists botPlayers, telegramBindings, and users/{uid}
  const startRes = await botA.handleIncomingUpdate({
    updateId: 5001,
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    firstName: 'Selam',
    lastName: 'Tadesse',
    username: 'selam_addis',
    text: '/start',
    nowUnixSeconds: nowUnix,
  });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.language, 'am');
  assert.equal(store.has(`${BOT_PLAYERS_COLLECTION}/778899`), true);
  assert.equal(store.get('telegramBindings/tg_778899')?.uid, 'tg_778899');
  assert.equal(store.get('users/tg_778899')?.demoBalanceEtb, 250);

  // 2. Replayed updateId blocked even 12 hours later (< 24h TTL) on a fresh instance
  const botB = new PersistentTelegramBotService(
    createFirestoreTelegramStore(db),
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600)
  );
  const replayUpdate = await botB.handleIncomingUpdate({
    updateId: 5001,
    senderTelegramId: 778899,
    chatType: 'private',
    text: '/help',
    nowUnixSeconds: nowUnix + 12 * 3600,
  });
  assert.equal(replayUpdate.ok, false);
  assert.equal(replayUpdate.securityCode, 'replay_detected');

  // 3. Language toggle obeys strict read-before-write transaction ordering & persists
  const langRes = await botB.handleIncomingUpdate({
    updateId: 5002,
    senderTelegramId: 778899,
    chatType: 'private',
    callbackData: 'lang:en',
    nowUnixSeconds: nowUnix + 2,
  });
  assert.equal(langRes.ok, true);
  assert.equal(langRes.language, 'en');
  assert.equal(store.get('users/tg_778899')?.language, 'en');
  assert.equal(store.get(`${BOT_PLAYERS_COLLECTION}/778899`)?.language, 'en');

  const botC = new PersistentTelegramBotService(
    createFirestoreTelegramStore(db),
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600)
  );
  const helpRes = await botC.handleIncomingUpdate({
    updateId: 5003,
    senderTelegramId: 778899,
    chatType: 'private',
    text: '/help',
    nowUnixSeconds: nowUnix + 3,
  });
  assert.equal(helpRes.language, 'en');

  // 4. Plain-text phone & spoofed third-party contact rejected
  const plainPhone = await botC.handleIncomingUpdate({
    updateId: 5004,
    senderTelegramId: 778899,
    chatType: 'private',
    text: '+251911223344',
    nowUnixSeconds: nowUnix + 4,
  });
  assert.equal(plainPhone.ok, false);
  assert.equal(plainPhone.securityCode, 'plain_text_phone_rejected');

  const thirdPartyContact = await botC.handleIncomingUpdate({
    updateId: 5005,
    senderTelegramId: 778899,
    chatType: 'private',
    contact: { phone_number: '+251911223344', user_id: 999999 },
    nowUnixSeconds: nowUnix + 5,
  });
  assert.equal(thirdPartyContact.ok, false);
  assert.equal(thirdPartyContact.securityCode, 'contact_owner_mismatch');

  // 5. Authentic private contact persists PII & queues UUID-keyed outbox notification
  const verifiedContact = await botC.handleIncomingUpdate({
    updateId: 5006,
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    firstName: 'Selam',
    lastName: 'Tadesse',
    username: 'selam_addis',
    contact: { phone_number: '+251911223344', user_id: 778899 },
    nowUnixSeconds: nowUnix + 6,
  });
  assert.equal(verifiedContact.ok, true);
  assert.equal(verifiedContact.securityCode, 'contact_verified');
  assert.equal(store.get('users/tg_778899/private/contact')?.phoneNumber, '+251911223344');
  assert.equal(store.get('users/tg_778899')?.phoneVerified, true);

  const outbox = await createFirestoreTelegramStore(db).listNotifications(10);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].event, 'registration_success');
  assert.match(
    outbox[0].id,
    /^ntf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  assert.equal(store.has(`${BOT_OUTBOX_COLLECTION}/${outbox[0].id}`), true);

  // 6. Existing binding for another UID blocks cross-account takeover
  store.set('telegramBindings/tg_889900', { telegramUserId: 'tg_889900', uid: 'other_uid' });
  const hijackedAttempt = await botStoreA.savePlayerAndBinding({
    telegramUserId: 889900,
    firstName: 'Victim',
    username: 'victim',
    language: 'am',
  });
  assert.equal(hijackedAttempt.ok, false);
  assert.equal(hijackedAttempt.reason, 'duplicate_telegram_account');
});

test('PersistentGameAuthorityService enforces concurrent 4-card cap, balance/ledger atomicity, live-room lock, missing winner guard, and deterministic win IDs', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const gameStore = createFirestoreGameStore(db);
  const gameService = new PersistentGameAuthorityService(
    gameStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );

  // Concurrent ensureDefaultRooms() calls never overwrite existing room state
  await Promise.all([
    gameStore.ensureDefaultRooms(),
    gameStore.ensureDefaultRooms(),
    gameStore.ensureDefaultRooms(),
  ]);
  assert.equal(store.get('rooms/adey-main')?.status, 'countdown');
  assert.equal(store.get('rooms/addis-express')?.status, 'live');

  const roomId = 'adey-main';
  const gameId = 'game_adey-main_live';
  const hostUid = 'tg_1001';
  const player2Uid = 'tg_2002';
  const brokeUid = 'tg_3003';
  const ghostUid = 'tg_4004';

  store.set(`users/${hostUid}`, {
    uid: hostUid,
    telegramUserId: hostUid,
    displayName: 'Dawit Host',
    username: '@dawit',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 250,
  });
  store.set(`users/${player2Uid}`, {
    uid: player2Uid,
    telegramUserId: player2Uid,
    displayName: 'Marta Player',
    username: '@marta',
    language: 'en',
    phoneVerified: true,
    demoBalanceEtb: 250,
  });
  store.set(`users/${brokeUid}`, {
    uid: brokeUid,
    telegramUserId: brokeUid,
    displayName: 'Broke Player',
    username: '@broke',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 5, // Room cardPrice is 10 ETB
  });

  // Insufficient balance rejected atomically without touching cards or balance
  const insufficientRes = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 50,
    uid: brokeUid,
    displayName: 'Broke Player',
    telegramUserId: brokeUid,
  });
  assert.equal(insufficientRes.ok, false);
  assert.equal(insufficientRes.reason, 'insufficient_balance');
  assert.equal(store.get(`users/${brokeUid}`)?.demoBalanceEtb, 5);
  assert.equal(store.has(`rooms/${roomId}/cards/50`), false);

  // Reservation in an already-live room (addis-express) is rejected
  const liveRoomReserve = await gameService.reserveOrReleaseCard({
    roomId: 'addis-express',
    cardId: 55,
    uid: player2Uid,
    displayName: 'Marta',
    telegramUserId: player2Uid,
  });
  assert.equal(liveRoomReserve.ok, false);
  assert.equal(liveRoomReserve.reason, 'room_already_live');

  // Invalid card IDs rejected
  const invalidLow = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 0,
    uid: player2Uid,
    displayName: 'Marta',
    telegramUserId: player2Uid,
  });
  assert.equal(invalidLow.ok, false);
  assert.equal(invalidLow.reason, 'invalid_card_id');

  const invalidHigh = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 601,
    uid: player2Uid,
    displayName: 'Marta',
    telegramUserId: player2Uid,
  });
  assert.equal(invalidHigh.ok, false);
  assert.equal(invalidHigh.reason, 'invalid_card_id');

  // Concurrent 5-card reservation race -> at most 4 cards reserved & balance atomically deducted (250 - 40 = 210)
  const raceReservations = await Promise.all(
    [11, 12, 13, 14, 15].map((cardId) =>
      gameService.reserveOrReleaseCard({
        roomId,
        cardId,
        uid: player2Uid,
        displayName: 'Marta Player',
        telegramUserId: player2Uid,
      })
    )
  );
  assert.equal(raceReservations.filter((r) => r.ok && r.action === 'reserved').length, 4);
  assert.equal(
    raceReservations.filter((r) => !r.ok && r.reason === 'max_4_cards_reached').length,
    1
  );
  assert.equal(store.get(`users/${player2Uid}`)?.demoBalanceEtb, 210);

  // Another player cannot reserve a card already taken by player2
  const takenCard = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 11,
    uid: hostUid,
    displayName: 'Dawit',
    telegramUserId: hostUid,
  });
  assert.equal(takenCard.ok, false);
  assert.equal(takenCard.reason, 'card_already_taken');

  // Release card 14 -> refunds 10 ETB (210 -> 220), then host reserves card 14 (250 -> 240)
  const released = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 14,
    uid: player2Uid,
    displayName: 'Marta Player',
    telegramUserId: player2Uid,
  });
  assert.equal(released.ok, true);
  assert.equal(released.action, 'released');
  assert.deepEqual(released.cardIds, [11, 12, 13]);
  assert.equal(released.updatedBalanceEtb, 220);

  const hostReserves14 = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 14,
    uid: hostUid,
    displayName: 'Dawit Host',
    telegramUserId: hostUid,
  });
  assert.equal(hostReserves14.ok, true);
  assert.equal(hostReserves14.updatedBalanceEtb, 240);

  // Host draws first ball -> transitions room status to 'live', blocking subsequent reservations/releases
  const firstDraw = await gameService.drawNextBall({
    roomId,
    gameId,
    callerUid: hostUid,
    requestNonce: 'draw-nonce-1',
  });
  assert.equal(firstDraw.ok, true);
  assert.equal(firstDraw.totalCalled, 6);
  assert.equal(store.get(`rooms/${roomId}`)?.status, 'live');

  const reserveAfterLive = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 15,
    uid: player2Uid,
    displayName: 'Marta Player',
    telegramUserId: player2Uid,
  });
  assert.equal(reserveAfterLive.ok, false);
  assert.equal(reserveAfterLive.reason, 'room_already_live');

  const releaseAfterLive = await gameService.reserveOrReleaseCard({
    roomId,
    cardId: 11,
    uid: player2Uid,
    displayName: 'Marta Player',
    telegramUserId: player2Uid,
  });
  assert.equal(releaseAfterLive.ok, false);
  assert.equal(releaseAfterLive.reason, 'room_already_live');

  // Concurrent duplicate draw nonce race -> only 1 accepted
  const nonceRace = await Promise.all(
    Array.from({ length: 5 }, () =>
      gameService.drawNextBall({
        roomId,
        gameId,
        callerUid: hostUid,
        requestNonce: 'draw-nonce-2',
      })
    )
  );
  assert.equal(nonceRace.filter((r) => r.ok).length, 1);
  assert.equal(nonceRace.filter((r) => !r.ok && r.reason === 'replay_detected').length, 4);

  // Non-host caller rejected
  const unauthorizedDraw = await gameService.drawNextBall({
    roomId,
    gameId,
    callerUid: player2Uid,
  });
  assert.equal(unauthorizedDraw.ok, false);
  assert.equal(unauthorizedDraw.reason, 'unauthorized_caller');

  // Claiming unowned card rejected
  const unownedClaim = await gameService.verifyWinner({
    roomId,
    gameId,
    claimantUid: player2Uid,
    playerName: 'Marta',
    cardId: 14,
    markedNumbers: [1, 2, 3, 4],
  });
  assert.equal(unownedClaim.verified, false);
  assert.equal(unownedClaim.reason, 'card_not_owned_by_claimant');

  // Draw all 75 balls cleanly without duplicates
  let latestNumbers = (store.get(`games/${gameId}`)?.calledNumbers as number[]) || [];
  while (latestNumbers.length < 75) {
    const draw = await gameService.drawNextBall({
      roomId,
      gameId,
      callerUid: hostUid,
    });
    assert.equal(draw.ok, true);
    latestNumbers = draw.calledNumbers!;
  }
  assert.equal(latestNumbers.length, 75);
  assert.equal(new Set(latestNumbers).size, 75);

  const exhaustedDraw = await gameService.drawNextBall({
    roomId,
    gameId,
    callerUid: hostUid,
  });
  assert.equal(exhaustedDraw.ok, false);
  assert.equal(exhaustedDraw.reason, 'all_75_numbers_called');

  // Missing winner user profile -> rejected WITHOUT completing game
  store.set(`rooms/${roomId}/players/${ghostUid}`, {
    playerId: ghostUid,
    roomId,
    displayName: 'Ghost',
    telegramUserId: ghostUid,
    cardIds: [19],
  });
  store.set(`rooms/${roomId}/cards/19`, {
    cardId: 19,
    roomId,
    ownerId: ghostUid,
    ownerName: 'Ghost',
    serial: 'ADB-019',
  });
  const card19TopRow = generateDeterministicCard(19).grid[0].filter((n) => n !== 0);
  const ghostClaim = await gameService.verifyWinner({
    roomId,
    gameId,
    claimantUid: ghostUid,
    playerName: 'Ghost',
    cardId: 19,
    markedNumbers: card19TopRow,
  });
  assert.equal(ghostClaim.verified, false);
  assert.equal(ghostClaim.reason, 'winner_profile_not_found');
  assert.equal(store.get(`games/${gameId}`)?.status, 'live');

  // Valid win by player2 on card 11 -> marks game & room completed, credits balance, writes deterministic tx ID
  const card11 = generateDeterministicCard(11);
  const topRowNums = card11.grid[0].filter((n): n is number => n !== null);
  assert.equal(checkCardWin(card11, topRowNums, latestNumbers, true).won, true);

  const legitWin = await gameService.verifyWinner({
    roomId,
    gameId,
    claimantUid: player2Uid,
    playerName: 'Marta Player',
    cardId: 11,
    markedNumbers: topRowNums,
  });
  assert.equal(legitWin.verified, true);
  assert.ok((legitWin.demoPrizeEtb ?? 0) >= 50);

  const completedGame = store.get(`games/${gameId}`);
  assert.equal(completedGame?.status, 'completed');
  assert.equal(completedGame?.winnerUid, player2Uid);
  assert.equal(completedGame?.winningCardId, 11);
  assert.equal(store.get(`rooms/${roomId}`)?.status, 'completed');

  const updatedBalance = Number(store.get(`users/${player2Uid}`)?.demoBalanceEtb);
  assert.equal(updatedBalance, 220 + (legitWin.demoPrizeEtb ?? 0));

  const deterministicTxId = `tx_win_${gameId}_r1`;
  assert.equal(store.has(`transactions/${deterministicTxId}`), true);
  assert.equal(store.get(`transactions/${deterministicTxId}`)?.type, 'bingo_win');
  assert.equal(store.get(`transactions/${deterministicTxId}`)?.userId, player2Uid);

  // Duplicate win claim on completed game is rejected
  const duplicateWin = await gameService.verifyWinner({
    roomId,
    gameId,
    claimantUid: player2Uid,
    playerName: 'Marta Player',
    cardId: 11,
    markedNumbers: topRowNums,
  });
  assert.equal(duplicateWin.verified, false);
  assert.equal(duplicateWin.reason, 'game_already_completed');

  // Reset round increments roundNumber so Round 2 uses deterministic tx_win_${gameId}_r2
  const resetRes = await gameService.resetRound({
    roomId,
    gameId,
    callerUid: hostUid,
  });
  assert.equal(resetRes.ok, true);
  assert.equal(store.get(`games/${gameId}`)?.roundNumber, 2);
  assert.equal(store.get(`rooms/${roomId}`)?.status, 'countdown');
});

test('Milestone 4.2: PersistentTelegramBotService handles all 7 inline callbacks from real Firestore data, blocks /admin in player bot, and rejects duplicate callbackQueryId', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const botStore = createFirestoreTelegramStore(db);
  const bot = new PersistentTelegramBotService(
    botStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600)
  );
  const nowUnix = Math.floor(Date.now() / 1000);

  // Seed user & completed game + transaction for real game history / wallet
  await bot.handleIncomingUpdate({
    updateId: 7000,
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    firstName: 'Selam',
    lastName: 'Tadesse',
    username: 'selam_addis',
    text: '/start',
    nowUnixSeconds: nowUnix,
  });

  store.set('games/game_adey-main_live', {
    gameId: 'game_adey-main_live',
    roomId: 'adey-main',
    hostUid: 'tg_778899',
    status: 'completed',
    calledNumbers: [9, 30, 7, 16, 14],
    latestBall: 14,
    winnerUid: 'tg_778899',
    winnerName: 'Selam Tadesse',
    winningCardId: 11,
    winningPattern: 'Horizontal Row 1',
  });
  store.set('transactions/tx_win_1', {
    transactionId: 'tx_win_1',
    userId: 'tg_778899',
    type: 'bingo_win',
    amountEtb: 80,
    status: 'demo_completed',
    description: 'Bingo Win Credit (Card #11)',
    reference: 'ADB-WIN-778899',
    createdAtMs: Date.now(),
  });

  const callbacks = [
    'cb:play_bingo',
    'cb:my_wallet',
    'cb:invite_friends',
    'cb:my_profile',
    'cb:game_history',
    'cb:support',
    'cb:language',
  ] as const;

  let seq = 7001;
  for (const cb of callbacks) {
    const res = await bot.handleIncomingUpdate({
      updateId: seq,
      callbackQueryId: `cbq_test_${seq}`,
      senderTelegramId: 778899,
      chatId: 778899,
      chatType: 'private',
      firstName: 'Selam',
      username: 'selam_addis',
      callbackData: cb,
      nowUnixSeconds: nowUnix + seq,
    });
    assert.equal(res.ok, true, `Callback ${cb} should succeed`);
    assert.equal(
      res.securityCode,
      `callback_${cb.replace('cb:', '')}`
    );
    if (cb === 'cb:language') {
      assert.match(res.text, /ቋንቋ ይምረጡ \/ Select Language/);
    }
    if (cb === 'cb:game_history') {
      assert.match(res.text, /#11/);
      assert.doesNotMatch(res.text, /#G-4821/); // No fake hardcoded history!
    }
    seq += 1;
  }

  // Selecting lang:en updates language in persistent Firestore store and preserves it across /start
  const langEnRes = await bot.handleIncomingUpdate({
    updateId: seq++,
    callbackQueryId: 'cbq_lang_en',
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    callbackData: 'lang:en',
    nowUnixSeconds: nowUnix + 40,
  });
  assert.equal(langEnRes.ok, true);
  assert.equal(langEnRes.securityCode, 'language_updated');
  assert.equal(langEnRes.language, 'en');
  assert.equal(store.get('users/tg_778899')?.language, 'en');

  const restartEnRes = await bot.handleIncomingUpdate({
    updateId: seq++,
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    text: '/start',
    nowUnixSeconds: nowUnix + 45,
  });
  assert.equal(restartEnRes.language, 'en');

  // Duplicate callbackQueryId is rejected with duplicate_callback_query
  const dupCb = await bot.handleIncomingUpdate({
    updateId: 7999,
    callbackQueryId: 'cbq_test_7001',
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    callbackData: 'cb:play_bingo',
    nowUnixSeconds: nowUnix + 50,
  });
  assert.equal(dupCb.ok, false);
  assert.equal(dupCb.securityCode, 'duplicate_callback_query');

  // Admin commands and admin callbacks are blocked inside player bot
  const adminSlash = await bot.handleIncomingUpdate({
    updateId: 8000,
    senderTelegramId: 778899,
    chatId: 778899,
    chatType: 'private',
    text: '/admin',
    nowUnixSeconds: nowUnix + 60,
  });
  assert.equal(adminSlash.ok, false);
  assert.equal(adminSlash.securityCode, 'admin_command_forbidden_in_player_bot');
});

test('Milestone 5: PersistentTelegramBotService persists demo depositRequests, payoutRequests, atomic referrals, and real leaderboard rankings in Firestore', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const botStore = createFirestoreTelegramStore(db);
  const bot = new PersistentTelegramBotService(
    botStore,
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600)
  );
  const nowUnix = Math.floor(Date.now() / 1000);

  // 1. Inviter registers first in Amharic default
  await bot.handleIncomingUpdate({
    updateId: 8100,
    senderTelegramId: 112233,
    chatId: 112233,
    chatType: 'private',
    firstName: 'Hanna',
    username: 'hanna_et',
    text: '/start',
    nowUnixSeconds: nowUnix,
  });

  // 2. Invitee joins via /start ADEY-112233 -> atomic referral credit (+20 / +15)
  const inviteeStart = await bot.handleIncomingUpdate({
    updateId: 8101,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    firstName: 'Yonas',
    username: 'yonas_et',
    text: '/start ADEY-112233',
    nowUnixSeconds: nowUnix + 1,
  });
  assert.equal(inviteeStart.ok, true);
  assert.equal(inviteeStart.language, 'am');
  assert.equal(store.get('users/tg_112233')?.demoBalanceEtb, 270);
  assert.equal(store.get('users/tg_445566')?.demoBalanceEtb, 265);
  assert.equal(store.get('referrals/ref_tg_445566')?.inviterUid, 'tg_112233');

  // Re-sending /start ADEY-112233 does NOT duplicate credit
  await bot.handleIncomingUpdate({
    updateId: 8102,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    text: '/start ADEY-112233',
    nowUnixSeconds: nowUnix + 2,
  });
  assert.equal(store.get('users/tg_112233')?.demoBalanceEtb, 270);
  assert.equal(store.get('users/tg_445566')?.demoBalanceEtb, 265);

  // Self-referral is ignored without credit
  await bot.handleIncomingUpdate({
    updateId: 8103,
    senderTelegramId: 778800,
    chatId: 778800,
    chatType: 'private',
    firstName: 'SelfTest',
    text: '/start ADEY-778800',
    nowUnixSeconds: nowUnix + 3,
  });
  assert.equal(store.get('users/tg_778800')?.demoBalanceEtb, 250);

  // 3. Demo deposit request via bot persists in depositRequests & appears in cb:deposit_status
  await bot.handleIncomingUpdate({
    updateId: 8104,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:deposit_method:telebirr',
    nowUnixSeconds: nowUnix + 4,
  });
  const depRes = await bot.handleIncomingUpdate({
    updateId: 8105,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:deposit_amount:200',
    nowUnixSeconds: nowUnix + 5,
  });
  assert.equal(depRes.ok, true);
  assert.equal(depRes.securityCode, 'deposit_request_created');
  const depStatus = await bot.handleIncomingUpdate({
    updateId: 8106,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:deposit_status',
    nowUnixSeconds: nowUnix + 6,
  });
  assert.match(depStatus.text, /200\.00 ETB/);

  // 4. Demo withdrawal request checks balance & persists in payoutRequests
  const overWdr = await bot.handleIncomingUpdate({
    updateId: 8107,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:withdraw_amount:5000',
    nowUnixSeconds: nowUnix + 7,
  });
  assert.equal(overWdr.ok, false);
  assert.equal(overWdr.securityCode, 'insufficient_demo_balance');

  const okWdr = await bot.handleIncomingUpdate({
    updateId: 8108,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:withdraw_amount:100',
    nowUnixSeconds: nowUnix + 8,
  });
  assert.equal(okWdr.ok, true);
  assert.equal(okWdr.securityCode, 'withdraw_request_created');

  const wdrStatus = await bot.handleIncomingUpdate({
    updateId: 8109,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:withdraw_status',
    nowUnixSeconds: nowUnix + 9,
  });
  assert.match(wdrStatus.text, /100\.00 ETB/);

  // 5. Real Firestore leaderboard aggregates bingo_win transactions
  store.set('transactions/tx_win_yonas_1', {
    transactionId: 'tx_win_yonas_1',
    userId: 'tg_445566',
    type: 'bingo_win',
    amountEtb: 150,
    status: 'demo_completed',
    createdAtMs: Date.now(),
  });
  const lbRes = await bot.handleIncomingUpdate({
    updateId: 8110,
    senderTelegramId: 445566,
    chatId: 445566,
    chatType: 'private',
    callbackData: 'cb:leaderboard',
    nowUnixSeconds: nowUnix + 10,
  });
  assert.equal(lbRes.ok, true);
  assert.match(lbRes.text, /Yonas/);
  assert.match(lbRes.text, /150/);
});

test('Real-Time Multiplayer Synchronization & Live Financial Dashboard: verifies all 9 multi-device & financial scenarios', async () => {
  const { db, store } = createInMemoryFirestoreHarness();
  const { PersistentAdminService } = await import('./adminPersistence.ts');

  // Create two separate server/device instances backed by the same shared Firestore database
  const deviceAGame = new PersistentGameAuthorityService(
    createFirestoreGameStore(db),
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  const deviceBGame = new PersistentGameAuthorityService(
    createFirestoreGameStore(db),
    new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300)
  );
  const adminService = new PersistentAdminService(db);

  await createFirestoreGameStore(db).ensureDefaultRooms();
  const roomId = 'adey-main';
  const gameId = 'game_adey-main_live';

  // Seed Device A (Existing Player) and Device B (Invited Player)
  store.set('users/tg_101', {
    uid: 'tg_101',
    telegramUserId: 'tg_101',
    displayName: 'Device A Existing',
    username: 'device_a',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 100,
  });
  store.set('users/tg_102', {
    uid: 'tg_102',
    telegramUserId: 'tg_102',
    displayName: 'Device B Invited',
    username: 'device_b',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 100,
    referredByCode: 'ADEY-101',
  });

  // Scenario 1 & 9: Device A joins (buys 2 cards) -> Device B immediately sees updated confirmed player count (1/600), available spaces (599), and cards sold (2)
  const joinA1 = await deviceAGame.reserveOrReleaseCard({
    roomId,
    cardId: 1,
    uid: 'tg_101',
    displayName: 'Device A Existing',
    telegramUserId: 'tg_101',
  });
  assert.equal(joinA1.ok, true);
  const joinA2 = await deviceAGame.reserveOrReleaseCard({
    roomId,
    cardId: 2,
    uid: 'tg_101',
    displayName: 'Device A Existing',
    telegramUserId: 'tg_101',
  });
  assert.equal(joinA2.ok, true);

  // Device B reads authoritative room state without local fabrication
  const roomsOnDeviceB = await createFirestoreGameStore(db).listRooms();
  const mainOnB = roomsOnDeviceB.find((r) => r.roomId === roomId)!;
  assert.equal(mainOnB.confirmedPlayersCount, 1, '1 player with 2 cards must count as 1 confirmed player');
  assert.equal(mainOnB.availableSpaces, 599, 'Available spaces must be 600 - 1 = 599');
  assert.equal(mainOnB.totalCardsSold, 2, 'Total cards sold tracked separately from player count');
  assert.equal(mainOnB.totalCollectedEtb, 10);
  assert.equal(mainOnB.adeyShareEtb, 2);
  assert.equal(mainOnB.winnersPrizePoolEtb, 8);

  // Scenario 2, 3 & 7: Device B joins -> verified paid entries update revenue & 80% prize pool on all devices; pending/rejected deposits do NOT inflate game revenue
  store.set('depositRequests/dep_pending_1', {
    depositId: 'dep_pending_1',
    uid: 'tg_102',
    userDisplayName: 'Device B Invited',
    telegramUserId: 102,
    amountEtb: 500,
    status: 'Pending',
    referenceCode: 'TLB-PEND-1',
    requestDate: 'Just now',
  });
  store.set('depositRequests/dep_rejected_1', {
    depositId: 'dep_rejected_1',
    uid: 'tg_102',
    userDisplayName: 'Device B Invited',
    telegramUserId: 102,
    amountEtb: 300,
    status: 'Rejected',
    referenceCode: 'TLB-REJ-1',
    requestDate: 'Just now',
  });

  const joinB1 = await deviceBGame.reserveOrReleaseCard({
    roomId,
    cardId: 3,
    uid: 'tg_102',
    displayName: 'Device B Invited',
    telegramUserId: 'tg_102',
  });
  assert.equal(joinB1.ok, true);

  // Duplicate card reservation attempt by Device A on card 3 is rejected (Scenario 7)
  const dupTake = await deviceAGame.reserveOrReleaseCard({
    roomId,
    cardId: 3,
    uid: 'tg_101',
    displayName: 'Device A Existing',
    telegramUserId: 'tg_101',
  });
  assert.equal(dupTake.ok, false);
  assert.equal(dupTake.reason, 'card_already_taken');

  // Verify both Device A and Device B see identical prize pool (2 players * 10 ETB = 20 ETB -> 16 ETB prize pool 80%, 4 ETB ADEY share 20%)
  const overviewAfter2 = await adminService.getOverviewMetrics();
  assert.equal(overviewAfter2.financialDashboard.confirmedPlayersCount, 2);
  assert.equal(overviewAfter2.financialDashboard.availableSpaces, 598);
  assert.equal(overviewAfter2.financialDashboard.totalCardsSold, 3);
  assert.equal(overviewAfter2.financialDashboard.verifiedTotalRevenueEtb, 20);
  assert.equal(overviewAfter2.financialDashboard.adeyShareEtb, 4);
  assert.equal(overviewAfter2.financialDashboard.winnersPrizePoolEtb, 16);
  assert.ok(overviewAfter2.financialDashboard.pendingPaymentsCount >= 1);
  assert.ok(overviewAfter2.financialDashboard.pendingPaymentsEtb >= 500);
  assert.ok(overviewAfter2.financialDashboard.rejectedPaymentsCount >= 1);
  assert.ok(overviewAfter2.financialDashboard.rejectedPaymentsEtb >= 300);

  // Scenario 4 & 8: Server draws a Bingo number -> appears on all connected devices & survives disconnect/reconnect
  const drawRes = await deviceAGame.drawNextBall({
    roomId,
    gameId,
    callerUid: 'tg_101',
    requestNonce: 'sync-draw-1',
  });
  assert.equal(drawRes.ok, true);
  const reconnectedDeviceB = await createFirestoreGameStore(db).getRoomDetail(roomId, 'tg_102');
  assert.ok(reconnectedDeviceB.game);
  assert.deepEqual(reconnectedDeviceB.game.calledNumbers, drawRes.calledNumbers);
  assert.equal(reconnectedDeviceB.game.latestBall, drawRes.ball);

  // Scenario 5 & 7: Winner claim is synchronized and validated everywhere; duplicate claim cannot credit twice
  let currentBalls = drawRes.calledNumbers!;
  while (currentBalls.length < 75) {
    const next = await deviceAGame.drawNextBall({
      roomId,
      gameId,
      callerUid: 'tg_101',
    });
    currentBalls = next.calledNumbers!;
  }
  const card3TopRow = generateDeterministicCard(3).grid[0].filter((n) => n !== 0);
  const winClaim = await deviceBGame.verifyWinner({
    roomId,
    gameId,
    claimantUid: 'tg_102',
    playerName: 'Device B Invited',
    cardId: 3,
    markedNumbers: card3TopRow,
  });
  assert.equal(winClaim.verified, true);
  assert.equal(winClaim.winnersPrizePoolEtb, 16);

  const dupWinClaim = await deviceBGame.verifyWinner({
    roomId,
    gameId,
    claimantUid: 'tg_102',
    playerName: 'Device B Invited',
    cardId: 3,
    markedNumbers: card3TopRow,
  });
  assert.equal(dupWinClaim.verified, false);
  assert.equal(dupWinClaim.reason, 'game_already_completed');

  // Scenario 6: Two simultaneous joins when 599 players are already confirmed -> 600th succeeds, 601st is rejected with room_full
  await deviceAGame.resetRound({ roomId, gameId, callerUid: 'tg_101' });
  store.set(`rooms/${roomId}`, {
    ...store.get(`rooms/${roomId}`),
    status: 'countdown',
    activePlayersCount: 599,
    confirmedPlayersCount: 599,
    verifiedPaidEntriesCount: 599,
    availableSpaces: 1,
    totalCardsSold: 599,
    reservedCardsCount: 599,
  });
  store.set('users/tg_600', {
    uid: 'tg_600',
    telegramUserId: 'tg_600',
    displayName: 'Player 600',
    username: 'p600',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 50,
  });
  store.set('users/tg_601', {
    uid: 'tg_601',
    telegramUserId: 'tg_601',
    displayName: 'Player 601',
    username: 'p601',
    language: 'am',
    phoneVerified: true,
    demoBalanceEtb: 50,
  });

  const [join600, join601] = await Promise.all([
    deviceAGame.reserveOrReleaseCard({
      roomId,
      cardId: 599,
      uid: 'tg_600',
      displayName: 'Player 600',
      telegramUserId: 'tg_600',
    }),
    deviceBGame.reserveOrReleaseCard({
      roomId,
      cardId: 600,
      uid: 'tg_601',
      displayName: 'Player 601',
      telegramUserId: 'tg_601',
    }),
  ]);

  const successes = [join600, join601].filter((r) => r.ok);
  const fullRejections = [join600, join601].filter((r) => !r.ok && r.reason === 'room_full');
  assert.equal(successes.length, 1, 'Exactly 1 player can take the 600th slot');
  assert.equal(fullRejections.length, 1, '601st player must be rejected with room_full');

  const finalRoom = store.get(`rooms/${roomId}`)!;
  assert.equal(finalRoom.confirmedPlayersCount, 600);
  assert.equal(finalRoom.availableSpaces, 0);
  assert.equal(finalRoom.totalCollectedEtb, 6000);
  assert.equal(finalRoom.adeyShareEtb, 1200);
  assert.equal(finalRoom.winnersPrizePoolEtb, 4800);
});



