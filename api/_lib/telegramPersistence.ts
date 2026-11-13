import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { Language } from '../../src/types/bingo.ts';
import {
  BotNotificationMessage,
  buildBotMainMenuMarkup,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  formatTelegramNotification,
  NotificationEventType,
  RegisteredTelegramPlayer,
  TelegramBotResponse,
} from '../../src/utils/telegramBot.ts';
import {
  TelegramValidationResult,
  validateTelegramWebAppInitData,
  verifyTelegramSharedContact,
} from '../../src/utils/telegramVerify.ts';
import { getTelegramFirebaseUid } from './firebaseAdmin.ts';
import { PersistentReplayGuard } from './replayGuard.ts';

export const BOT_PLAYERS_COLLECTION = 'botPlayers';
export const BOT_OUTBOX_COLLECTION = 'botOutbox';
export const BOT_UPDATE_REPLAY_TTL_SECONDS = 86400; // 24 hours

export function assertValidTelegramUserId(telegramUserId: number): number {
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new RangeError('telegramUserId must be a positive integer.');
  }
  return telegramUserId;
}

export interface TelegramBotStore {
  getPlayer(telegramUserId: number): Promise<RegisteredTelegramPlayer | null>;
  savePlayerAndBinding(params: {
    telegramUserId: number;
    uid?: string;
    firstName: string;
    lastName?: string;
    username: string;
    language: Language;
  }): Promise<{ ok: boolean; reason?: 'duplicate_telegram_account' | 'invalid_uid'; player?: RegisteredTelegramPlayer }>;
  setLanguage(telegramUserId: number, language: Language): Promise<void>;
  verifyAndPersistContact(params: {
    telegramUserId: number;
    uid?: string;
    firstName: string;
    lastName?: string;
    username: string;
    verifiedPhoneNumber: string;
    maskedPhone: string;
  }): Promise<{ ok: boolean; reason?: 'duplicate_telegram_account' | 'invalid_uid'; player?: RegisteredTelegramPlayer }>;
  appendNotification(msg: BotNotificationMessage): Promise<void>;
  listNotifications(limit?: number): Promise<BotNotificationMessage[]>;
}

