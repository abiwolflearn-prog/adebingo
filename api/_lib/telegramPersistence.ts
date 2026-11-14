import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { Language } from '../../src/types/bingo.ts';
import {
  type BotAdminConfig,
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
export const BOT_CONFIG_COLLECTION = 'botConfig';
export const BOT_UPDATE_REPLAY_TTL_SECONDS = 86400; // 24 hours

export function assertValidTelegramUserId(telegramUserId: number): number {
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new RangeError('telegramUserId must be a positive integer.');
  }
  return telegramUserId;
}

export interface PlayerHistoryItem {
  id: string;
  type: string;
  amountEtb: number;
  description: string;
  reference: string;
  createdAt: string;
}

export interface PlayerBotStatsAndHistory {
  balanceEtb: number;
  gamesPlayed: number;
  totalWins: number;
  referralCount: number;
  recentHistory: PlayerHistoryItem[];
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
  getPlayerStatsAndHistory?(telegramUserId: number): Promise<PlayerBotStatsAndHistory>;
  getBotCustomConfig?(): Promise<Partial<BotAdminConfig> | null>;
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
  const transactionsCol = db.collection('transactions');
  const gamesCol = db.collection('games');
  const referralsCol = db.collection('referrals');
  const botConfigCol = db.collection(BOT_CONFIG_COLLECTION);

  return {
    async getPlayer(telegramUserId: number): Promise<RegisteredTelegramPlayer | null> {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const [snap, userSnap] = await Promise.all([
        playersCol.doc(String(telegramUserId)).get(),
        usersCol.doc(canonicalUid).get(),
      ]);
      if (!snap.exists) return null;
      const player = snap.data() as RegisteredTelegramPlayer;
      if (userSnap.exists) {
        const userBal = userSnap.get('demoBalanceEtb');
        if (typeof userBal === 'number' && Number.isFinite(userBal)) {
          player.demoBalanceEtb = userBal;
        }
        const userPhoneVerified = userSnap.get('phoneVerified');
        if (typeof userPhoneVerified === 'boolean') {
          player.phoneVerified = player.phoneVerified || userPhoneVerified;
        }
      }
      return player;
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

    async getPlayerStatsAndHistory(telegramUserId: number): Promise<PlayerBotStatsAndHistory> {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const [userSnap, playerSnap, txSnap, gamesSnap, refSnap] = await Promise.all([
        usersCol.doc(canonicalUid).get(),
        playersCol.doc(String(telegramUserId)).get(),
        transactionsCol.where('userId', '==', canonicalUid).get(),
        gamesCol.where('winnerUid', '==', canonicalUid).get(),
        referralsCol.where('inviterUid', '==', canonicalUid).get(),
      ]);

      const balanceEtb = userSnap.exists
        ? Number(userSnap.get('demoBalanceEtb') ?? 250)
        : playerSnap.exists
          ? Number(playerSnap.get('demoBalanceEtb') ?? 250)
          : 250;

      const userTxDocs = txSnap.docs.map((d) => {
        const data = d.data() || {};
        const rawCreatedAt = data.createdAt;
        const createdAtIso =
          typeof rawCreatedAt === 'string'
            ? rawCreatedAt
            : rawCreatedAt && typeof (rawCreatedAt as { toDate?: () => Date }).toDate === 'function'
              ? (rawCreatedAt as { toDate: () => Date }).toDate().toISOString()
              : rawCreatedAt instanceof Date
                ? rawCreatedAt.toISOString()
                : new Date().toISOString();

        return {
          id: String(data.transactionId || d.id),
          type: String(data.type || 'card_entry'),
          amountEtb: Number(data.amountEtb ?? 0),
          description: String(data.description || ''),
          reference: String(data.reference || d.id),
          createdAt: createdAtIso,
        };
      });

      userTxDocs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const entryTxCount = userTxDocs.filter(
        (t) => t.type === 'card_entry' && t.amountEtb < 0
      ).length;
      const winTxCount = userTxDocs.filter((t) => t.type === 'bingo_win').length;
      const totalWins = Math.max(winTxCount, gamesSnap.size);
      const gamesPlayed = Math.max(
        entryTxCount,
        totalWins,
        userSnap.exists ? Number(userSnap.get('gamesPlayed') ?? 0) : 0
      );

      return {
        balanceEtb,
        gamesPlayed,
        totalWins,
        referralCount: refSnap.size,
        recentHistory: userTxDocs.slice(0, 5),
      };
    },

    async getBotCustomConfig(): Promise<Partial<BotAdminConfig> | null> {
      const snap = await botConfigCol.doc('default').get();
      if (!snap.exists) return null;
      return snap.data() as Partial<BotAdminConfig>;
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
 * private chat context for registration/contact verification, and 24h webhook + callbackQueryId replay protection.
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
    callbackQueryId?: string;
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
      callbackQueryId,
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

    const [existingPlayer, customConfig] = await Promise.all([
      this.store.getPlayer(senderTelegramId),
      this.store.getBotCustomConfig ? this.store.getBotCustomConfig() : Promise.resolve(null),
    ]);
    const currentLang: Language = existingPlayer?.language || 'am';
    const customButtons = customConfig?.buttonLabels;
    const effectiveMiniAppUrl = customConfig?.miniAppUrl || this.miniAppUrl;

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
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
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
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'replay_detected',
          profile: existingPlayer ?? undefined,
        };
      }
    }

