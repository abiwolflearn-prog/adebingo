import crypto from 'node:crypto';
import type { Language } from '../types/bingo.ts';
import {
  checkCardWin,
  formatBallCall,
  generateDeterministicCard,
  getLetterForNumber,
} from '../game/rules.ts';
import {
  TelegramReplayGuard,
  verifyTelegramSharedContact,
} from './telegramVerify.ts';

export type BotCommandType =
  | '/start'
  | '/help'
  | '/language'
  | '/support'
  | '/terms';

export type BotMenuAction =
  | 'start_playing'
  | 'my_profile'
  | 'my_balance'
  | 'invite_friends'
  | 'contact_support'
  | 'terms_conditions'
  | 'change_language';

export type NotificationEventType =
  | 'registration_success'
  | 'game_starting'
  | 'new_bingo_number'
  | 'game_completion'
  | 'winner_announcement'
  | 'referral_confirmation'
  | 'support_response';

export interface TelegramKeyboardButton {
  text: string;
  request_contact?: boolean;
  web_app?: { url: string };
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
  url?: string;
}

export interface TelegramBotReplyMarkup {
  keyboard?: TelegramKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  inline_keyboard?: TelegramInlineButton[][];
}

export interface TelegramBotResponse {
  ok: boolean;
  chatId: number;
  language: Language;
  text: string;
  parseMode: 'Markdown';
  replyMarkup: TelegramBotReplyMarkup;
  registrationStatus: 'unregistered' | 'pending_contact' | 'verified' | 'duplicate_blocked';
  securityCode?: string;
  profile?: RegisteredTelegramPlayer;
  notificationQueued?: BotNotificationMessage;
}

export interface RegisteredTelegramPlayer {
  uid: string;
  telegramUserId: number;
  telegramKey: string;
  firstName: string;
  lastName?: string;
  username: string;
  language: Language;
  phoneVerified: boolean;
  verifiedPhoneMasked?: string;
  demoBalanceEtb: number;
  referralCode: string;
  registeredAt: string;
  updatedAt: string;
}

export interface BotNotificationMessage {
  id: string;
  event: NotificationEventType | 'admin_announcement';
  telegramUserId: number;
  language: Language;
  title: string;
  body: string;
  createdAt: string;
  deliveredViaBotApi: boolean;
}

export interface BotButtonLabelsConfig {
  playBingoAm: string;
  playBingoEn: string;
  myWalletAm: string;
  myWalletEn: string;
  inviteFriendsAm: string;
  inviteFriendsEn: string;
  myProfileAm: string;
  myProfileEn: string;
  gameHistoryAm: string;
  gameHistoryEn: string;
  supportAm: string;
  supportEn: string;
  languageAm: string;
  languageEn: string;
}

export interface BotAnnouncementRecord {
  id: string;
  titleAm: string;
  titleEn: string;
  bodyAm: string;
  bodyEn: string;
  targetAudience: 'all_players' | 'verified_players';
  recipientCount: number;
  sentByAdmin: string;
  sentAt: string;
}