function maskPhoneNumber(phone: string): string {
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 6)}****${phone.slice(-2)}`;
}

export function createFirestoreTelegramStore(db: Firestore): TelegramBotStore {
  const playersCol = db.collection(BOT_PLAYERS_COLLECTION);
  const bindingsCol = db.collection('telegramBindings');
  const usersCol = db.collection('users');
  const outboxCol = db.collection(BOT_OUTBOX_COLLECTION);

  return {
    async getPlayer(telegramUserId: number): Promise<RegisteredTelegramPlayer | null> {
      assertValidTelegramUserId(telegramUserId);
      const snap = await playersCol.doc(String(telegramUserId)).get();
      if (!snap.exists) return null;
      return snap.data() as RegisteredTelegramPlayer;
    },

    async savePlayerAndBinding({
      telegramUserId,
      uid: providedUid,
      firstName,
      lastName = '',
      username,
      language,
    }) {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      if (providedUid !== undefined && providedUid !== canonicalUid) {
        return { ok: false, reason: 'invalid_uid' as const };
      }
      const uid = canonicalUid;
      const telegramKey = canonicalUid;
      const bindingRef = bindingsCol.doc(telegramKey);
      const playerRef = playersCol.doc(String(telegramUserId));
      const userRef = usersCol.doc(uid);

      return await db.runTransaction(async (tx) => {
        const [bindingSnap, playerSnap, userSnap] = await Promise.all([
          tx.get(bindingRef),
          tx.get(playerRef),
          tx.get(userRef),
        ]);

        if (bindingSnap.exists && bindingSnap.get('uid') !== uid) {
          return { ok: false, reason: 'duplicate_telegram_account' as const };
        }

        const nowIso = new Date().toISOString();
        const existingPlayer = playerSnap.exists
          ? (playerSnap.data() as RegisteredTelegramPlayer)
          : undefined;
        const resolvedLang: Language = existingPlayer?.language || language || 'am';

        const cleanUsername = username.startsWith('@')
          ? username.slice(1)
          : username || canonicalUid;

        const player: RegisteredTelegramPlayer = {
          uid,
          telegramUserId,
          telegramKey,
          firstName: firstName.slice(0, 80) || 'Adey Player',
          lastName: lastName.slice(0, 80),
          username: cleanUsername.slice(0, 64),
          language: resolvedLang,
          phoneVerified: Boolean(existingPlayer?.phoneVerified),
          verifiedPhoneMasked: existingPlayer?.verifiedPhoneMasked,
          demoBalanceEtb: userSnap.exists
            ? Number(userSnap.get('demoBalanceEtb') ?? 250)
            : existingPlayer?.demoBalanceEtb ?? 250,
          referralCode: existingPlayer?.referralCode || `ADEY-${telegramUserId}`,
          registeredAt: existingPlayer?.registeredAt || nowIso,
          updatedAt: nowIso,
        };

        if (!bindingSnap.exists) {
          tx.set(bindingRef, {
            telegramUserId: telegramKey,
            uid,
            boundAt: FieldValue.serverTimestamp(),
          });
        }

        if (!userSnap.exists) {
          tx.set(userRef, {
            uid,
            telegramUserId: telegramKey,
            displayName: `${player.firstName} ${player.lastName || ''}`.trim().slice(0, 80),
            username: `@${player.username}`.slice(0, 64),
            language: resolvedLang,
            phoneVerified: player.phoneVerified,
            demoBalanceEtb: 250,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(userRef, {
            displayName: `${player.firstName} ${player.lastName || ''}`.trim().slice(0, 80),
            username: `@${player.username}`.slice(0, 64),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(playerRef, player, { merge: true });
        return { ok: true, player };
      });
    },

    async setLanguage(telegramUserId: number, language: Language): Promise<void> {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const playerRef = playersCol.doc(String(telegramUserId));
      const userRef = usersCol.doc(canonicalUid);
      const nowIso = new Date().toISOString();

      await db.runTransaction(async (tx) => {
        // Strict Firestore transaction rule: ALL reads must occur before ANY writes
        const [playerSnap, userSnap] = await Promise.all([
          tx.get(playerRef),
          tx.get(userRef),
        ]);

        if (playerSnap.exists) {
          tx.update(playerRef, { language, updatedAt: nowIso });
        } else {
          tx.set(
            playerRef,
            {
              telegramUserId,
              telegramKey: canonicalUid,
              uid: canonicalUid,
              firstName: 'Adey Player',
              username: canonicalUid,
              language,
              phoneVerified: false,
              demoBalanceEtb: userSnap.exists ? Number(userSnap.get('demoBalanceEtb') ?? 250) : 250,
              referralCode: `ADEY-${telegramUserId}`,
              registeredAt: nowIso,
              updatedAt: nowIso,
            },
            { merge: true }
          );
        }

        if (userSnap.exists) {
          tx.update(userRef, { language, updatedAt: FieldValue.serverTimestamp() });
        }
      });
    },

    async verifyAndPersistContact({
      telegramUserId,
      uid: providedUid,
      firstName,
      lastName = '',
      username,
      verifiedPhoneNumber,
      maskedPhone,
    }) {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      if (providedUid !== undefined && providedUid !== canonicalUid) {
        return { ok: false, reason: 'invalid_uid' as const };
      }
      const uid = canonicalUid;
      const telegramKey = canonicalUid;
      const bindingRef = bindingsCol.doc(telegramKey);
      const playerRef = playersCol.doc(String(telegramUserId));
      const userRef = usersCol.doc(uid);
      const contactRef = userRef.collection('private').doc('contact');

      return await db.runTransaction(async (tx) => {
        const [bindingSnap, playerSnap, userSnap] = await Promise.all([
          tx.get(bindingRef),
          tx.get(playerRef),
          tx.get(userRef),
        ]);

        if (bindingSnap.exists && bindingSnap.get('uid') !== uid) {
          return { ok: false, reason: 'duplicate_telegram_account' as const };
        }

        const nowIso = new Date().toISOString();
        const existingPlayer = playerSnap.exists
          ? (playerSnap.data() as RegisteredTelegramPlayer)
          : undefined;
        const resolvedLang: Language = existingPlayer?.language || 'am';
        const cleanUsername = username.startsWith('@')
          ? username.slice(1)
          : username || `tg_${telegramUserId}`;

        const player: RegisteredTelegramPlayer = {
          uid,
          telegramUserId,
          telegramKey,
          firstName: firstName.slice(0, 80) || 'Adey Player',
          lastName: lastName.slice(0, 80),
          username: cleanUsername.slice(0, 64),
          language: resolvedLang,
          phoneVerified: true,
          verifiedPhoneMasked: maskedPhone,
          demoBalanceEtb: userSnap.exists
            ? Number(userSnap.get('demoBalanceEtb') ?? 250)
            : existingPlayer?.demoBalanceEtb ?? 250,
          referralCode: existingPlayer?.referralCode || `ADEY-${telegramUserId}`,
          registeredAt: existingPlayer?.registeredAt || nowIso,
          updatedAt: nowIso,
        };

        if (!bindingSnap.exists) {
          tx.set(bindingRef, {
            telegramUserId: telegramKey,
            uid,
            boundAt: FieldValue.serverTimestamp(),
          });
        }

        if (!userSnap.exists) {
          tx.set(userRef, {
            uid,
            telegramUserId: telegramKey,
            displayName: `${player.firstName} ${player.lastName || ''}`.trim().slice(0, 80),
            username: `@${player.username}`.slice(0, 64),
            language: resolvedLang,
            phoneVerified: true,
            demoBalanceEtb: 250,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(userRef, {
            phoneVerified: true,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(contactRef, {
          uid,
          phoneNumber: verifiedPhoneNumber,
          phoneVerified: true,
          verificationMethod: 'telegram_contact',
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(playerRef, player, { merge: true });
        return { ok: true, player };
      });
    },

    async appendNotification(msg: BotNotificationMessage): Promise<void> {
      await outboxCol.doc(msg.id).set({
        ...msg,
        createdAtMs: Date.now(),
      });
    },

    async listNotifications(limit = 12): Promise<BotNotificationMessage[]> {
      const snap = await outboxCol
        .orderBy('createdAtMs', 'desc')
        .limit(Math.max(1, Math.min(50, limit)))
        .get();
      return snap.docs.map((d) => {
        const data = d.data();
        return {
          id: String(data.id),
          event: data.event as NotificationEventType,
          telegramUserId: Number(data.telegramUserId),
          language: (data.language === 'en' ? 'en' : 'am') as Language,
          title: String(data.title),
          body: String(data.body),
          createdAt: String(data.createdAt),
          deliveredViaBotApi: Boolean(data.deliveredViaBotApi),
        };
      });
    },
  };
}

/**
 * Validates Telegram Mini App initData cryptographically AND enforces persistent
 * one-time replay protection in Firestore using the initData HMAC hash strictly
 * (never accepting an arbitrary client-supplied actionNonce).
 */
export async function verifyTelegramInitDataPersistent(params: {
  rawInitData: string;
  botToken: string;
  replayGuard: PersistentReplayGuard;
  maxAgeSeconds?: number;
  nowUnixSeconds?: number;
  expectedTelegramUserId?: number;
}): Promise<TelegramValidationResult> {
  const cryptoResult = validateTelegramWebAppInitData(
    params.rawInitData,
    params.botToken,
    {
      maxAgeSeconds: params.maxAgeSeconds ?? 3600,
      nowUnixSeconds: params.nowUnixSeconds,
      expectedTelegramUserId: params.expectedTelegramUserId,
    }
  );

  if (!cryptoResult.valid || !cryptoResult.dataCheckHash) {
    return cryptoResult;
  }

  const replayRes = await params.replayGuard.consumeOnce(
    'init_data',
    cryptoResult.dataCheckHash,
    {
      nowUnixSeconds: params.nowUnixSeconds,
      ttlSeconds: Math.max(60, params.maxAgeSeconds ?? 3600),
    }
  );

  if (!replayRes.fresh) {
    return { valid: false, reason: 'replay_detected' };
  }

  return cryptoResult;
}

/**
 * Persistent Firestore-backed Telegram Bot engine.
 * Enforces positive-integer Telegram IDs, deterministic tg_<id> UID mapping,
 * private chat context for registration/contact verification, and 24h webhook replay protection.
 */
export class PersistentTelegramBotService {
  private readonly store: TelegramBotStore;
  private readonly replayGuard: PersistentReplayGuard;
  private readonly miniAppUrl: string;

  constructor(
    store: TelegramBotStore,
    replayGuard: PersistentReplayGuard,
    miniAppUrl: string = DEFAULT_DEPLOYED_MINI_APP_URL
  ) {
    this.store = store;
    this.replayGuard = replayGuard;
    this.miniAppUrl = miniAppUrl;
  }

  public async queueNotification(
    event: NotificationEventType,
    telegramUserId: number,
    payload: Parameters<typeof formatTelegramNotification>[2] = {},
    deliveredViaBotApi = false
  ): Promise<BotNotificationMessage> {
    assertValidTelegramUserId(telegramUserId);
    const existing = await this.store.getPlayer(telegramUserId);
    const lang: Language = existing?.language || 'am';
    const formatted = formatTelegramNotification(event, lang, payload);
    const msg: BotNotificationMessage = {
      id: `ntf_${crypto.randomUUID()}`,
      event,
      telegramUserId,
      language: lang,
      title: formatted.title,
      body: formatted.body,
      createdAt: new Date().toISOString(),
      deliveredViaBotApi,
    };
    await this.store.appendNotification(msg);
    return msg;
  }

  public async handleIncomingUpdate(params: {
    updateId?: number;
    senderTelegramId: number;
    chatId?: number;
    chatType?: 'private' | 'group' | 'supergroup' | 'channel';
    firstName?: string;
    lastName?: string;
    username?: string;
    text?: string;
    callbackData?: string;
    contact?: {
      phone_number?: string;
      first_name?: string;
      last_name?: string;
      user_id?: number;
    } | null;
    nowUnixSeconds?: number;
  }): Promise<TelegramBotResponse> {
    const {
      updateId,
      senderTelegramId,
      chatId,
      chatType,
      firstName = 'Abebe',
      lastName = 'Bikila',
      username = 'abebe_adey',
      text = '',
      callbackData = '',
      contact,
      nowUnixSeconds = Math.floor(Date.now() / 1000),
    } = params;

    if (!Number.isInteger(senderTelegramId) || senderTelegramId <= 0) {
      return {
        ok: false,
        chatId: 0,
        language: 'am',
        text: '🚫 Invalid Telegram sender ID.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup('am', this.miniAppUrl, false),
        registrationStatus: 'unregistered',
        securityCode: 'invalid_telegram_user_id',
      };
    }

    const existingPlayer = await this.store.getPlayer(senderTelegramId);
    const currentLang: Language = existingPlayer?.language || 'am';

    if (updateId !== undefined) {
      if (!Number.isInteger(updateId) || updateId <= 0) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text: '🚫 Invalid Telegram update ID.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            this.miniAppUrl,
            Boolean(existingPlayer?.phoneVerified)
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'invalid_update_id',
          profile: existingPlayer ?? undefined,
        };
      }

      const replayCheck = await this.replayGuard.consumeOnce(
        'tg_update',
        String(updateId),
        { nowUnixSeconds, ttlSeconds: BOT_UPDATE_REPLAY_TTL_SECONDS }
      );
      if (!replayCheck.fresh) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '⚠️ ይህ ጥያቄ ቀደም ብሎ ተስተናግዷል (Duplicate update_id replay blocked).'
              : '⚠️ Duplicate request blocked (update_id already processed).',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            this.miniAppUrl,
            Boolean(existingPlayer?.phoneVerified)
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'replay_detected',
          profile: existingPlayer ?? undefined,
        };
      }
    }

    const uid = getTelegramFirebaseUid(senderTelegramId);
    const isPrivateChat =
      chatType === 'private' && (chatId === undefined || chatId === senderTelegramId);

    // 1. Contact sharing verification (must originate from a private 1-on-1 Telegram DM)
    if (contact !== undefined && contact !== null) {
      if (!isPrivateChat) {
        return {
          ok: false,
          chatId: chatId ?? senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '🔒 *ደህንነት ማሳሰቢያ፦* የስልክ ማረጋገጫ በግል የቴሌግራም መልዕክት (Private Chat) ብቻ ይፈቀዳል።'
              : '🔒 *Security Notice:* Contact verification is only allowed in a private 1-on-1 Telegram chat with the bot.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            this.miniAppUrl,
            Boolean(existingPlayer?.phoneVerified)
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'private_chat_required',
          profile: existingPlayer ?? undefined,
        };
      }

      const contactCheck = verifyTelegramSharedContact({
        senderTelegramId,
        contact,
      });

      if (!contactCheck.valid || !contactCheck.verifiedPhoneNumber) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '🚫 *የስልክ ማረጋገጫ ውድቅ ተደርጓል!* \nየራስዎን ቴሌግራም ቁጥር ብቻ (*Share Phone Contact*) ማጋራት ይችላሉ። የተላለፈ (Forwarded) ወይም የሌላ ሰው ስልክ ቁጥር ተቀባይነት የለውም።'
              : '🚫 *Contact Verification Rejected!* \nYou can only share your own Telegram account phone number. Forwarded or third-party contacts are rejected.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            this.miniAppUrl,
            Boolean(existingPlayer?.phoneVerified)
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: contactCheck.reason || 'contact_owner_mismatch',
          profile: existingPlayer ?? undefined,
        };
      }

      const maskedPhone = maskPhoneNumber(contactCheck.verifiedPhoneNumber);
      const persisted = await this.store.verifyAndPersistContact({
        telegramUserId: senderTelegramId,
        uid,
        firstName,
        lastName,
        username,
        verifiedPhoneNumber: contactCheck.verifiedPhoneNumber,
        maskedPhone,
      });

      if (!persisted.ok || !persisted.player) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '🚫 ይህ የቴሌግራም መለያ ቀደም ብሎ ከሌላ የADEYBINGO መለያ ጋር ተገናኝቷል።'
              : '🚫 This Telegram account is already bound to another ADEYBINGO account.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(currentLang, this.miniAppUrl, false),
          registrationStatus: 'duplicate_blocked',
          securityCode: 'duplicate_telegram_account',
        };
      }

      const regNotification = await this.queueNotification(
        'registration_success',
        senderTelegramId,
        {
          playerName: persisted.player.firstName,
          maskedPhone,
        }
      );

      return {
        ok: true,
        chatId: senderTelegramId,
        language: persisted.player.language,
        text:
          persisted.player.language === 'am'
            ? [
                '✅ *ስልክዎ እና መለያዎ በተሳካ ሁኔታ ተረጋግጠዋል!*',
                '',
                `• የተረጋገጠ ስልክ፦ \`${maskedPhone}\``,
                '• የሙከራ ቦርሳ፦ *250.00 ETB (Demo)*',
                '',
                '🎮 ከታች ያለውን *Start Playing* ቁልፍ በመጫን ADEYBINGO ሚኒ አፕን ይክፈቱ!',
              ].join('\n')
            : [
                '✅ *Phone & Telegram Account Verified!*',
                '',
                `• Verified Phone: \`${maskedPhone}\``,
                '• Demo Sandbox Balance: *250.00 ETB (Demo)*',
                '',
                '🎮 Tap *Start Playing* below to launch the ADEYBINGO Mini App!',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(persisted.player.language, this.miniAppUrl, true),
        registrationStatus: 'verified',
        securityCode: 'contact_verified',
        profile: persisted.player,
        notificationQueued: regNotification,
      };
    }

    // 2. Reject plain-text phone numbers
    const trimmed = text.trim();
    if (/^\+?[0-9\s\-()]{9,16}$/.test(trimmed)) {
      const check = verifyTelegramSharedContact({
        senderTelegramId,
        messageText: trimmed,
        contact: null,
      });
      return {
        ok: false,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '🔒 *ደህንነት ማሳሰቢያ፦* በጽሁፍ የተጻፈ ስልክ ቁጥር እንደ ተረጋገጠ አይቆጠርም። እባክዎ ከታች ያለውን *📲 ስልክ ቁጥርዎን ያጋሩ (Share Phone Contact)* የሚለውን የቴሌግራም ቁልፍ ብቻ ይጠቀሙ።'
            : '🔒 *Security Notice:* Typed phone numbers are never treated as verified. Please use the native *📲 Share Telegram Phone Contact* button below so Telegram cryptographically verifies ownership.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: check.reason || 'plain_text_phone_rejected',
        profile: existingPlayer ?? undefined,
      };
    }

    // 3. Language switching
    if (
      callbackData === 'lang:am' ||
      callbackData === 'lang:en' ||
      trimmed === '/language' ||
      trimmed === '🌐 Change Language' ||
      trimmed === '🌐 ቋንቋ ቀይር'
    ) {
      const nextLang: Language =
        callbackData === 'lang:am'
          ? 'am'
          : callbackData === 'lang:en'
          ? 'en'
          : currentLang === 'am'
          ? 'en'
          : 'am';
      await this.store.setLanguage(senderTelegramId, nextLang);

      return {
        ok: true,
        chatId: senderTelegramId,
        language: nextLang,
        text:
          nextLang === 'am'
            ? '🌐 *ቋንቋ ወደ አማርኛ ተቀይሯል!* \nሁሉም የቦት መልዕክቶች እና ማሳወቂያዎች በአማርኛ ይቀርባሉ።'
            : '🌐 *Bot language switched to English!* \nAll bot commands, menus, and notifications will now be displayed in English.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          nextLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        profile: existingPlayer ?? undefined,
      };
    }

    // 4. /start command (requires private 1-on-1 Telegram DM)
    if (trimmed.startsWith('/start')) {
      if (!isPrivateChat) {
        return {
          ok: false,
          chatId: chatId ?? senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '🔒 *ደህንነት ማሳሰቢያ፦* የADEYBINGO መለያ ምዝገባ በግል የቴሌግራም ውይይት (Private Chat) ብቻ ይፈቀዳል።'
              : '🔒 *Security Notice:* Account registration via /start is only allowed in a private 1-on-1 Telegram chat.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            this.miniAppUrl,
            Boolean(existingPlayer?.phoneVerified)
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'private_chat_required',
          profile: existingPlayer ?? undefined,
        };
      }

      const saved = await this.store.savePlayerAndBinding({
        telegramUserId: senderTelegramId,
        uid,
        firstName,
        lastName,
        username,
        language: currentLang,
      });

      if (!saved.ok || !saved.player) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '🚫 ይህ የቴሌግራም መለያ ቀደም ብሎ ከሌላ የADEYBINGO መለያ ጋር ተገናኝቷል።'
              : '🚫 Duplicate Telegram account registration blocked.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(currentLang, this.miniAppUrl, false),
          registrationStatus: 'duplicate_blocked',
          securityCode: 'duplicate_telegram_account',
        };
      }

      const player = saved.player;
      const startText =
        player.language === 'am'
          ? [
              `🌼 *እንኳን ወደ ADEYBINGO በደህና መጡ, ${player.firstName}!*`,
              '',
              '• ከ1–600 ካርዶች እስከ 4 ካርድ በአንድ ዙር ይምረጡ።',
              '• ለደህንነትዎ የስልክ ቁጥርዎ በ `/users/{uid}/private/contact` ውስጥ ተነጥሎ ይጠበቃል።',
              '• ከታች ያለውን *🎮 Start Playing* ቁልፍ በመጫን ጨዋታውን ይጀምሩ!',
            ].join('\n')
          : [
              `🌼 *Welcome to ADEYBINGO, ${player.firstName}!*`,
              '',
              '• Pick 1–4 Bingo cards from 1–600 per room.',
              '• Your phone contact is isolated securely in `/users/{uid}/private/contact`.',
              '• Tap *🎮 Start Playing* below to launch ADEYBINGO!',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: player.language,
        text: startText,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          player.language,
          this.miniAppUrl,
          player.phoneVerified
        ),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        profile: player,
      };
    }

    // 5. /help, /support, /terms, menu actions
    if (trimmed === '/help') {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '📖 *የADEYBINGO ቦት መመሪያ (/help)*\n\n• `/start` — ቦቱን ለመጀመር\n• `/language` — ቋንቋ ለመቀየር\n• `/support` — የደንበኞች ድጋፍ\n• `/terms` — ህጎች እና ደንቦች'
            : '📖 *ADEYBINGO Bot Command Guide (/help)*\n\n• `/start` — Onboarding & verification\n• `/language` — Switch Amharic / English\n• `/support` — Player support\n• `/terms` — Terms & Demo Sandbox rules',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (
      trimmed === '/support' ||
      trimmed === '📞 Contact Support' ||
      callbackData === 'menu:contact_support'
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '📞 *የADEYBINGO የተጫዋቾች ድጋፍ (/support)*\nየቴሌግራም ድጋፍ፦ `@AdeyBingoSupport`'
            : '📞 *ADEYBINGO Player Support (/support)*\nTelegram Support Desk: `@AdeyBingoSupport`',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (
      trimmed === '/terms' ||
      trimmed === '📜 Terms and Conditions' ||
      callbackData === 'menu:terms_conditions'
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '📜 *የADEYBINGO ህጎች እና የሙከራ ሁኔታ (/terms)*\nሁሉም ሂሳቦች በሙከራ (Demo Sandbox) ደረጃ ብቻ ናቸው።'
            : '📜 *ADEYBINGO Terms & Demo Sandbox Rules (/terms)*\nReal-money payments remain disabled pending licensing and payment-provider approval.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (trimmed === '👤 My Profile' || callbackData === 'menu:my_profile') {
      const bal = existingPlayer?.demoBalanceEtb ?? 250;
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? `👤 *መገለጫ* · TG #${senderTelegramId} · ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (Demo)*`
            : `👤 *Profile* · TG #${senderTelegramId} · Demo Balance: *${bal.toFixed(2)} ETB (Demo)*`,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (trimmed === '💰 My Balance' || callbackData === 'menu:my_balance') {
      const bal = existingPlayer?.demoBalanceEtb ?? 250;
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? `💰 *የሙከራ ቦርሳ ቀሪ ሂሳብ፦* *${bal.toFixed(2)} ETB (DEMO)*`
            : `💰 *Demo Wallet Balance:* *${bal.toFixed(2)} ETB (DEMO)*`,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (trimmed === '🎁 Invite Friends' || callbackData === 'menu:invite_friends') {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? `🎁 *ጓደኛ ይጋብዙ!* \nሊንክ፦ \`https://t.me/AdeyBingoBot?start=ADEY-${senderTelegramId}\``
            : `🎁 *Invite Friends!* \nLink: \`https://t.me/AdeyBingoBot?start=ADEY-${senderTelegramId}\``,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          this.miniAppUrl,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    return {
      ok: true,
      chatId: senderTelegramId,
      language: currentLang,
      text:
        currentLang === 'am'
          ? '🌼 የADEYBINGO ዋና ሜኑ ከታች ይገኛል። *🎮 Start Playing* በመጫን ጨዋታውን ይጀምሩ!'
          : '🌼 Use the ADEYBINGO menu below or tap *🎮 Start Playing* to launch the Mini App!',
      parseMode: 'Markdown',
      replyMarkup: buildBotMainMenuMarkup(
        currentLang,
        this.miniAppUrl,
        Boolean(existingPlayer?.phoneVerified)
      ),
      registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
      profile: existingPlayer ?? undefined,
    };
  }
}