    // Enforce replay protection on callback_query.id when present
    if (callbackQueryId !== undefined && callbackQueryId.trim() !== '') {
      const cbReplayCheck = await this.replayGuard.consumeOnce(
        'tg_cb',
        callbackQueryId.trim(),
        { nowUnixSeconds, ttlSeconds: BOT_UPDATE_REPLAY_TTL_SECONDS }
      );
      if (!cbReplayCheck.fresh) {
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '⚠️ ይህ የቁልፍ ጥያቄ ቀደም ብሎ ተስተናግዷል (Duplicate callback_query blocked).'
              : '⚠️ Duplicate callback query blocked (callbackQueryId already processed).',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'duplicate_callback_query',
          profile: existingPlayer ?? undefined,
        };
      }
    }

    const uid = getTelegramFirebaseUid(senderTelegramId);
    const isPrivateChat =
      chatType === 'private' && (chatId === undefined || chatId === senderTelegramId);

    const trimmed = text.trim();
    const cleanCallback = callbackData.trim();

    // 0. Block any admin commands or callbacks in the player-facing Telegram bot
    if (
      trimmed.startsWith('/admin') ||
      cleanCallback.startsWith('cb:admin') ||
      cleanCallback.startsWith('admin:')
    ) {
      return {
        ok: false,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '🚫 የአስተዳዳሪ ትዕዛዞች በተጫዋች ቦት ውስጥ አይፈቀዱም።'
            : '🚫 Administrator commands and links are not available inside the player Telegram bot.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
        securityCode: 'admin_command_forbidden_in_player_bot',
        profile: existingPlayer ?? undefined,
      };
    }

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
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
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
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
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
          replyMarkup: buildBotMainMenuMarkup(currentLang, effectiveMiniAppUrl, false, customButtons),
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
                `• የሙከራ ቦርሳ፦ *${persisted.player.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
                '',
                '🎮 ከታች ያለውን *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* ቁልፍ በመጫን ADEYBINGO ሚኒ አፕን ይክፈቱ!',
              ].join('\n')
            : [
                '✅ *Phone & Telegram Account Verified!*',
                '',
                `• Verified Phone: \`${maskedPhone}\``,
                `• Demo Sandbox Balance: *${persisted.player.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
                '',
                '🎮 Tap *🎮 PLAY BINGO* below to launch the ADEYBINGO Mini App!',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          persisted.player.language,
          effectiveMiniAppUrl,
          true,
          customButtons
        ),
        registrationStatus: 'verified',
        securityCode: 'contact_verified',
        profile: persisted.player,
        notificationQueued: regNotification,
      };
    }

    // 2. Reject plain-text phone numbers
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
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: check.reason || 'plain_text_phone_rejected',
        profile: existingPlayer ?? undefined,
      };
    }

    // 3. Language switching (`cb:language`, `lang:am`, `lang:en`, `/language`)
    if (
      cleanCallback === 'cb:language' ||
      cleanCallback === 'lang:am' ||
      cleanCallback === 'lang:en' ||
      trimmed === '/language' ||
      trimmed === '🌐 Change Language' ||
      trimmed === '🌐 Language' ||
      trimmed === '🌐 ቋንቋ ቀይር' ||
      trimmed === '🌐 ቋንቋ'
    ) {
      const nextLang: Language =
        cleanCallback === 'lang:am'
          ? 'am'
          : cleanCallback === 'lang:en'
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
            ? '🌐 *ቋንቋ ወደ አማርኛ ተቀይሯል!* \nሁሉም የቦት መልዕክቶች፣ ቁልፎች እና ማሳወቂያዎች በአማርኛ ይቀርባሉ።'
            : '🌐 *Bot language switched to English!* \nAll bot commands, inline buttons, and notifications will now be displayed in English.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          nextLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        securityCode: 'language_updated',
        profile: existingPlayer ? { ...existingPlayer, language: nextLang } : undefined,
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
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
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
          replyMarkup: buildBotMainMenuMarkup(currentLang, effectiveMiniAppUrl, false, customButtons),
          registrationStatus: 'duplicate_blocked',
          securityCode: 'duplicate_telegram_account',
        };
      }

      const player = saved.player;
      const customWelcome =
        player.language === 'am'
          ? customConfig?.customWelcomeAm
          : customConfig?.customWelcomeEn;

      const startText =
        customWelcome && customWelcome.trim() !== ''
          ? customWelcome
          : player.language === 'am'
            ? [
                `🌼 *እንኳን ወደ ADEYBINGO በደህና መጡ, ${player.firstName}!*`,
                '',
                'ADEYBINGO የኢትዮጵia ዘመናዊ የቴሌግራም ሚኒ-አፕ ቢንጎ ጨዋታ ነው፦',
                '• *እንዴት ይጫወታሉ?* ከ1–600 ካርዶች ውስጥ እስከ 4 ካርዶች ይምረጡ፣ የሚጠሩትን B-I-N-G-O ቁጥሮች ይከታተሉ እና አሸናፊ መስመር ሲሞሉ *CLAIM BINGO* ይጫኑ!',
                `• *የሙከራ ቦርሳ፦* *${player.demoBalanceEtb.toFixed(2)} ETB (Demo Sandbox)* ተዘጋጅቶልዎታል።`,
                '• ከታች ያለውን *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* ቁልፍ በመጫን ጨዋታውን ይጀምሩ!',
              ].join('\n')
            : [
                `🌼 *Welcome to ADEYBINGO, ${player.firstName}!*`,
                '',
                'ADEYBINGO is the premier Ethiopian Telegram Mini App Bingo arena:',
                '• *How to Play:* Pick 1–4 Bingo cards from the 600-card pool, mark live B-I-N-G-O calls, and tap *CLAIM BINGO* when you complete a winning line or 4-corners!',
                `• *Demo Wallet:* *${player.demoBalanceEtb.toFixed(2)} ETB (Demo Sandbox)* is ready in your account.`,
                '• Tap *🎮 PLAY BINGO* below to launch the Mini App!',
              ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: player.language,
        text: startText,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          player.language,
          effectiveMiniAppUrl,
          player.phoneVerified,
          customButtons
        ),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'start_welcome_delivered',
        profile: player,
      };
    }

    // 5. cb:play_bingo callback
    if (cleanCallback === 'cb:play_bingo' || trimmed === '🎮 Play Bingo' || trimmed === '🎮 ቢንጎ ይጫወቱ') {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '🎮 *ADEYBINGO ሚኒ አፕ ለመክፈት ዝግጁ ነው!*',
                '',
                `• የሚኒ አፕ አድራሻ፦ \`${effectiveMiniAppUrl}\``,
                '• ከታች ያለውን *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* ቁልፍ በመጫን ወደ ጨዋታ ክፍሎች ይግቡ።',
              ].join('\n')
            : [
                '🎮 *ADEYBINGO Mini App Ready!*',
                '',
                `• Mini App URL: \`${effectiveMiniAppUrl}\``,
                '• Tap the *🎮 PLAY BINGO* button below to enter the live Bingo rooms.',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_play_bingo',
        profile: existingPlayer ?? undefined,
      };
    }

    // Fetch real Firestore stats & history for wallet, profile, referrals, and game history callbacks
    const statsAndHistory = this.store.getPlayerStatsAndHistory
      ? await this.store.getPlayerStatsAndHistory(senderTelegramId)
      : {
          balanceEtb: existingPlayer?.demoBalanceEtb ?? 250,
          gamesPlayed: 0,
          totalWins: 0,
          referralCount: 0,
          recentHistory: [],
        };

    // 6. cb:my_wallet / menu:my_balance / /wallet
    if (
      cleanCallback === 'cb:my_wallet' ||
      cleanCallback === 'menu:my_balance' ||
      trimmed === '/wallet' ||
      trimmed === '💰 My Wallet' ||
      trimmed === '💰 My Balance' ||
      trimmed === '💰 የእኔ ቦርሳ'
    ) {
      const bal = statsAndHistory.balanceEtb;
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '💰 *የADEYBINGO የሙከራ ቦርሳ (My Wallet)*',
                '',
                `• የሚገኝ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (DEMO)*`,
                `• የተሳተፉባቸው ዙሮች፦ *${statsAndHistory.gamesPlayed}*`,
                `• ያሸነፉባቸው ዙሮች፦ *${statsAndHistory.totalWins}*`,
                '• ሁኔታ፦ *Demo Sandbox (እውነተኛ ክፍያ ዝግ ነው)*',
              ].join('\n')
            : [
                '💰 *ADEYBINGO Demo Wallet (My Wallet)*',
                '',
                `• Available Demo Balance: *${bal.toFixed(2)} ETB (DEMO)*`,
                `• Rounds Played: *${statsAndHistory.gamesPlayed}*`,
                `• Verified Wins: *${statsAndHistory.totalWins}*`,
                '• Mode: *Demo Sandbox (Real-money payments disabled)*',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_my_wallet',
        profile: existingPlayer ?? undefined,
      };
    }

    // 7. cb:invite_friends / menu:invite_friends / /invite
    if (
      cleanCallback === 'cb:invite_friends' ||
      cleanCallback === 'menu:invite_friends' ||
      trimmed === '/invite' ||
      trimmed === '👥 Invite Friends' ||
      trimmed === '🎁 Invite Friends' ||
      trimmed === '👥 ጓደኞችን ይጋብዙ'
    ) {
      const refCode = existingPlayer?.referralCode || `ADEY-${senderTelegramId}`;
      const refLink = `https://t.me/AdeyBingoBot?start=${refCode}`;
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '👥 *ጓደኞችዎን ወደ ADEYBINGO ይጋብዙ!*',
                '',
                `• የእርስዎ መጋበዣ ኮድ፦ \`${refCode}\``,
                `• የእርስዎ መጋበዣ ሊንክ፦ \`${refLink}\``,
                `• የተመዘገቡ ግብዣዎች፦ *${statsAndHistory.referralCount}*`,
                '• ሽልማት፦ ለእያንዳንዱ የተረጋገጠ ጓደኛ *+25.00 ETB (Demo)* (በአገልጋይ ከተረጋገጠ በኋላ)',
              ].join('\n')
            : [
                '👥 *Invite Friends to ADEYBINGO!*',
                '',
                `• Your Referral Code: \`${refCode}\``,
                `• Your Referral Link: \`${refLink}\``,
                `• Recorded Referrals: *${statsAndHistory.referralCount}*`,
                '• Bonus: *+25.00 ETB (Demo)* per verified friend (awarded after server verification)',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_invite_friends',
        profile: existingPlayer ?? undefined,
      };
    }

    // 8. cb:my_profile / menu:my_profile / /profile
    if (
      cleanCallback === 'cb:my_profile' ||
      cleanCallback === 'menu:my_profile' ||
      trimmed === '/profile' ||
      trimmed === '👤 My Profile' ||
      trimmed === '👤 መገለጫዬ'
    ) {
      const bal = statsAndHistory.balanceEtb;
      const pName = existingPlayer?.firstName || firstName;
      const pUser = existingPlayer?.username || username;
      const phoneLabel = existingPlayer?.phoneVerified
        ? `✅ (${existingPlayer.verifiedPhoneMasked || 'Verified'})`
        : currentLang === 'am'
          ? '⏳ አልተረጋገጠም'
          : '⏳ Unverified';

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '👤 *የተጫዋች መገለጫ (My Profile)*',
                '',
                `• ስም፦ *${pName}* (@${pUser})`,
                `• የቴሌግራም መለያ፦ \`${senderTelegramId}\``,
                `• የስልክ ማረጋገጫ፦ ${phoneLabel}`,
                `• የሙከራ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (Demo)*`,
                `• የተሳተፉባቸው ዙሮች፦ *${statsAndHistory.gamesPlayed}* · ድሎች፦ *${statsAndHistory.totalWins}*`,
                `• ቋንቋ፦ *አማርኛ (AM)*`,
              ].join('\n')
            : [
                '👤 *Player Profile (My Profile)*',
                '',
                `• Name: *${pName}* (@${pUser})`,
                `• Telegram ID: \`${senderTelegramId}\``,
                `• Phone Status: ${phoneLabel}`,
                `• Demo Balance: *${bal.toFixed(2)} ETB (Demo)*`,
                `• Games Played: *${statsAndHistory.gamesPlayed}* · Wins: *${statsAndHistory.totalWins}*`,
                `• Language: *English (EN)*`,
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_my_profile',
        profile: existingPlayer ?? undefined,
      };
    }

    // 9. cb:game_history / /history (Real Firestore data — NO hardcoded fake history)
    if (
      cleanCallback === 'cb:game_history' ||
      trimmed === '/history' ||
      trimmed === '📜 Game History' ||
      trimmed === '📜 የጨዋታ ታሪክ'
    ) {
      const historyLines =
        statsAndHistory.recentHistory.length > 0
          ? statsAndHistory.recentHistory.map((item, idx) => {
              const sign = item.amountEtb >= 0 ? '+' : '';
              return `${idx + 1}. \`${item.reference}\` — *${sign}${item.amountEtb.toFixed(2)} ETB* (${item.description})`;
            })
          : [
              currentLang === 'am'
                ? '• እስካሁን የተመዘገበ የጨዋታ ወይም የካርድ ግብይት ታሪክ የለም። የመጀመሪያ ዙርዎን ለመጀመር *🎮 ቢንጎ ይጫወቱ* የሚለውን ይጫኑ!'
                : '• No recorded game rounds or card transactions yet. Tap *🎮 PLAY BINGO* below to join your first live round!',
            ];

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '📜 *የቅርብ ጊዜ የጨዋታ እና የሂሳብ ታሪክ (Game History)*',
                '',
                `• ጠቅላላ የተጫወቱት፦ *${statsAndHistory.gamesPlayed}* · ድሎች፦ *${statsAndHistory.totalWins}*`,
                '',
                ...historyLines,
              ].join('\n')
            : [
                '📜 *Recent Game & Ledger History (Game History)*',
                '',
                `• Total Rounds Played: *${statsAndHistory.gamesPlayed}* · Verified Wins: *${statsAndHistory.totalWins}*`,
                '',
                ...historyLines,
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_game_history',
        profile: existingPlayer ?? undefined,
      };
    }

    // 10. /help, /support, cb:support, /terms
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
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer ?? undefined,
      };
    }

    if (
      trimmed === '/support' ||
      trimmed === '📞 Contact Support' ||
      trimmed === '💬 Support' ||
      trimmed === '💬 ድጋፍ' ||
      cleanCallback === 'cb:support' ||
      cleanCallback === 'menu:contact_support'
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '💬 *የADEYBINGO የተጫዋቾች ድጋፍ (/support)*\n• የቴሌግራም ድጋፍ፦ `@AdeyBingoSupport`\n• የምላሽ ጊዜ፦ ከ5 ደቂቃ በታች\n• ሁሉም ሂሳቦች በሙከራ (Demo Sandbox) ሁኔታ ይሰራሉ።'
            : '💬 *ADEYBINGO Player Support (/support)*\n• Telegram Support Desk: `@AdeyBingoSupport`\n• Typical Response Time: Under 5 minutes\n• All balances operate in Demo Sandbox mode.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_support',
        profile: existingPlayer ?? undefined,
      };
    }

    if (
      trimmed === '/terms' ||
      trimmed === '📜 Terms and Conditions' ||
      cleanCallback === 'menu:terms_conditions'
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
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons
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
          ? '🌼 የADEYBINGO ዋና ሜኑ ከታች ይገኛል። *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* በመጫን ጨዋታውን ይጀምሩ!'
          : '🌼 Use the ADEYBINGO menu below or tap *🎮 PLAY BINGO* to launch the Mini App!',
      parseMode: 'Markdown',
      replyMarkup: buildBotMainMenuMarkup(
        currentLang,
        effectiveMiniAppUrl,
        Boolean(existingPlayer?.phoneVerified),
        customButtons
      ),
      registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
      profile: existingPlayer ?? undefined,
    };
  }
}