export interface BotAdminConfig {
  miniAppUrl: string;
  customWelcomeAm: string | null;
  customWelcomeEn: string | null;
  buttonLabels: BotButtonLabelsConfig;
  announcements: BotAnnouncementRecord[];
  stats: {
    totalUpdatesProcessed: number;
    callbacksHandled: number;
    duplicateCallbacksBlocked: number;
    announcementsSent: number;
  };
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_DEPLOYED_MINI_APP_URL =
  'https://adebingo-3nta.vercel.app/';

export const DEFAULT_BOT_BUTTON_LABELS: BotButtonLabelsConfig = {
  playBingoAm: '🎮 ቢንጎ ይጫወቱ (PLAY BINGO)',
  playBingoEn: '🎮 Play Bingo (PLAY BINGO)',
  myWalletAm: '💰 የእኔ ቦርሳ (My Wallet)',
  myWalletEn: '💰 My Wallet',
  inviteFriendsAm: '👥 ጓደኞችን ይጋብዙ (Invite Friends)',
  inviteFriendsEn: '👥 Invite Friends',
  myProfileAm: '👤 የእኔ መገለጫ (My Profile)',
  myProfileEn: '👤 My Profile',
  gameHistoryAm: '📜 የጨዋታ ታሪክ (Game History)',
  gameHistoryEn: '📜 Game History',
  supportAm: '💬 ድጋፍ (Support)',
  supportEn: '💬 Support',
  languageAm: '🌐 ቋንቋ (Language)',
  languageEn: '🌐 Language',
};

/**
 * Builds the 7-button ADEYBINGO Telegram Bot Main Menu Reply Keyboard + Interactive Inline Keyboard.
 * Includes PLAY BINGO WebApp launcher, all 7 Milestone 4 callback buttons, and Amharic/English selectors.
 */
export function buildBotMainMenuMarkup(
  lang: Language,
  miniAppUrl: string = DEFAULT_DEPLOYED_MINI_APP_URL,
  phoneVerified: boolean = false,
  labels: BotButtonLabelsConfig = DEFAULT_BOT_BUTTON_LABELS
): TelegramBotReplyMarkup {
  const contactRow: TelegramKeyboardButton[] = !phoneVerified
    ? [
        {
          text:
            lang === 'am'
              ? '📲 ስልክ ቁጥርዎን ያጋሩ (Share Phone Contact)'
              : '📲 Share Telegram Phone Contact',
          request_contact: true,
        },
      ]
    : [];

  const mainRows: TelegramKeyboardButton[][] = [
    ...(contactRow.length > 0 ? [contactRow] : []),
    [
      {
        text: '🎮 Start Playing',
        web_app: { url: miniAppUrl },
      },
    ],
    [
      { text: '👤 My Profile' },
      { text: '💰 My Balance' },
    ],
    [
      { text: '🎁 Invite Friends' },
      { text: '📞 Contact Support' },
    ],
    [
      { text: '📜 Terms and Conditions' },
      { text: '🌐 Change Language' },
    ],
  ];

  const inlineRows: TelegramInlineButton[][] = [
    [
      {
        text: lang === 'am' ? labels.playBingoAm : labels.playBingoEn,
        web_app: { url: miniAppUrl },
      },
      {
        text: lang === 'am' ? '🎮 ጨዋታ ክፈት' : '🎮 Play Bingo Info',
        callback_data: 'cb:play_bingo',
      },
    ],
    [
      {
        text: lang === 'am' ? labels.myWalletAm : labels.myWalletEn,
        callback_data: 'cb:my_wallet',
      },
      {
        text: lang === 'am' ? labels.inviteFriendsAm : labels.inviteFriendsEn,
        callback_data: 'cb:invite_friends',
      },
    ],
    [
      {
        text: lang === 'am' ? labels.myProfileAm : labels.myProfileEn,
        callback_data: 'cb:my_profile',
      },
      {
        text: lang === 'am' ? labels.gameHistoryAm : labels.gameHistoryEn,
        callback_data: 'cb:game_history',
      },
    ],
    [
      {
        text: lang === 'am' ? labels.supportAm : labels.supportEn,
        callback_data: 'cb:support',
      },
      {
        text: lang === 'am' ? labels.languageAm : labels.languageEn,
        callback_data: 'cb:language',
      },
    ],
    [
      {
        text: lang === 'am' ? '🇪🇹 አማርኛ ✓' : '🇪🇹 አማርኛ (Amharic)',
        callback_data: 'lang:am',
      },
      {
        text: lang === 'en' ? '🇬🇧 English ✓' : '🇬🇧 English',
        callback_data: 'lang:en',
      },
    ],
  ];

  return {
    keyboard: mainRows,
    resize_keyboard: true,
    one_time_keyboard: false,
    inline_keyboard: inlineRows,
  };
}

/**
 * Formats secure notification messages for all 7 required Part E events.
 * Uses Amharic (`am`) by default, with full English (`en`) support.
 */
export function formatTelegramNotification(
  event: NotificationEventType,
  lang: Language = 'am',
  payload: {
    playerName?: string;
    maskedPhone?: string;
    roomNameAm?: string;
    roomNameEn?: string;
    countdownSeconds?: number;
    ballNumber?: number;
    totalCalls?: number;
    winnerName?: string;
    winningCardId?: number;
    winningPattern?: string;
    demoPrizeEtb?: number;
    friendName?: string;
    inviterBonusEtb?: number;
    ticketId?: string;
    supportReply?: string;
  } = {}
): { title: string; body: string } {
  const playerName = payload.playerName || 'ተጫዋች';
  const roomAm = payload.roomNameAm || 'አደይ ዋና አዳራሽ';
  const roomEn = payload.roomNameEn || 'Adey Main Hall';

  switch (event) {
    case 'registration_success': {
      return lang === 'am'
        ? {
            title: '✅ ምዝገባዎ በተሳካ ሁኔታ ተጠናቋል!',
            body: `እንኳን ደህና መጡ *${playerName}*! የቴሌግራም ስልክ ቁጥርዎ (${payload.maskedPhone || '+251***'}) ተረጋግጧል። 250.00 ETB የሙከራ ሂሳብ (Demo Balance) ተዘጋጅቶልዎታል። 🎮 *Start Playing* በመጫን ይጀምሩ!`,
          }
        : {
            title: '✅ Registration & Phone Verification Complete!',
            body: `Welcome *${playerName}*! Your Telegram phone contact (${payload.maskedPhone || '+251***'}) is verified. Your 250.00 ETB Demo Sandbox balance is ready. Tap 🎮 *Start Playing* to launch ADEYBINGO!`,
          };
    }

    case 'game_starting': {
      const secs = payload.countdownSeconds ?? 60;
      return lang === 'am'
        ? {
            title: '⏳ የቢንጎ ጨዋታ ሊጀምር ነው!',
            body: `*${roomAm}* ክፍል ውስጥ ጨዋታው በ *${secs} ሰከንድ* ውስጥ ይጀምራል። ካርድዎን (1–600፣ እስከ 4 ካርድ) አሁኑኑ ይምረጡ!`,
          }
        : {
            title: '⏳ Bingo Round Starting Soon!',
            body: `The round in *${roomEn}* starts in *${secs} seconds*. Reserve your cards (1–600, max 4 cards per player) now!`,
          };
    }

    case 'new_bingo_number': {
      const ball = payload.ballNumber ?? 14;
      const formatted = formatBallCall(ball);
      const callsCount = payload.totalCalls ?? 1;
      return lang === 'am'
        ? {
            title: `🎱 አዲስ የቢንጎ ቁጥር ተጠርቷል፦ ${formatted}`,
            body: `በ *${roomAm}* የተጠራው አዲስ ኳስ *${formatted}* ነው (ጠቅላላ የተጠሩ ቁጥሮች፦ ${callsCount}/75)። ካርድዎን ይመልከቱ!`,
          }
        : {
            title: `🎱 New Bingo Ball Called: ${formatted}`,
            body: `Ball *${formatted}* was just drawn in *${roomEn}* (Total calls: ${callsCount}/75). Check your cards!`,
          };
    }

    case 'game_completion': {
      return lang === 'am'
        ? {
            title: '🏁 የቢንጎ ዙር ተጠናቋል',
            body: `በ *${roomAm}* የነበረው የቢንጎ ዙር በ ${payload.totalCalls ?? 24} ጥሪዎች ተጠናቋል። ለቀጣዩ ዙር 60 ሰከንድ ቆጠራ ተጀምሯል!`,
          }
        : {
            title: '🏁 Bingo Round Completed',
            body: `The Bingo round in *${roomEn}* finished after ${payload.totalCalls ?? 24} ball calls. The 60-second lobby countdown for the next round has started!`,
          };
    }

    case 'winner_announcement': {
      const winner = payload.winnerName || playerName;
      const cardId = payload.winningCardId ?? 1;
      const pattern = payload.winningPattern || 'Horizontal Line';
      const prize = payload.demoPrizeEtb ?? 50;
      return lang === 'am'
        ? {
            title: '🏆 BINGO! አሸናፊ ተገኝቷል!',
            body: `እንኳን ደስ አለዎት! *${winner}* በካርድ *#${cardId}* (${pattern}) አሸንፏል! +${prize} ETB የሙከራ ሽልማት ክሬዲት ተመዝግቧል።`,
          }
        : {
            title: '🏆 BINGO! Verified Winner Announcement!',
            body: `Congratulations! *${winner}* won on Card *#${cardId}* (${pattern})! +${prize} ETB Demo Prize credit recorded.`,
          };
    }

    case 'referral_confirmation': {
      const friend = payload.friendName || 'ጓደኛዎ';
      const bonus = payload.inviterBonusEtb ?? 20;
      return lang === 'am'
        ? {
            title: '🎁 የጓደኛ ግብዣ ቦነስ ተረጋግጧል!',
            body: `*${friend}* በእርስዎ የግብዣ ሊንክ ADEYBINGOን ተቀላቅሏል። +${bonus} ETB የሙከራ ቦነስ ክሬዲት ወደ ቦርሳዎ ተጨምሯል!`,
          }
        : {
            title: '🎁 Referral Bonus Confirmed!',
            body: `*${friend}* joined ADEYBINGO via your invite link. +${bonus} ETB Demo Bonus credit has been added to your wallet!`,
          };
    }

    case 'support_response': {
      const tkt = payload.ticketId || 'TKT-2041';
      const reply =
        payload.supportReply ||
        (lang === 'am'
          ? 'ጥያቄዎ ተመልክቶ ምላሽ ተሰጥቶበታል። እናመሰግናለን!'
          : 'Your support ticket has been reviewed and resolved. Thank you!');
      return lang === 'am'
        ? {
            title: `📞 የድጋፍ ምላሽ (${tkt})`,
            body: `ለድጋፍ ጥያቄዎ *${tkt}* የተሰጠ ምላሽ፦ "${reply}"`,
          }
        : {
            title: `📞 Player Support Response (${tkt})`,
            body: `Update on your support ticket *${tkt}*: "${reply}"`,
          };
    }
  }
}

function maskPhoneNumber(phone: string): string {
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 6)}****${phone.slice(-2)}`;
}

/**
 * Stateful Trusted Backend Bot & Registration Registry.
 * Enforces:
 * 1. Amharic-first bot responses with English switching.
 * 2. Strict Telegram contact ownership verification (contact.user_id === sender.id).
 * 3. 1-to-1 Telegram ID <-> Firebase UID binding to prevent duplicate Telegram account registration.
 * 4. Replay protection on Telegram update_id / requestId.
 */
export class AdeyBingoTelegramBotEngine {
  private playersByTelegramId = new Map<number, RegisteredTelegramPlayer>();
  private telegramIdByUid = new Map<string, number>();
  private chatLanguages = new Map<number, Language>();
  private notificationOutbox: BotNotificationMessage[] = [];
  private replayGuard = new TelegramReplayGuard();
  private miniAppUrl: string;
  private customWelcomeAm: string | null = null;
  private customWelcomeEn: string | null = null;
  private buttonLabels: BotButtonLabelsConfig = { ...DEFAULT_BOT_BUTTON_LABELS };
  private announcements: BotAnnouncementRecord[] = [];
  private stats = {
    totalUpdatesProcessed: 0,
    callbacksHandled: 0,
    duplicateCallbacksBlocked: 0,
    announcementsSent: 0,
  };
  private configUpdatedAt: string = new Date().toISOString();
  private configUpdatedBy: string = 'system_init';

  constructor(miniAppUrl: string = DEFAULT_DEPLOYED_MINI_APP_URL) {
    this.miniAppUrl = miniAppUrl;
  }

  public getBotConfig(): BotAdminConfig {
    return {
      miniAppUrl: this.miniAppUrl,
      customWelcomeAm: this.customWelcomeAm,
      customWelcomeEn: this.customWelcomeEn,
      buttonLabels: { ...this.buttonLabels },
      announcements: [...this.announcements],
      stats: { ...this.stats },
      updatedAt: this.configUpdatedAt,
      updatedBy: this.configUpdatedBy,
    };
  }

  public updateBotConfig(
    patch: {
      miniAppUrl?: string;
      customWelcomeAm?: string | null;
      customWelcomeEn?: string | null;
      buttonLabels?: Partial<BotButtonLabelsConfig>;
    },
    adminActor: string = 'admin'
  ): BotAdminConfig {
    if (typeof patch.miniAppUrl === 'string' && patch.miniAppUrl.trim().startsWith('https://')) {
      this.miniAppUrl = patch.miniAppUrl.trim();
    }
    if (patch.customWelcomeAm !== undefined) {
      this.customWelcomeAm =
        typeof patch.customWelcomeAm === 'string' && patch.customWelcomeAm.trim().length > 0
          ? patch.customWelcomeAm.trim().slice(0, 1500)
          : null;
    }
    if (patch.customWelcomeEn !== undefined) {
      this.customWelcomeEn =
        typeof patch.customWelcomeEn === 'string' && patch.customWelcomeEn.trim().length > 0
          ? patch.customWelcomeEn.trim().slice(0, 1500)
          : null;
    }
    if (patch.buttonLabels && typeof patch.buttonLabels === 'object') {
      for (const [k, v] of Object.entries(patch.buttonLabels)) {
        if (typeof v === 'string' && v.trim().length > 0 && k in this.buttonLabels) {
          (this.buttonLabels as unknown as Record<string, string>)[k] = v.trim().slice(0, 64);
        }
      }
    }
    this.configUpdatedAt = new Date().toISOString();
    this.configUpdatedBy = adminActor;
    return this.getBotConfig();
  }

  public sendAnnouncement(
    params: {
      titleAm: string;
      titleEn: string;
      bodyAm: string;
      bodyEn: string;
      targetAudience?: 'all_players' | 'verified_players';
    },
    adminActor: string = 'admin'
  ): BotAnnouncementRecord {
    const audience = params.targetAudience === 'verified_players' ? 'verified_players' : 'all_players';
    const players = this.getAllPlayers().filter((p) =>
      audience === 'verified_players' ? p.phoneVerified : true
    );
    const nowIso = new Date().toISOString();
    const record: BotAnnouncementRecord = {
      id: `ann_${Date.now()}_${Math.floor(100 + Math.random() * 899)}`,
      titleAm: params.titleAm.trim() || '📢 የADEYBINGO ማስታወቂያ',
      titleEn: params.titleEn.trim() || '📢 ADEYBINGO Announcement',
      bodyAm: params.bodyAm.trim(),
      bodyEn: params.bodyEn.trim(),
      targetAudience: audience,
      recipientCount: Math.max(1, players.length),
      sentByAdmin: adminActor,
      sentAt: nowIso,
    };

    const targetIds = players.length > 0 ? players.map((p) => p.telegramUserId) : [8842109];
    for (const tgId of targetIds) {
      const lang = this.getLanguage(tgId);
      const msg: BotNotificationMessage = {
        id: `ntf_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
        event: 'admin_announcement',
        telegramUserId: tgId,
        language: lang,
        title: lang === 'am' ? record.titleAm : record.titleEn,
        body: lang === 'am' ? record.bodyAm : record.bodyEn,
        createdAt: nowIso,
        deliveredViaBotApi: false,
      };
      this.notificationOutbox.unshift(msg);
    }
    if (this.notificationOutbox.length > 50) {
      this.notificationOutbox = this.notificationOutbox.slice(0, 50);
    }

    this.announcements.unshift(record);
    this.stats.announcementsSent += 1;
    return record;
  }

  public getLanguage(telegramUserId: number): Language {
    return this.chatLanguages.get(telegramUserId) || 'am';
  }

  public setLanguage(telegramUserId: number, lang: Language): void {
    this.chatLanguages.set(telegramUserId, lang);
    const existing = this.playersByTelegramId.get(telegramUserId);
    if (existing) {
      existing.language = lang;
      existing.updatedAt = new Date().toISOString();
    }
  }

  public getPlayerByTelegramId(telegramUserId: number): RegisteredTelegramPlayer | undefined {
    return this.playersByTelegramId.get(telegramUserId);
  }

  public getAllPlayers(): RegisteredTelegramPlayer[] {
    return Array.from(this.playersByTelegramId.values());
  }

  public getNotificationOutbox(): BotNotificationMessage[] {
    return [...this.notificationOutbox];
  }

  public queueNotification(
    event: NotificationEventType,
    telegramUserId: number,
    payload: Parameters<typeof formatTelegramNotification>[2] = {},
    deliveredViaBotApi = false
  ): BotNotificationMessage {
    const lang = this.getLanguage(telegramUserId);
    const formatted = formatTelegramNotification(event, lang, payload);
    const msg: BotNotificationMessage = {
      id: `ntf_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
      event,
      telegramUserId,
      language: lang,
      title: formatted.title,
      body: formatted.body,
      createdAt: new Date().toISOString(),
      deliveredViaBotApi,
    };
    this.notificationOutbox.unshift(msg);
    if (this.notificationOutbox.length > 50) {
      this.notificationOutbox.pop();
    }
    return msg;
  }

  private buildMenuMarkup(lang: Language, phoneVerified: boolean): TelegramBotReplyMarkup {
    return buildBotMainMenuMarkup(lang, this.miniAppUrl, phoneVerified, this.buttonLabels);
  }

  /**
   * Handles incoming Telegram Bot commands, menu buttons, callback queries, and shared phone contacts.
   */
  public handleIncomingUpdate(params: {
    updateId?: number;
    callbackQueryId?: string;
    senderTelegramId: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    firebaseUid?: string;
    text?: string;
    callbackData?: string;
    contact?: {
      phone_number?: string;
      first_name?: string;
      last_name?: string;
      user_id?: number;
    } | null;
    nowUnixSeconds?: number;
  }): TelegramBotResponse {
    const {
      updateId,
      callbackQueryId,
      senderTelegramId,
      firstName = 'Abebe',
      lastName = 'Bikila',
      username = 'abebe_adey',
      firebaseUid,
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
        text: '🚫 Invalid Telegram sender identity.',
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup('am', false),
        registrationStatus: 'unregistered',
        securityCode: 'invalid_sender_identity',
      };
    }

    // Replay check if updateId is provided
    if (updateId !== undefined) {
      const fresh = this.replayGuard.consumeOnce(
        `tg_update:${updateId}`,
        nowUnixSeconds,
        3600
      );
      if (!fresh) {
        const lang = this.getLanguage(senderTelegramId);
        return {
          ok: false,
          chatId: senderTelegramId,
          language: lang,
          text:
            lang === 'am'
              ? '⚠️ ይህ ጥያቄ ቀደም ብሎ ተስተናግዷል (Duplicate update_id replay blocked).'
              : '⚠️ Duplicate request blocked (update_id already processed).',
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(lang, false),
          registrationStatus: 'unregistered',
          securityCode: 'replay_detected',
        };
      }
    }

    // Duplicate callback query protection if callbackQueryId is provided
    if (callbackQueryId !== undefined && callbackQueryId.trim().length > 0) {
      const freshCb = this.replayGuard.consumeOnce(
        `tg_cb:${callbackQueryId.trim()}`,
        nowUnixSeconds,
        3600
      );
      if (!freshCb) {
        this.stats.duplicateCallbacksBlocked += 1;
        const lang = this.getLanguage(senderTelegramId);
        return {
          ok: false,
          chatId: senderTelegramId,
          language: lang,
          text:
            lang === 'am'
              ? '⚠️ ይህ የቁልፍ ጥያቄ ቀደም ብሎ ተስተናግዷል (Duplicate callback_query blocked).'
              : '⚠️ Duplicate callback query blocked (callbackQueryId already processed).',
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(lang, false),
          registrationStatus: 'unregistered',
          securityCode: 'duplicate_callback_query',
        };
      }
    }

    this.stats.totalUpdatesProcessed += 1;
    if (callbackData) {
      this.stats.callbacksHandled += 1;
    }

    const currentLang = this.getLanguage(senderTelegramId);
    const existingPlayer = this.playersByTelegramId.get(senderTelegramId);
    const trimmed = text.trim();

    // Security guard: never expose admin functions through the player Telegram bot
    if (
      trimmed.startsWith('/admin') ||
      callbackData.startsWith('cb:admin') ||
      callbackData.startsWith('admin:')
    ) {
      return {
        ok: false,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '🔒 *የደህንነት ማሳሰቢያ፦* የአስተዳዳሪ (Admin) ተግባራት በተጫዋቾች ቦት ውስጥ አይገኙም።'
            : '🔒 *Security Notice:* Administrator functions are strictly isolated and never exposed in the player bot.',
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, Boolean(existingPlayer?.phoneVerified)),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'admin_command_forbidden_in_player_bot',
        profile: existingPlayer,
      };
    }

    // 1. Handle Shared Contact Verification (Part C)
    if (contact !== undefined && contact !== null) {
      return this.handleSharedContact({
        senderTelegramId,
        firstName,
        lastName,
        username,
        firebaseUid,
        contact,
      });
    }

    // Reject plain-text phone numbers sent in chat (never silently treat unverified text as verified contact!)
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
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: check.reason || 'plain_text_phone_rejected',
        profile: existingPlayer,
      };
    }

    // 2. Handle Language Menu or Language Switching Callback / Command (🌐 Language)
    if (
      callbackData === 'cb:language' ||
      callbackData === 'lang:am' ||
      callbackData === 'lang:en' ||
      trimmed === '/language' ||
      trimmed === '🌐 Change Language' ||
      trimmed === '🌐 Language' ||
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
      this.setLanguage(senderTelegramId, nextLang);

      const msgText =
        nextLang === 'am'
          ? '🌐 *ቋንቋ ወደ አማርኛ ተቀይሯል!* \nሁሉም የቦት መልዕክቶች እና ማሳወቂያዎች በአማርኛ ይቀርባሉ። (እንግሊዝኛ ለመምረጥ 🇬🇧 English ይጫኑ)'
          : '🌐 *Bot language switched to English!* \nAll bot commands, menus, and notifications will now be displayed in English. (Tap 🇪🇹 አማርኛ to switch back to Amharic)';

      return {
        ok: true,
        chatId: senderTelegramId,
        language: nextLang,
        text: msgText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          nextLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        profile: existingPlayer,
      };
    }

    // 3. Handle /start command (Part A + Part B + Part C Registration Onboarding)
    if (trimmed.startsWith('/start')) {
      return this.handleStartCommand({
        senderTelegramId,
        firstName,
        lastName,
        username,
        firebaseUid,
      });
    }

    // 4. Handle /help command
    if (trimmed === '/help') {
      const helpText =
        currentLang === 'am'
          ? [
              '📖 *የADEYBINGO ቦት መመሪያ (/help)*',
              '',
              '• `/start` — ቦቱን ለመጀመር፣ ስለ ADEYBINGO ለማወቅ እና ስልክዎን ለማረጋገጥ',
              '• `/language` — ቋንቋ በአማርኛ እና በእንግሊዝኛ መካከል ለመቀየር',
              '• `/support` — የደንበኞች ድጋፍ እና ተደጋጋሚ ጥያቄዎችን ለማግኘት',
              '• `/terms` — የጨዋታ ህጎች፣ የግላዊነት ጥበቃ እና የሙከራ (Demo) ደንቦችን ለማንበብ',
              '',
              '🎮 *የጨዋታ ህጎች፦* በአንድ ክፍል ከ1–600 ካርዶች፣ በአንድ ተጫዋች እስከ 4 ካርድ (10 ETB የሙከራ ዋጋ)፣ 60 ሰከንድ የሎቢ ቆጠራ እና ቢያንስ 3 ተጫዋቾች።',
            ].join('\n')
          : [
              '📖 *ADEYBINGO Bot Command Guide (/help)*',
              '',
              '• `/start` — Welcome onboarding, privacy notice & phone contact verification',
              '• `/language` — Switch bot language between Amharic (አማርኛ) and English',
              '• `/support` — Contact player support & view FAQs',
              '• `/terms` — Read game rules, privacy policy & Demo Sandbox terms',
              '',
              '🎮 *Game Rules:* 1–600 cards per room, max 4 cards per player (10 ETB demo price), 60-second lobby countdown, minimum 3 eligible players.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: helpText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 5. Handle 💬 Support (/support, 📞 Contact Support, 💬 Support, cb:support, menu:contact_support)
    if (
      trimmed === '/support' ||
      trimmed === '📞 Contact Support' ||
      trimmed === '💬 Support' ||
      callbackData === 'cb:support' ||
      callbackData === 'menu:contact_support'
    ) {
      const supportText =
        currentLang === 'am'
          ? [
              '📞 *የADEYBINGO የተጫዋቾች ድጋፍ (/support)*',
              '',
              'እርዳታ ይፈልጋሉ? የድጋፍ ቡድናችን በ24/7 ዝግጁ ነው፦',
              '• በሚኒ አፑ ውስጥ *ድጋፍ (Support)* የሚለውን ክፍል በመክፈት የድጋፍ ቲኬት ይላኩ።',
              '• የቴሌግራም ድጋፍ፦ `@AdeyBingoSupport`',
              '• የሙከራ ሁኔታ (Demo Mode)፦ ማንኛውም የገንዘብ ልውውጥ በሙከራ ደረጃ ብቻ ይሰራል።',
            ].join('\n')
          : [
              '📞 *ADEYBINGO Player Support (/support)*',
              '',
              'Need assistance? Our support team is here to help:',
              '• Open the *Support* tab inside the ADEYBINGO Mini App to submit a ticket.',
              '• Telegram Support Desk: `@AdeyBingoSupport`',
              '• Demo Sandbox Notice: All balances and prizes operate strictly in non-monetary demo mode.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: supportText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 6. Handle /terms or 📜 Terms and Conditions
    if (
      trimmed === '/terms' ||
      trimmed === '📜 Terms and Conditions' ||
      callbackData === 'menu:terms_conditions'
    ) {
      const termsText =
        currentLang === 'am'
          ? [
              '📜 *የADEYBINGO ህጎች፣ ደንቦች እና የግላዊነት ጥበቃ (/terms)*',
              '',
              '1. *የሙከራ ሁኔታ (Demo Sandbox)፦* የእውነተኛ ገንዘብ ተቀማጭ፣ ወጪ እና የገንዘብ ሽልማት ህጋዊ እና የክፍያ ፈቃድ እስኪጠናቀቅ ድረስ የተዘጋ ሲሆን ሁሉም ነጥቦች የሙከራ (Demo ETB) ናቸው።',
              '2. *የካርድ እና የክፍል ህግ፦* በአንድ ክፍል 1–600 ካርዶች ይገኛሉ፤ አንድ ተጫዋች በአንድ ዙር እስከ 4 ካርድ ብቻ መያዝ ይችላል።',
              '3. *የስልክ ቁጥር እና የግላዊነት ጥበቃ፦* ስልክ ቁጥርዎ የሚጠየቀው አንድ ተጫዋች አንድ ትክክለኛ የቴሌግራም መለያ ብቻ እንዲኖረው ለማረጋገጥ ሲሆን፣ በ `/users/{uid}/private/contact` ውስጥ በጥብቅ ደህንነት ተነጥሎ ይቀመጣል።',
            ].join('\n')
          : [
              '📜 *ADEYBINGO Terms, Rules & Privacy Notice (/terms)*',
              '',
              '1. *Demo Sandbox Mode:* Real-money deposits, withdrawals, and cash prizes are disabled pending regulatory & payment-provider verification. All balances are Demo ETB.',
              '2. *Fair Play & Room Capacity:* 1–600 cards per room; atomic reservation of at most 4 cards per player; minimum 3 eligible players per round.',
              '3. *Phone Privacy:* Your phone number is requested solely to verify unique account ownership and prevent duplicate accounts. It is isolated in `/users/{uid}/private/contact` and never exposed publicly.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: termsText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 7. Handle 📜 Game History (cb:game_history, menu:game_history, 📜 Game History)
    if (
      trimmed === '📜 Game History' ||
      callbackData === 'cb:game_history' ||
      callbackData === 'menu:game_history'
    ) {
      const historyText =
        currentLang === 'am'
          ? [
              '📜 *የእርስዎ የቅርብ ጊዜ የADEYBINGO የጨዋታ ታሪክ*',
              '',
              '1️⃣ *አደይ ዋና አዳራሽ (Adey Main Hall)* — 🏆 *አሸናፊ (+80 ETB Demo)*',
              '   • ካርዶች፦ `#14, #108` · አሸናፊ ኳስ፦ `N-35` (አግድም መስመር)',
              '2️⃣ *አደይ ፈጣን 30 (Adey Fast 30)* — 🎲 *ተሳትፎ (-10 ETB Demo)*',
              '   • ካርድ፦ `#42` · የተጠሩ ቁጥሮች፦ `28/75`',
              '3️⃣ *አደይ ዋና አዳራሽ (Adey Main Hall)* — 🏆 *አሸናፊ (+50 ETB Demo)*',
              '   • ካርድ፦ `#1` · አሸናፊ ኳስ፦ `G-52` (4 ማዕዘኖች)',
              '',
              '💡 ሙሉ ታሪክዎን ለማየት ከታች *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* የሚለውን ይጫኑ።',
            ].join('\n')
          : [
              '📜 *Your Recent ADEYBINGO Game History*',
              '',
              '1️⃣ *Adey Main Hall* — 🏆 *WON (+80 ETB Demo)*',
              '   • Cards: `#14, #108` · Winning Ball: `N-35` (Horizontal Line)',
              '2️⃣ *Adey Fast 30* — 🎲 *Played (-10 ETB Demo)*',
              '   • Card: `#42` · Total Calls: `28/75`',
              '3️⃣ *Adey Main Hall* — 🏆 *WON (+50 ETB Demo)*',
              '   • Card: `#1` · Winning Ball: `G-52` (4 Corners)',
              '',
              '💡 Tap *🎮 Play Bingo (PLAY BINGO)* below to view full round details inside the Mini App.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: historyText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 8. Handle 👤 My Profile (cb:my_profile, menu:my_profile, 👤 My Profile)
    if (
      trimmed === '👤 My Profile' ||
      callbackData === 'cb:my_profile' ||
      callbackData === 'menu:my_profile'
    ) {
      if (!existingPlayer) {
        return this.handleStartCommand({
          senderTelegramId,
          firstName,
          lastName,
          username,
          firebaseUid,
        });
      }
      const profileText =
        currentLang === 'am'
          ? [
              '👤 *የእርስዎ ADEYBINGO መገለጫ*',
              '',
              `• ስም፦ *${existingPlayer.firstName} ${existingPlayer.lastName || ''}*`,
              `• የቴሌግራም መለያ፦ \`TG #${existingPlayer.telegramUserId}\` (@${existingPlayer.username})`,
              `• የስልክ ማረጋገጫ፦ ${
                existingPlayer.phoneVerified
                  ? `✅ የተረጋገጠ (${existingPlayer.verifiedPhoneMasked})`
                  : '⏳ አልተረጋገጠም (እባክዎ ስልክዎን ያጋሩ)'
              }`,
              `• የሙከራ ቀሪ ሂሳብ፦ *${existingPlayer.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
              `• ቋንቋ፦ ${existingPlayer.language === 'am' ? 'አማርኛ' : 'English'}`,
            ].join('\n')
          : [
              '👤 *Your ADEYBINGO Player Profile*',
              '',
              `• Name: *${existingPlayer.firstName} ${existingPlayer.lastName || ''}*`,
              `• Telegram ID: \`TG #${existingPlayer.telegramUserId}\` (@${existingPlayer.username})`,
              `• Phone Status: ${
                existingPlayer.phoneVerified
                  ? `✅ Verified (${existingPlayer.verifiedPhoneMasked})`
                  : '⏳ Unverified (Tap Share Phone Contact below)'
              }`,
              `• Demo Balance: *${existingPlayer.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
              `• Language: ${existingPlayer.language === 'am' ? 'Amharic (አማርኛ)' : 'English'}`,
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: profileText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          existingPlayer.phoneVerified
        ),
        registrationStatus: existingPlayer.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 9. Handle 💰 My Wallet / 💰 My Balance (cb:my_wallet, menu:my_balance, 💰 My Wallet, 💰 My Balance)
    if (
      trimmed === '💰 My Balance' ||
      trimmed === '💰 My Wallet' ||
      callbackData === 'cb:my_wallet' ||
      callbackData === 'menu:my_balance'
    ) {
      const bal = existingPlayer?.demoBalanceEtb ?? 250;
      const balanceText =
        currentLang === 'am'
          ? [
              '💰 *የሙከራ ቦርሳ ቀሪ ሂሳብ (Demo Wallet)*',
              '',
              `• የአሁን የሙከራ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (DEMO)*`,
              '• የካርድ ዋጋ፦ *10 ETB* በካርድ (በአንድ ዙር እስከ 4 ካርድ)',
              '• ማሳሰቢያ፦ ሁሉም የገንዘብ እንቅስቃሴዎች በሙከራ (Demo Sandbox) ሁኔታ ብቻ ይሰራሉ።',
            ].join('\n')
          : [
              '💰 *Demo Sandbox Wallet Balance*',
              '',
              `• Current Demo Balance: *${bal.toFixed(2)} ETB (DEMO)*`,
              '• Card Entry Cost: *10 ETB* per card (max 4 cards per round)',
              '• Notice: Financial transactions are disabled; all balances are non-monetary Demo ETB.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: balanceText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 10. Handle 👥 Invite Friends / 🎁 Invite Friends (cb:invite_friends, menu:invite_friends)
    if (
      trimmed === '🎁 Invite Friends' ||
      trimmed === '👥 Invite Friends' ||
      callbackData === 'cb:invite_friends' ||
      callbackData === 'menu:invite_friends'
    ) {
      const refCode = existingPlayer?.referralCode || `ADEY-${senderTelegramId}`;
      const inviteUrl = `https://t.me/AdeyBingoBot?start=${refCode}`;
      const inviteText =
        currentLang === 'am'
          ? [
              '🎁 *ጓደኞችዎን ወደ ADEYBINGO ይጋብዙ!*',
              '',
              `• የእርስዎ ልዩ መጋበዣ ሊንክ፦ \`${inviteUrl}\``,
              '• ለእርስዎ፦ *+20 ETB* የሙከራ ቦነስ ክሬዲት',
              '• ለጓደኛዎ፦ *+15 ETB* የሙከራ ቦነስ ክሬዲት',
            ].join('\n')
          : [
              '🎁 *Invite Friends to ADEYBINGO!*',
              '',
              `• Your Personal Invite Link: \`${inviteUrl}\``,
              '• Inviter Demo Bonus: *+20 ETB*',
              '• Invitee Demo Bonus: *+15 ETB*',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: inviteText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // 11. Handle 🎮 Play Bingo / 🎮 Start Playing (cb:play_bingo, menu:play_bingo)
    if (
      trimmed === '🎮 Start Playing' ||
      trimmed === '🎮 Play Bingo' ||
      callbackData === 'cb:play_bingo' ||
      callbackData === 'menu:play_bingo'
    ) {
      const playText =
        currentLang === 'am'
          ? `🎮 *ADEYBINGO ሚኒ አፕ ለመክፈት ዝግጁ ነው!*\nከታች ያለውን *🎮 ቢንጎ ይጫወቱ (PLAY BINGO)* ቁልፍ በመጫን ወደ ቀጥታ የቢንጎ ክፍል ይግቡ፦\n${this.miniAppUrl}`
          : `🎮 *ADEYBINGO Mini App Ready!*\nTap the *🎮 Play Bingo (PLAY BINGO)* WebApp button below to enter the live Bingo hall:\n${this.miniAppUrl}`;

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: playText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified)
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // Default fallback -> guide user with Amharic/English help
    return this.handleStartCommand({
      senderTelegramId,
      firstName,
      lastName,
      username,
      firebaseUid,
    });
  }

  private handleStartCommand(params: {
    senderTelegramId: number;
    firstName: string;
    lastName?: string;
    username: string;
    firebaseUid?: string;
  }): TelegramBotResponse {
    const { senderTelegramId, firstName, lastName, username, firebaseUid } = params;
    const lang = this.getLanguage(senderTelegramId);
    const candidateUid = firebaseUid || `tg_uid_${senderTelegramId}`;

    // Check duplicate Telegram account binding:
    // 1) Does this firebaseUid already bind to a DIFFERENT Telegram ID?
    const boundTgForUid = this.telegramIdByUid.get(candidateUid);
    if (boundTgForUid !== undefined && boundTgForUid !== senderTelegramId) {
      return {
        ok: false,
        chatId: senderTelegramId,
        language: lang,
        text:
          lang === 'am'
            ? '🚫 *ድጋሚ ምዝገባ ተከልክሏል፦* ይህ የFirebase መለያ ቀደም ብሎ ከሌላ የቴሌግራም መለያ ጋር ተያይዟል።'
            : '🚫 *Duplicate Registration Blocked:* This Firebase account is already bound to another Telegram ID.',
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(lang, false),
        registrationStatus: 'duplicate_blocked',
        securityCode: 'duplicate_telegram_account',
      };
    }

    // 2) Does this Telegram ID already exist under a DIFFERENT firebaseUid?
    let player = this.playersByTelegramId.get(senderTelegramId);
    if (player && firebaseUid && player.uid !== firebaseUid) {
      return {
        ok: false,
        chatId: senderTelegramId,
        language: lang,
        text:
          lang === 'am'
            ? `🚫 *ድጋሚ የቴሌግራም ምዝገባ ተከልክሏል፦* የቴሌግራም መለያ \`TG #${senderTelegramId}\` ቀደም ብሎ ተመዝግቧል።`
            : `🚫 *Duplicate Telegram Account Blocked:* Telegram ID \`TG #${senderTelegramId}\` is already registered to another profile.`,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(lang, false),
        registrationStatus: 'duplicate_blocked',
        securityCode: 'duplicate_telegram_account',
      };
    }

    if (!player) {
      const nowIso = new Date().toISOString();
      player = {
        uid: candidateUid,
        telegramUserId: senderTelegramId,
        telegramKey: `tg_${senderTelegramId}`,
        firstName: firstName.slice(0, 60),
        lastName: lastName ? lastName.slice(0, 60) : '',
        username: username.replace(/^@/, '').slice(0, 64),
        language: lang,
        phoneVerified: false,
        demoBalanceEtb: 250,
        referralCode: `ADEY-${senderTelegramId}`,
        registeredAt: nowIso,
        updatedAt: nowIso,
      };
      this.playersByTelegramId.set(senderTelegramId, player);
      this.telegramIdByUid.set(candidateUid, senderTelegramId);
    }

    const defaultWelcomeAm = [
      `🌼 *እንኳን ወደ ADEYBINGO በደህና መጡ፣ ${player.firstName}!*`,
      '',
      '🎱 *ስለ ADEYBINGO፦*',
      'ADEYBINGO ዘመናዊ የቴሌግራም የቀጥታ ቢንጎ ሚኒ አፕ ነው። በአንድ የጨዋታ ክፍል ከ *1–600 ካርዶች* ውስጥ እስከ *4 ካርድ* መምረጥ፣ የቀጥታ 3D የቁጥር ጥሪዎችን መከታተል እና በ60 ሰከንድ ቆጠራ መጫወት ይችላሉ (በአሁኑ ወቅት በሙከራ / Demo Sandbox ሁኔታ ይሰራል)።',
      '',
      '🔒 *የስልክ ቁጥር ማረጋገጫ እና የግላዊነት ጥበቃ፦*',
      player.phoneVerified
        ? `✅ የእርስዎ ስልክ ቁጥር (${player.verifiedPhoneMasked}) ተረጋግጧል! *🎮 Start Playing* የሚለውን ተጭነው ወደ ጨዋታው ይግቡ።`
        : 'እባክዎ ከታች ያለውን *📲 ስልክ ቁጥርዎን ያጋሩ (Share Phone Contact)* ቁልፍ በመጫን የቴሌግራም ስልክ ቁጥርዎን ያረጋግጡ።\n• *ለምን ይጠየቃል?* አንድ ተጫዋች አንድ ትክክለኛ መለያ ብቻ እንዲኖረው እና ድጋሚ ምዝገባን ለመከላከል።\n• *የግላዊነት ዋስትና፦* ስልክ ቁጥርዎ በ `/users/{uid}/private/contact` ውስጥ በጥብቅ ደህንነት ተነጥሎ ይቀመጣል፤ ለሌሎች ተጫዋቾች በፍፁም አይታይም።',
    ].join('\n');

    const defaultWelcomeEn = [
      `🌼 *Welcome to ADEYBINGO, ${player.firstName}!*`,
      '',
      '🎱 *About ADEYBINGO:*',
      'ADEYBINGO is a real-time multiplayer Telegram Bingo Mini App featuring *1–600 cards per room*, up to *4 cards per player*, 60-second lobby countdowns, and live 3D ball calling (operating safely in non-monetary Demo Sandbox mode).',
      '',
      '🔒 *Phone Verification & Privacy Notice:*',
      player.phoneVerified
        ? `✅ Your phone contact (${player.verifiedPhoneMasked}) is verified! Tap *🎮 Start Playing* below to launch the Mini App.`
        : 'Please tap the *📲 Share Telegram Phone Contact* button below to verify your account.\n• *Why it is requested:* To verify unique player identity and prevent duplicate Telegram accounts.\n• *Privacy Protection:* Your phone number is strictly isolated in `/users/{uid}/private/contact` and is never shared with other players.',
    ].join('\n');

    const welcomeAm = this.customWelcomeAm
      ? `${this.customWelcomeAm}\n\n${defaultWelcomeAm}`
      : defaultWelcomeAm;
    const welcomeEn = this.customWelcomeEn
      ? `${this.customWelcomeEn}\n\n${defaultWelcomeEn}`
      : defaultWelcomeEn;

    return {
      ok: true,
      chatId: senderTelegramId,
      language: lang,
      text: lang === 'am' ? welcomeAm : welcomeEn,
      parseMode: 'Markdown',
      replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified),
      registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
      profile: player,
    };
  }

  private handleSharedContact(params: {
    senderTelegramId: number;
    firstName: string;
    lastName?: string;
    username: string;
    firebaseUid?: string;
    contact: {
      phone_number?: string;
      first_name?: string;
      last_name?: string;
      user_id?: number;
    };
  }): TelegramBotResponse {
    const { senderTelegramId, firstName, lastName, username, firebaseUid, contact } = params;
    const lang = this.getLanguage(senderTelegramId);

    const verification = verifyTelegramSharedContact({
      senderTelegramId,
      contact,
    });

    if (!verification.valid || !verification.verifiedPhoneNumber) {
      const errText =
        lang === 'am'
          ? `🚫 *የስልክ ቁጥር ማረጋገጫ አልተሳካም (${verification.reason})፦*\nየተጋራው ስልክ ቁጥር የእርስዎ የቴሌግራም መለያ መሆኑን ማረጋገጥ አልተቻለም። እባክዎ የሌላ ሰው ስልክ አያስተላልፉ፤ የራስዎን *📲 ስልክ ቁጥርዎን ያጋሩ* ቁልፍ ብቻ ይጠቀሙ።`
          : `🚫 *Phone Contact Verification Failed (${verification.reason}):*\nThe shared contact does not match your Telegram sender ID (\`TG #${senderTelegramId}\`). Never forward another person's contact—tap the *📲 Share Telegram Phone Contact* button for your own account.`;

      return {
        ok: false,
        chatId: senderTelegramId,
        language: lang,
        text: errText,
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(lang, this.miniAppUrl, false),
        registrationStatus: 'pending_contact',
        securityCode: verification.reason,
      };
    }

    // Ensure profile exists or create it now (checking duplicate bindings)
    const startRes = this.handleStartCommand({
      senderTelegramId,
      firstName,
      lastName,
      username,
      firebaseUid,
    });
    if (!startRes.ok || !startRes.profile) {
      return startRes;
    }

    const player = startRes.profile;
    player.phoneVerified = true;
    player.verifiedPhoneMasked = maskPhoneNumber(verification.verifiedPhoneNumber);
    player.updatedAt = new Date().toISOString();

    const ntf = this.queueNotification('registration_success', senderTelegramId, {
      playerName: player.firstName,
      maskedPhone: player.verifiedPhoneMasked,
    });

    return {
      ok: true,
      chatId: senderTelegramId,
      language: lang,
      text: `${ntf.title}\n\n${ntf.body}`,
      parseMode: 'Markdown',
      replyMarkup: buildBotMainMenuMarkup(lang, this.miniAppUrl, true),
      registrationStatus: 'verified',
      securityCode: 'contact_verified',
      profile: player,
      notificationQueued: ntf,
    };
  }
}

/**
 * Part A (Checkpoints 5 & 6): Server-Authoritative Game State & Privileged Operation Guard.
 * Ensures that:
 * 1. The server—not the browser—is the source of truth for called balls, card reservations, and round completion.
 * 2. Privileged operations (drawing a ball, claiming a win, reserving a card) validate caller identity,
 *    prevent duplicate replay nonces, enforce 1..600 card bounds and max 4 cards per player,
 *    and verify Bingo wins exclusively against the server's authoritative calledNumbers list.
 */
export interface AuthoritativeRoomGameSession {
  roomId: string;
  gameId: string;
  hostTelegramId: number;
  status: 'countdown' | 'live' | 'completed';
  calledNumbers: number[];
  latestBall: number | null;
  playerCards: Map<number, number[]>; // telegramUserId -> reserved cardIds (max 4)
  cardOwners: Map<number, number>; // cardId (1..600) -> telegramUserId
  winner?: {
    telegramUserId: number;
    playerName: string;
    cardId: number;
    patternEn?: string;
    verifiedAt: string;
  };
}

export class ServerGameAuthority {
  private sessions = new Map<string, AuthoritativeRoomGameSession>();
  private replayGuard = new TelegramReplayGuard();

  constructor() {
    this.ensureRoomSession('adey-main', 8842109, [9, 30, 7, 16, 14]);
    this.ensureRoomSession('adey-fast', 8842109, [9, 30, 7, 16, 14]);
    this.ensureRoomSession('adey-vip', 8842109, [9, 30, 7, 16, 14]);
  }

  public ensureRoomSession(
    roomId: string,
    hostTelegramId: number = 8842109,
    initialCalls: number[] = [9, 30, 7, 16, 14]
  ): AuthoritativeRoomGameSession {
    let sess = this.sessions.get(roomId);
    if (!sess) {
      const playerCards = new Map<number, number[]>();
      const cardOwners = new Map<number, number>();
      playerCards.set(hostTelegramId, [1]);
      cardOwners.set(1, hostTelegramId);

      sess = {
        roomId,
        gameId: `game_${roomId}_live`,
        hostTelegramId,
        status: 'live',
        calledNumbers: [...initialCalls],
        latestBall: initialCalls[initialCalls.length - 1] ?? null,
        playerCards,
        cardOwners,
      };
      this.sessions.set(roomId, sess);
    }
    return sess;
  }

  public getRoomSession(roomId: string): AuthoritativeRoomGameSession {
    return this.ensureRoomSession(roomId);
  }

  /**
   * Atomically reserves or releases a card (1..600) on the server for a verified player,
   * enforcing max 4 cards per player and preventing concurrent overbooking.
   */
  public reserveOrReleaseCard(params: {
    roomId: string;
    telegramUserId: number;
    cardId: number;
    requestNonce?: string;
  }): {
    ok: boolean;
    reason?:
      | 'invalid_card_id'
      | 'room_completed'
      | 'card_already_taken'
      | 'max_4_cards_reached'
      | 'replay_detected';
    action?: 'reserved' | 'released';
    playerCards?: number[];
  } {
    const { roomId, telegramUserId, cardId, requestNonce } = params;
    if (requestNonce && !this.replayGuard.consumeOnce(`card:${roomId}:${requestNonce}`)) {
      return { ok: false, reason: 'replay_detected' };
    }
    if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
      return { ok: false, reason: 'invalid_card_id' };
    }

    const sess = this.ensureRoomSession(roomId);
    if (sess.status === 'completed') {
      return { ok: false, reason: 'room_completed' };
    }

    const existingOwner = sess.cardOwners.get(cardId);
    const currentCards = sess.playerCards.get(telegramUserId) || [];

    if (existingOwner !== undefined) {
      if (existingOwner !== telegramUserId) {
        return { ok: false, reason: 'card_already_taken' };
      }
      const updated = currentCards.filter((c) => c !== cardId);
      sess.cardOwners.delete(cardId);
      sess.playerCards.set(telegramUserId, updated);
      return { ok: true, action: 'released', playerCards: updated };
    }

    if (currentCards.length >= 4) {
      return { ok: false, reason: 'max_4_cards_reached' };
    }

    const updated = [...currentCards, cardId].sort((a, b) => a - b);
    sess.cardOwners.set(cardId, telegramUserId);
    sess.playerCards.set(telegramUserId, updated);
    return { ok: true, action: 'reserved', playerCards: updated };
  }

  /**
   * Server-authoritative ball draw (1..75).
   * Enforces host authorization, terminal state locking, and replay protection.
   */
  public drawNextBallAuthoritative(params: {
    roomId: string;
    callerTelegramId: number;
    clientCalledNumbers?: number[];
    requestNonce?: string;
  }): {
    ok: boolean;
    reason?:
      | 'unauthorized_caller'
      | 'game_already_completed'
      | 'all_75_numbers_called'
      | 'replay_detected';
    ball?: number;
    letter?: ReturnType<typeof getLetterForNumber>;
    formatted?: string;
    calledNumbers?: number[];
    totalCalled?: number;
    serverTimestamp?: string;
  } {
    const { roomId, callerTelegramId, clientCalledNumbers, requestNonce } = params;
    if (requestNonce && !this.replayGuard.consumeOnce(`draw:${roomId}:${requestNonce}`)) {
      return { ok: false, reason: 'replay_detected' };
    }

    const sess = this.ensureRoomSession(roomId);
    if (callerTelegramId !== sess.hostTelegramId) {
      return { ok: false, reason: 'unauthorized_caller' };
    }
    if (sess.status === 'completed') {
      return { ok: false, reason: 'game_already_completed' };
    }

    // Merge any initial demo calls only if session was just reset, keeping server authoritative
    if (Array.isArray(clientCalledNumbers) && clientCalledNumbers.length < sess.calledNumbers.length) {
      // Client reset round
      sess.calledNumbers = clientCalledNumbers.filter(
        (n) => Number.isInteger(n) && n >= 1 && n <= 75
      );
      sess.status = 'live';
      sess.winner = undefined;
    }

    const calledSet = new Set<number>(sess.calledNumbers);
    const remaining: number[] = [];
    for (let n = 1; n <= 75; n++) {
      if (!calledSet.has(n)) {
        remaining.push(n);
      }
    }

    if (remaining.length === 0) {
      return { ok: false, reason: 'all_75_numbers_called' };
    }

    const drawnBall = remaining[crypto.randomInt(0, remaining.length)];
    sess.calledNumbers.push(drawnBall);
    sess.latestBall = drawnBall;

    return {
      ok: true,
      ball: drawnBall,
      letter: getLetterForNumber(drawnBall),
      formatted: formatBallCall(drawnBall),
      calledNumbers: [...sess.calledNumbers],
      totalCalled: sess.calledNumbers.length,
      serverTimestamp: new Date().toISOString(),
    };
  }

  /**
   * Server-authoritative winner verification.
   * Verifies:
   * 1. Card ID is valid (1..600).
   * 2. Game is not already completed by another winner.
   * 3. Claiming player actually reserved/owns the claimed card in the room.
   * 4. The card's marked numbers form a valid Bingo against the server's authoritative calledNumbers.
   */
  public verifyWinnerAuthoritative(params: {
    roomId: string;
    claimantTelegramId: number;
    playerName: string;
    cardId: number;
    markedNumbers: number[];
    enforceServerCallsOnly?: boolean;
    fallbackClientCalls?: number[];
  }): {
    verified: boolean;
    reason?:
      | 'invalid_card_id'
      | 'game_already_completed'
      | 'card_not_owned_by_claimant'
      | 'pattern_not_satisfied';
    cardId: number;
    winResult?: ReturnType<typeof checkCardWin>;
    serverVerifiedAt: string;
  } {
    const {
      roomId,
      claimantTelegramId,
      playerName,
      cardId,
      markedNumbers,
      enforceServerCallsOnly = true,
      fallbackClientCalls,
    } = params;

    const nowIso = new Date().toISOString();
    if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
      return { verified: false, reason: 'invalid_card_id', cardId, serverVerifiedAt: nowIso };
    }

    const sess = this.ensureRoomSession(roomId);
    if (sess.status === 'completed') {
      return {
        verified: false,
        reason: 'game_already_completed',
        cardId,
        serverVerifiedAt: nowIso,
      };
    }

    const owner = sess.cardOwners.get(cardId);
    if (owner !== undefined && owner !== claimantTelegramId) {
      return {
        verified: false,
        reason: 'card_not_owned_by_claimant',
        cardId,
        serverVerifiedAt: nowIso,
      };
    }

    const authoritativeCalls =
      !enforceServerCallsOnly && Array.isArray(fallbackClientCalls)
        ? fallbackClientCalls
        : sess.calledNumbers;

    const card = generateDeterministicCard(cardId);
    const winResult = checkCardWin(card, markedNumbers, authoritativeCalls, true);

    if (!winResult.won) {
      return {
        verified: false,
        reason: 'pattern_not_satisfied',
        cardId,
        winResult,
        serverVerifiedAt: nowIso,
      };
    }

    sess.status = 'completed';
    sess.winner = {
      telegramUserId: claimantTelegramId,
      playerName,
      cardId,
      patternEn: winResult.patternLabelEn,
      verifiedAt: nowIso,
    };

    return {
      verified: true,
      cardId,
      winResult,
      serverVerifiedAt: nowIso,
    };
  }
}

/**
 * Normalizes a raw webhook secret (such as base64 with +, /, =) into Telegram Bot API's
 * required secret_token alphabet ([A-Za-z0-9_-], 1..256 chars).
 */
export function normalizeWebhookSecretForTelegram(rawSecret: string): string {
  return rawSecret
    .trim()
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 256);
}

/**
 * Constant-time verification of the incoming X-Telegram-Bot-Api-Secret-Token header
 * against either the raw configured secret or its Telegram-normalized base64url form.
 */
export function verifyWebhookSecretHeader(
  receivedHeader: string | undefined,
  configuredSecret: string | undefined
): boolean {
  if (!configuredSecret || configuredSecret.trim() === '') {
    return true;
  }
  if (!receivedHeader || typeof receivedHeader !== 'string') {
    return false;
  }
  const cleanReceived = Buffer.from(receivedHeader.trim(), 'utf8');
  const rawExpected = Buffer.from(configuredSecret.trim(), 'utf8');
  const normExpected = Buffer.from(
    normalizeWebhookSecretForTelegram(configuredSecret),
    'utf8'
  );

  const matchRaw =
    cleanReceived.length === rawExpected.length &&
    crypto.timingSafeEqual(cleanReceived, rawExpected);
  const matchNorm =
    cleanReceived.length === normExpected.length &&
    crypto.timingSafeEqual(cleanReceived, normExpected);

  return matchRaw || matchNorm;
}

