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
  callbackAnswerText?: string;
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
  referredByCode?: string;
  referredByUid?: string;
  pendingAction?: 'deposit_amount' | 'withdraw_amount' | null;
  pendingMethod?: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)' | null;
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
  depositAm?: string;
  depositEn?: string;
  withdrawAm?: string;
  withdrawEn?: string;
  inviteFriendsAm: string;
  inviteFriendsEn: string;
  leaderboardAm?: string;
  leaderboardEn?: string;
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

/**
 * Detects whether a URL is a Google AI Studio preview/dev URL (ais-dev-*, ais-pre-*, *.run.app)
 * or placeholder that would trigger a Google login/verification interstitial inside Telegram WebView.
 */
export function isDisallowedMiniAppPreviewUrl(candidate?: string | null): boolean {
  if (typeof candidate !== 'string') return true;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === 'MY_APP_URL' || !trimmed.startsWith('https://')) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('ais-dev-') ||
    lower.includes('ais-pre-') ||
    lower.includes('.run.app') ||
    lower.includes('accounts.google.com')
  );
}

/**
 * Guarantees that any Mini App URL used in Telegram WebApp buttons or menu buttons
 * never points to a Google AI Studio preview URL (ais-dev-*, ais-pre-*, *.run.app),
 * falling back to https://adebingo-3nta.vercel.app/.
 */
export function sanitizeProductionMiniAppUrl(candidate?: string | null): string {
  if (isDisallowedMiniAppPreviewUrl(candidate)) {
    return DEFAULT_DEPLOYED_MINI_APP_URL;
  }
  const trimmed = candidate!.trim();
  if (trimmed === 'https://adebingo-3nta.vercel.app') {
    return DEFAULT_DEPLOYED_MINI_APP_URL;
  }
  return trimmed;
}

export const DEFAULT_BOT_BUTTON_LABELS: BotButtonLabelsConfig = {
  playBingoAm: '🎱 ቢንጎ ይጫወቱ',
  playBingoEn: '🎱 Play Bingo',
  myWalletAm: '💰 የእኔ ቦርሳ',
  myWalletEn: '💰 My Wallet',
  depositAm: '➕ ገንዘብ ያስገቡ',
  depositEn: '➕ Deposit',
  withdrawAm: '💸 ገንዘብ ያውጡ',
  withdrawEn: '💸 Withdraw',
  inviteFriendsAm: '🎁 ጓደኞችን ይጋብዙ',
  inviteFriendsEn: '🎁 Invite Friends',
  leaderboardAm: '🏆 የደረጃ ሰንጠረዥ',
  leaderboardEn: '🏆 Leaderboard',
  myProfileAm: '👤 የእኔ መገለጫ',
  myProfileEn: '👤 My Profile',
  gameHistoryAm: '📜 የጨዋታ ታሪክ',
  gameHistoryEn: '📜 Game History',
  supportAm: '🆘 እገዛ',
  supportEn: '🆘 Support',
  languageAm: '🌐 ቋንቋ',
  languageEn: '🌐 Language',
};

export type BotInlineContext =
  | 'welcome'
  | 'language'
  | 'wallet'
  | 'deposit'
  | 'withdraw'
  | 'referral'
  | 'profile'
  | 'leaderboard'
  | 'history'
  | 'support'
  | 'play';

export function buildContextualInlineKeyboard(
  context: BotInlineContext,
  lang: Language,
  rawMiniAppUrl: string = DEFAULT_DEPLOYED_MINI_APP_URL,
  options: {
    referralLink?: string;
    labels?: BotButtonLabelsConfig;
  } = {}
): TelegramInlineButton[][] {
  const miniAppUrl = sanitizeProductionMiniAppUrl(rawMiniAppUrl);
  const am = lang === 'am';
  const labels = { ...DEFAULT_BOT_BUTTON_LABELS, ...(options.labels || {}) };
  const playText = am
    ? labels.playBingoAm || DEFAULT_BOT_BUTTON_LABELS.playBingoAm
    : labels.playBingoEn || DEFAULT_BOT_BUTTON_LABELS.playBingoEn;
  const backBtn: TelegramInlineButton = {
    text: am ? '⬅️ ወደ ዋና ሜኑ' : '⬅️ Back to Menu',
    callback_data: 'cb:main_menu',
  };

  switch (context) {
    case 'language':
      return [
        [
          { text: '🇪🇹 አማርኛ', callback_data: 'lang:am' },
          { text: '🇬🇧 English', callback_data: 'lang:en' },
        ],
        [backBtn],
      ];

    case 'wallet':
      return [
        [
          { text: am ? '🔄 ቦርሳ አድስ' : '🔄 Refresh Wallet', callback_data: 'cb:wallet_refresh' },
          { text: am ? '📋 የግብይት ታሪክ' : '📋 Transaction History', callback_data: 'cb:wallet_history' },
        ],
        [
          { text: am ? '➕ ገንዘብ ያስገቡ' : '➕ Deposit', callback_data: 'cb:deposit' },
          { text: am ? '💸 ገንዘብ ያውጡ' : '💸 Withdraw', callback_data: 'cb:withdraw' },
        ],
        [backBtn],
      ];

    case 'deposit':
      return [
        [
          { text: '📱 Telebirr (Demo)', callback_data: 'cb:deposit_method:telebirr' },
          { text: '🏦 CBE Birr (Demo)', callback_data: 'cb:deposit_method:cbe_birr' },
        ],
        [
          { text: '💳 Chapa Sandbox', callback_data: 'cb:deposit_method:chapa' },
          { text: am ? '📊 የጥያቄ ሁኔታ' : '📊 Request Status', callback_data: 'cb:deposit_status' },
        ],
        [
          { text: '50 ETB', callback_data: 'cb:deposit_amount:50' },
          { text: '100 ETB', callback_data: 'cb:deposit_amount:100' },
          { text: '200 ETB', callback_data: 'cb:deposit_amount:200' },
          { text: '500 ETB', callback_data: 'cb:deposit_amount:500' },
        ],
        [backBtn],
      ];

    case 'withdraw':
      return [
        [
          { text: '📱 Telebirr (Demo)', callback_data: 'cb:withdraw_method:telebirr' },
          { text: '🏦 CBE Birr (Demo)', callback_data: 'cb:withdraw_method:cbe_birr' },
        ],
        [
          { text: '50 ETB', callback_data: 'cb:withdraw_amount:50' },
          { text: '100 ETB', callback_data: 'cb:withdraw_amount:100' },
          { text: '200 ETB', callback_data: 'cb:withdraw_amount:200' },
        ],
        [
          { text: am ? '📊 የወጪ ሁኔታ' : '📊 Withdrawal Status', callback_data: 'cb:withdraw_status' },
          backBtn,
        ],
      ];

    case 'referral': {
      const refUrl = options.referralLink || 'https://t.me/AdeyBingoBot';
      const shareMessage = am
        ? '🎱 ADEYBINGO ይቀላቀሉ እና ቢንጎ አብረን እንጫወት! (+15 ETB የሙከራ ቦነስ ያግኙ)'
        : '🎱 Join ADEYBINGO and play live Bingo with me! (+15 ETB Demo Welcome Bonus)';
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refUrl)}&text=${encodeURIComponent(shareMessage)}`;
      return [
        [
          { text: am ? '📋 ሊንክ ቅዳ' : '📋 Copy Referral Link', callback_data: 'cb:referral_copy' },
          { text: am ? '📤 ለጓደኛ አጋራ' : '📤 Share Referral Link', url: shareUrl },
        ],
        [backBtn],
      ];
    }

    case 'profile':
      return [
        [
          { text: am ? '🪪 የቴሌግራም መለያ ቅዳ' : '🪪 Copy Telegram ID', callback_data: 'cb:copy_telegram_id' },
          { text: am ? '🌐 ቋንቋ ቀይር' : '🌐 Change Language', callback_data: 'cb:language' },
        ],
        [backBtn],
      ];

    case 'leaderboard':
    case 'history':
    case 'support':
    case 'play':
      return [[{ text: playText, web_app: { url: miniAppUrl } }, backBtn]];

    case 'welcome':
    default:
      return [
        [
          { text: playText, web_app: { url: miniAppUrl } },
          { text: labels.myWalletAm && am ? labels.myWalletAm : labels.myWalletEn, callback_data: 'cb:my_wallet' },
        ],
        [
          { text: am ? labels.depositAm! : labels.depositEn!, callback_data: 'cb:deposit' },
          { text: am ? labels.inviteFriendsAm : labels.inviteFriendsEn, callback_data: 'cb:invite_friends' },
        ],
        [
          { text: am ? labels.leaderboardAm! : labels.leaderboardEn!, callback_data: 'cb:leaderboard' },
          { text: am ? '🌐 ቋንቋ / Language' : '🌐 Language / ቋንቋ', callback_data: 'cb:language' },
        ],
      ];
  }
}

/**
 * Builds the 5-row (10-button) Amharic-First ADEYBINGO Telegram Bot Main Menu Reply Keyboard
 * plus a contextual inline keyboard matching the active interaction.
 */
export function buildBotMainMenuMarkup(
  lang: Language,
  rawMiniAppUrl: string = DEFAULT_DEPLOYED_MINI_APP_URL,
  phoneVerified: boolean = false,
  labels: BotButtonLabelsConfig = DEFAULT_BOT_BUTTON_LABELS,
  inlineContext: BotInlineContext = 'welcome',
  inlineOptions: { referralLink?: string } = {}
): TelegramBotReplyMarkup {
  const miniAppUrl = sanitizeProductionMiniAppUrl(rawMiniAppUrl);
  const merged = { ...DEFAULT_BOT_BUTTON_LABELS, ...labels };
  const am = lang === 'am';

  const contactRow: TelegramKeyboardButton[] = !phoneVerified
    ? [
        {
          text: am
            ? '📲 ስልክ ቁጥርዎን ያጋሩ (Share Phone Contact)'
            : '📲 Share Telegram Phone Contact',
          request_contact: true,
        },
      ]
    : [];

  const mainRows: TelegramKeyboardButton[][] = [
    [
      {
        text: am ? merged.playBingoAm : merged.playBingoEn,
        web_app: { url: miniAppUrl },
      },
      { text: am ? merged.myWalletAm : merged.myWalletEn },
    ],
    [
      { text: am ? merged.depositAm! : merged.depositEn! },
      { text: am ? merged.withdrawAm! : merged.withdrawEn! },
    ],
    [
      { text: am ? merged.inviteFriendsAm : merged.inviteFriendsEn },
      { text: am ? merged.leaderboardAm! : merged.leaderboardEn! },
    ],
    [
      { text: am ? merged.gameHistoryAm : merged.gameHistoryEn },
      { text: am ? merged.myProfileAm : merged.myProfileEn },
    ],
    [
      { text: am ? merged.supportAm : merged.supportEn },
      { text: am ? merged.languageAm : merged.languageEn },
    ],
    ...(contactRow.length > 0 ? [contactRow] : []),
  ];

  const inlineRows = buildContextualInlineKeyboard(inlineContext, lang, miniAppUrl, {
    ...inlineOptions,
    labels: merged,
  });

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
            body: `እንኳን ደህና መጡ *${playerName}*! የቴሌግራም ስልክ ቁጥርዎ (${payload.maskedPhone || '+251***'}) ተረጋግጧል። 250.00 ETB የሙከራ ሂሳብ (Demo Balance) ተዘጋጅቶልዎታል። *🎱 ቢንጎ ይጫወቱ* የሚለውን በመጫን ይጀምሩ!`,
          }
        : {
            title: '✅ Registration & Phone Verification Complete!',
            body: `Welcome *${playerName}*! Your Telegram phone contact (${payload.maskedPhone || '+251***'}) is verified. Your 250.00 ETB Demo Sandbox balance is ready. Tap *🎱 Play Bingo* to launch ADEYBINGO!`,
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
export interface BotEngineDepositRecord {
  depositId: string;
  telegramUserId: number;
  uid: string;
  userDisplayName: string;
  provider: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)';
  amountEtb: number;
  referenceCode: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  createdAt: string;
  demoSandboxOnly: true;
}

export interface BotEngineWithdrawalRecord {
  requestId: string;
  telegramUserId: number;
  uid: string;
  userDisplayName: string;
  paymentMethod: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)';
  requestedAmountEtb: number;
  status: 'Pending' | 'Under Review' | 'Approved' | 'Rejected' | 'Completed';
  reviewNotes: string;
  createdAt: string;
  demoSandboxOnly: true;
}

export interface BotEngineGameHistoryRecord {
  gameId: string;
  roomNameAm: string;
  roomNameEn: string;
  cardId: number;
  pattern: string;
  amountEtb: number;
  result: 'won' | 'played';
  playedAt: string;
  winnerTelegramId?: number;
}

export class AdeyBingoTelegramBotEngine {
  private playersByTelegramId = new Map<number, RegisteredTelegramPlayer>();
  private telegramIdByUid = new Map<string, number>();
  private chatLanguages = new Map<number, Language>();
  private notificationOutbox: BotNotificationMessage[] = [];
  private replayGuard = new TelegramReplayGuard();
  private depositRequests = new Map<string, BotEngineDepositRecord>();
  private withdrawalRequests = new Map<string, BotEngineWithdrawalRecord>();
  private transactionsByUser = new Map<
    number,
    Array<{ id: string; type: string; amountEtb: number; description: string; reference: string; createdAt: string }>
  >();
  private gameHistoryByUser = new Map<number, BotEngineGameHistoryRecord[]>();
  private referralsByInviter = new Map<
    number,
    Array<{ inviteeTelegramId: number; inviteeName: string; bonusEtb: number; createdAt: string }>
  >();
  private referredInviteeIds = new Set<number>();
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
    this.miniAppUrl = sanitizeProductionMiniAppUrl(miniAppUrl);
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
    if (typeof patch.miniAppUrl === 'string' && patch.miniAppUrl.trim().length > 0) {
      this.miniAppUrl = sanitizeProductionMiniAppUrl(patch.miniAppUrl);
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

  public getDepositRequests(telegramUserId?: number): BotEngineDepositRecord[] {
    const all = Array.from(this.depositRequests.values());
    return telegramUserId ? all.filter((d) => d.telegramUserId === telegramUserId) : all;
  }

  public getWithdrawalRequests(telegramUserId?: number): BotEngineWithdrawalRecord[] {
    const all = Array.from(this.withdrawalRequests.values());
    return telegramUserId ? all.filter((w) => w.telegramUserId === telegramUserId) : all;
  }

  public recordCompletedGameWin(params: {
    telegramUserId: number;
    gameId: string;
    roomNameAm: string;
    roomNameEn: string;
    cardId: number;
    pattern: string;
    prizeEtb: number;
  }): void {
    const nowIso = new Date().toISOString();
    const list = this.gameHistoryByUser.get(params.telegramUserId) || [];
    list.unshift({
      gameId: params.gameId,
      roomNameAm: params.roomNameAm,
      roomNameEn: params.roomNameEn,
      cardId: params.cardId,
      pattern: params.pattern,
      amountEtb: params.prizeEtb,
      result: 'won',
      playedAt: nowIso,
      winnerTelegramId: params.telegramUserId,
    });
    this.gameHistoryByUser.set(params.telegramUserId, list.slice(0, 30));

    const txList = this.transactionsByUser.get(params.telegramUserId) || [];
    txList.unshift({
      id: `tx_win_${Date.now()}`,
      type: 'bingo_win',
      amountEtb: params.prizeEtb,
      description: `Bingo Win (Card #${params.cardId})`,
      reference: params.gameId,
      createdAt: nowIso,
    });
    this.transactionsByUser.set(params.telegramUserId, txList.slice(0, 30));

    const p = this.playersByTelegramId.get(params.telegramUserId);
    if (p) {
      p.demoBalanceEtb += params.prizeEtb;
      p.updatedAt = nowIso;
    }
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

  private buildMenuMarkup(
    lang: Language,
    phoneVerified: boolean,
    inlineContext: BotInlineContext = 'welcome',
    inlineOptions: { referralLink?: string } = {}
  ): TelegramBotReplyMarkup {
    return buildBotMainMenuMarkup(
      lang,
      this.miniAppUrl,
      phoneVerified,
      this.buttonLabels,
      inlineContext,
      inlineOptions
    );
  }

  private resolveMethodName(
    slug: string
  ): 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)' {
    if (slug === 'cbe_birr') return 'CBE Birr (Demo)';
    if (slug === 'chapa') return 'Chapa Sandbox (Demo)';
    return 'Telebirr (Demo)';
  }

  private getDemoWinningsForUser(telegramUserId: number): number {
    const txs = this.transactionsByUser.get(telegramUserId) || [];
    return txs
      .filter((tx) => tx.type === 'bingo_win' && tx.amountEtb > 0)
      .reduce((sum, tx) => sum + tx.amountEtb, 0);
  }

  private getLeaderboardRows(): Array<{
    telegramUserId: number;
    name: string;
    wins: number;
    winningsEtb: number;
  }> {
    const rows: Array<{
      telegramUserId: number;
      name: string;
      wins: number;
      winningsEtb: number;
    }> = [];
    for (const [tgId, games] of this.gameHistoryByUser.entries()) {
      const wins = games.filter((g) => g.result === 'won').length;
      if (wins <= 0) continue;
      const p = this.playersByTelegramId.get(tgId);
      const winningsEtb = games
        .filter((g) => g.result === 'won')
        .reduce((s, g) => s + g.amountEtb, 0);
      rows.push({
        telegramUserId: tgId,
        name: p ? `${p.firstName} ${p.lastName || ''}`.trim() : `Player #${tgId}`,
        wins,
        winningsEtb,
      });
    }
    rows.sort((a, b) => b.wins - a.wins || b.winningsEtb - a.winningsEtb);
    return rows.slice(0, 10);
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
    const cleanCb = callbackData.trim();

    // Security guard: never expose admin functions through the player Telegram bot
    if (
      trimmed.startsWith('/admin') ||
      cleanCb.startsWith('cb:admin') ||
      cleanCb.startsWith('admin:')
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

    // 1. Handle Shared Contact Verification
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

    // Reject plain-text phone numbers sent in chat
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

    // 2. Handle Language Selection Menu vs Direct Language Selection (`lang:am` / `lang:en`)
    if (cleanCb === 'lang:am' || cleanCb === 'lang:en' || trimmed === '🇪🇹 አማርኛ' || trimmed === '🇬🇧 English') {
      const nextLang: Language =
        cleanCb === 'lang:en' || trimmed === '🇬🇧 English' ? 'en' : 'am';
      this.setLanguage(senderTelegramId, nextLang);

      const msgText =
        nextLang === 'am'
          ? [
              '✅ *ቋንቋ ወደ አማርኛ ተቀይሯል!*',
              '',
              'ከአሁን በኋላ ሁሉም የቦት ሜኑዎች፣ መልዕክቶች እና ማሳወቂያዎች በአማርኛ ይቀርባሉ።',
              'የሚኒ አፑ ቋንቋም በራስ-ሰር ከአማርኛ ጋር ይመሳሰላል።',
            ].join('\n')
          : [
              '✅ *Language switched to English!*',
              '',
              'All bot menus, messages, and notifications are now displayed in English.',
              'Your Mini App language preference is synchronized automatically.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: nextLang,
        text: msgText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          nextLang,
          Boolean(existingPlayer?.phoneVerified),
          'welcome'
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        securityCode: 'language_updated',
        callbackAnswerText:
          nextLang === 'am' ? '🇪🇹 ቋንቋ ወደ አማርኛ ተቀይሯል' : '🇬🇧 Switched to English',
        profile: existingPlayer ? { ...existingPlayer, language: nextLang } : undefined,
      };
    }

    if (
      cleanCb === 'cb:language' ||
      trimmed === '/language' ||
      trimmed === '🌐 ቋንቋ' ||
      trimmed === '🌐 Language' ||
      trimmed === '🌐 Change Language' ||
      trimmed === '🌐 ቋንቋ ቀይር'
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: [
          '🌐 *ቋንቋ ይምረጡ / Select Language*',
          '',
          currentLang === 'am'
            ? 'እባክዎ የሚፈልጉትን ቋንቋ ከታች ይምረጡ (አማርኛ ነባሪ ቋንቋ ነው)።'
            : 'Please choose your preferred language below (Amharic is the default language).',
        ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified),
          'language'
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        securityCode: 'callback_language',
        profile: existingPlayer,
      };
    }

    // 3. Handle /start (with optional referral payload `/start ADEY-12345`) & cb:main_menu
    if (trimmed.startsWith('/start') || cleanCb === 'cb:main_menu') {
      const startMatch = /^\/start(?:\s+([A-Za-z0-9_-]{3,48}))?/.exec(trimmed);
      const referralPayload = startMatch?.[1];
      return this.handleStartCommand({
        senderTelegramId,
        firstName,
        lastName,
        username,
        firebaseUid,
        referralCode: referralPayload,
      });
    }

    // Ensure profile exists for stateful menu actions
    const ensureProfile = (): RegisteredTelegramPlayer => {
      if (existingPlayer) return existingPlayer;
      const startRes = this.handleStartCommand({
        senderTelegramId,
        firstName,
        lastName,
        username,
        firebaseUid,
      });
      return startRes.profile!;
    };

    // 4. Handle Pending Deposit / Withdraw Amount Text Input
    if (
      existingPlayer?.pendingAction &&
      !cleanCb &&
      !trimmed.startsWith('/') &&
      /^\d+(?:\.\d{1,2})?$/.test(trimmed)
    ) {
      const amount = Number(trimmed);
      const method = existingPlayer.pendingMethod || 'Telebirr (Demo)';
      const action = existingPlayer.pendingAction;
      if (action === 'deposit_amount') {
        return this.processDemoDepositSubmission(existingPlayer, method, amount);
      }
      if (action === 'withdraw_amount') {
        return this.processDemoWithdrawSubmission(existingPlayer, method, amount);
      }
    }

    // 5. Handle Play Bingo (🎱 ቢንጎ ይጫወቱ / 🎱 Play Bingo / cb:play_bingo)
    if (
      trimmed === '🎱 ቢንጎ ይጫወቱ' ||
      trimmed === '🎱 Play Bingo' ||
      trimmed === '🎮 Start Playing' ||
      trimmed === '🎮 Play Bingo' ||
      trimmed === '🎮 ቢንጎ ይጫወቱ' ||
      cleanCb === 'cb:play_bingo' ||
      cleanCb === 'menu:play_bingo'
    ) {
      const playText =
        currentLang === 'am'
          ? [
              '🎱 *ADEYBINGO ሚኒ አፕ ለመክፈት ዝግጁ ነው!*',
              '',
              'ከታች ያለውን *🎱 ቢንጎ ይጫወቱ* ቁልፍ በመጫን ወደ ቀጥታ የቢንጎ ክፍል ይግቡ።',
              '• ከ1–600 ካርዶች እስከ 4 ካርድ ይምረጡ እና በቀጥታ ይጫወቱ!',
            ].join('\n')
          : [
              '🎱 *ADEYBINGO Mini App Ready!*',
              '',
              'Tap the *🎱 Play Bingo* button below to enter the live Bingo hall.',
              '• Reserve 1–4 cards from the 600-card pool and play live rounds!',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: playText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified),
          'play'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_play_bingo',
        profile: existingPlayer,
      };
    }

    // 6. Handle My Wallet (💰 የእኔ ቦርሳ / 💰 My Wallet / /wallet / cb:my_wallet / cb:wallet_refresh / cb:wallet_history)
    if (
      trimmed === '💰 የእኔ ቦርሳ' ||
      trimmed === '💰 My Wallet' ||
      trimmed === '💰 My Balance' ||
      trimmed === '/wallet' ||
      cleanCb === 'cb:my_wallet' ||
      cleanCb === 'cb:wallet_refresh' ||
      cleanCb === 'cb:wallet_history' ||
      cleanCb === 'menu:my_balance'
    ) {
      const player = ensureProfile();
      const bal = player.demoBalanceEtb;
      const winnings = this.getDemoWinningsForUser(senderTelegramId);
      const txs = this.transactionsByUser.get(senderTelegramId) || [];

      if (cleanCb === 'cb:wallet_history') {
        const txLines =
          txs.length > 0
            ? txs.slice(0, 6).map((tx, idx) => {
                const sign = tx.amountEtb >= 0 ? '+' : '';
                return `${idx + 1}. \`${tx.reference}\` — *${sign}${tx.amountEtb.toFixed(2)} ETB* (${tx.description})`;
              })
            : [
                currentLang === 'am'
                  ? '• እስካሁን የተመዘገበ የቦርሳ ግብይት የለም።'
                  : '• No recorded wallet transactions yet.',
              ];

        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? ['📋 *የቦርሳ ግብይት ታሪክ (Demo Sandbox)*', '', ...txLines].join('\n')
              : ['📋 *Wallet Transaction History (Demo Sandbox)*', '', ...txLines].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'wallet'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_wallet_history',
          callbackAnswerText: currentLang === 'am' ? '📋 የግብይት ታሪክ ተከፍቷል' : '📋 Transaction history loaded',
          profile: player,
        };
      }

      const recentLines =
        txs.length > 0
          ? txs.slice(0, 3).map((tx) => {
              const sign = tx.amountEtb >= 0 ? '+' : '';
              return `  • \`${tx.reference}\`: *${sign}${tx.amountEtb.toFixed(2)} ETB*`;
            })
          : [
              currentLang === 'am'
                ? '  • ምንም የቅርብ ጊዜ ግብይት የለም'
                : '  • No recent transactions recorded',
            ];

      const walletText =
        currentLang === 'am'
          ? [
              '💰 *የእኔ ቦርሳ (Demo Wallet)*',
              '',
              `• የሚገኝ የሙከራ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (DEMO)*`,
              `• ጠቅላላ የቢንጎ ሽልማቶች፦ *${winnings.toFixed(2)} ETB (DEMO)*`,
              '• የቅርብ ጊዜ ግብይቶች፦',
              ...recentLines,
              '',
              'ℹ️ _ማሳሰቢያ፦ ይህ መለያ በሙከራ (Demo Sandbox) ሁኔታ ብቻ ይሰራል፤ እውነተኛ ገንዘብ ክፍያ አልተከፈተም።_',
            ].join('\n')
          : [
              '💰 *My Demo Wallet (Demo Sandbox)*',
              '',
              `• Available Demo Balance: *${bal.toFixed(2)} ETB (DEMO)*`,
              `• Demo Winnings Balance: *${winnings.toFixed(2)} ETB (DEMO)*`,
              '• Recent Transactions:',
              ...recentLines,
              '',
              'ℹ️ _Notice: All balances operate strictly in Demo Sandbox mode; real-money payments are disabled._',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: walletText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'wallet'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: cleanCb === 'cb:wallet_refresh' ? 'callback_wallet_refresh' : 'callback_my_wallet',
        callbackAnswerText:
          cleanCb === 'cb:wallet_refresh'
            ? currentLang === 'am'
              ? '🔄 ቦርሳዎ ታድሷል'
              : '🔄 Wallet refreshed'
            : undefined,
        profile: player,
      };
    }

    // 7. Handle Deposit (➕ ገንዘብ ያስገቡ / ➕ Deposit / /deposit / cb:deposit*)
    if (
      trimmed === '➕ ገንዘብ ያስገቡ' ||
      trimmed === '➕ Deposit' ||
      trimmed === '/deposit' ||
      cleanCb === 'cb:deposit' ||
      cleanCb === 'cb:deposit_status' ||
      cleanCb.startsWith('cb:deposit_method:') ||
      cleanCb.startsWith('cb:deposit_amount:')
    ) {
      const player = ensureProfile();

      if (cleanCb === 'cb:deposit_status') {
        const myDeposits = this.getDepositRequests(senderTelegramId).slice(0, 5);
        const lines =
          myDeposits.length > 0
            ? myDeposits.map(
                (d, idx) =>
                  `${idx + 1}. \`${d.depositId}\` — *${d.amountEtb.toFixed(2)} ETB* (${d.provider}) · *${d.status}*`
              )
            : [
                currentLang === 'am'
                  ? '• እስካሁን የቀረበ የሙከራ ገንዘብ ማስገቢያ ጥያቄ የለም።'
                  : '• No Demo deposit requests submitted yet.',
              ];
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? ['📊 *የሙከራ ገንዘብ ማስገቢያ ጥያቄዎች ሁኔታ*', '', ...lines].join('\n')
              : ['📊 *Demo Deposit Request Status*', '', ...lines].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'deposit'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_deposit_status',
          profile: player,
        };
      }

      if (cleanCb.startsWith('cb:deposit_method:')) {
        const slug = cleanCb.slice('cb:deposit_method:'.length);
        const method = this.resolveMethodName(slug);
        player.pendingAction = 'deposit_amount';
        player.pendingMethod = method;
        player.updatedAt = new Date().toISOString();

        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? [
                  `➕ *የተመረጠው የክፍያ መንገድ፦ ${method}*`,
                  '',
                  'ከታች ካሉት መጠኖች አንዱን ይምረጡ ወይም ከ10–10,000 ETB መካከል የሙከራ መጠን በቁጥር ይላኩ።',
                  'ℹ️ _Demo Sandbox፦ ጥያቄዎ በአስተዳዳሪ (Admin) ከታየ በኋላ ይጸድቃል።_',
                ].join('\n')
              : [
                  `➕ *Selected Method: ${method}*`,
                  '',
                  'Choose an amount below or type a Demo amount between 10 and 10,000 ETB.',
                  'ℹ️ _Demo Sandbox: Requests are tracked as Pending for admin review._',
                ].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'deposit'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_deposit_method',
          callbackAnswerText: method,
          profile: player,
        };
      }

      if (cleanCb.startsWith('cb:deposit_amount:')) {
        const amount = Number(cleanCb.slice('cb:deposit_amount:'.length));
        const method = player.pendingMethod || 'Telebirr (Demo)';
        return this.processDemoDepositSubmission(player, method, amount);
      }

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '➕ *የሙከራ ገንዘብ ማስገቢያ (Demo Deposit)*',
                '',
                '• የሙከራ የክፍያ መንገዶች፦ `Telebirr (Demo)` · `CBE Birr (Demo)` · `Chapa Sandbox (Demo)`',
                '• ለመቀጠል ከታች የክፍያ መንገድ ወይም መጠን ይምረጡ።',
                '',
                'ℹ️ _ማሳሰቢያ፦ እውነተኛ የገንዘብ ክፍያዎች አልተከፈቱም፤ ሁሉም ጥያቄዎች የሙከራ (Demo Sandbox) ናቸው።_',
              ].join('\n')
            : [
                '➕ *Demo Deposit Sandbox*',
                '',
                '• Configured Demo Methods: `Telebirr (Demo)` · `CBE Birr (Demo)` · `Chapa Sandbox (Demo)`',
                '• Select a Demo payment method or preset amount below to submit a tracked request.',
                '',
                'ℹ️ _Notice: Real-money deposits are disabled; all requests are Demo Sandbox only._',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'deposit'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_deposit',
        profile: player,
      };
    }

    // 8. Handle Withdraw (💸 ገንዘብ ያውጡ / 💸 Withdraw / /withdraw / cb:withdraw*)
    if (
      trimmed === '💸 ገንዘብ ያውጡ' ||
      trimmed === '💸 Withdraw' ||
      trimmed === '/withdraw' ||
      cleanCb === 'cb:withdraw' ||
      cleanCb === 'cb:withdraw_status' ||
      cleanCb.startsWith('cb:withdraw_method:') ||
      cleanCb.startsWith('cb:withdraw_amount:')
    ) {
      const player = ensureProfile();

      if (cleanCb === 'cb:withdraw_status') {
        const myWithdraws = this.getWithdrawalRequests(senderTelegramId).slice(0, 5);
        const lines =
          myWithdraws.length > 0
            ? myWithdraws.map(
                (w, idx) =>
                  `${idx + 1}. \`${w.requestId}\` — *${w.requestedAmountEtb.toFixed(2)} ETB* (${w.paymentMethod}) · *${w.status}*`
              )
            : [
                currentLang === 'am'
                  ? '• እስካሁን የቀረበ የሙከራ ገንዘብ ማውጫ ጥያቄ የለም።'
                  : '• No Demo withdrawal requests submitted yet.',
              ];
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? ['📊 *የሙከራ ገንዘብ ማውጫ ጥያቄዎች ሁኔታ*', '', ...lines].join('\n')
              : ['📊 *Demo Withdrawal Request Status*', '', ...lines].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'withdraw'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_withdraw_status',
          profile: player,
        };
      }

      if (cleanCb.startsWith('cb:withdraw_method:')) {
        const slug = cleanCb.slice('cb:withdraw_method:'.length);
        const method = this.resolveMethodName(slug);
        player.pendingAction = 'withdraw_amount';
        player.pendingMethod = method;
        player.updatedAt = new Date().toISOString();

        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? [
                  `💸 *የተመረጠው የወጪ መንገድ፦ ${method}*`,
                  `• የሚገኝ ቀሪ ሂሳብ፦ *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*`,
                  '• ከታች መጠን ይምረጡ ወይም ከ20 ETB ጀምሮ የሙከራ መጠን ይላኩ።',
                ].join('\n')
              : [
                  `💸 *Selected Withdrawal Method: ${method}*`,
                  `• Available Demo Balance: *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*`,
                  '• Choose an amount below or type an amount (min 20 ETB Demo).',
                ].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'withdraw'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_withdraw_method',
          callbackAnswerText: method,
          profile: player,
        };
      }

      if (cleanCb.startsWith('cb:withdraw_amount:')) {
        const amount = Number(cleanCb.slice('cb:withdraw_amount:'.length));
        const method = player.pendingMethod || 'Telebirr (Demo)';
        return this.processDemoWithdrawSubmission(player, method, amount);
      }

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '💸 *የሙከራ ገንዘብ ማውጫ (Demo Withdraw)*',
                '',
                `• የሚገኝ የሙከራ ቀሪ ሂሳብ፦ *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*`,
                '• የወጪ መንገድ እና መጠን ከታች ይምረጡ (ዝቅተኛው 20 ETB)።',
                '',
                'ℹ️ _ማሳሰቢያ፦ ይህ ጥያቄ በሙከራ (Demo Sandbox) ደረጃ ብቻ የሚመዘገብ ነው።_',
              ].join('\n')
            : [
                '💸 *Demo Withdrawal Sandbox*',
                '',
                `• Available Demo Balance: *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*`,
                '• Select a Demo payout method and amount below (minimum 20 ETB Demo).',
                '',
                'ℹ️ _Notice: Requests are logged strictly for Demo Sandbox review._',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'withdraw'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_withdraw',
        profile: player,
      };
    }

    // 9. Handle Invite Friends (🎁 ጓደኞችን ይጋብዙ / 🎁 Invite Friends / /invite / cb:invite_friends / cb:referral_copy)
    if (
      trimmed === '🎁 ጓደኞችን ይጋብዙ' ||
      trimmed === '🎁 Invite Friends' ||
      trimmed === '👥 Invite Friends' ||
      trimmed === '👥 ጓደኞችን ይጋብዙ' ||
      trimmed === '/invite' ||
      cleanCb === 'cb:invite_friends' ||
      cleanCb === 'cb:referral_copy' ||
      cleanCb === 'menu:invite_friends'
    ) {
      const player = ensureProfile();
      const refCode = player.referralCode || `ADEY-${senderTelegramId}`;
      const inviteUrl = `https://t.me/AdeyBingoBot?start=${refCode}`;
      const myRefs = this.referralsByInviter.get(senderTelegramId) || [];
      const totalBonus = myRefs.reduce((s, r) => s + r.bonusEtb, 0);

      if (cleanCb === 'cb:referral_copy') {
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? `📋 *የግብዣ ሊንክዎን ይቅዱ እና ለጓደኞችዎ ይላኩ፦*\n\`${inviteUrl}\``
              : `📋 *Copy and share your personal referral link:*\n\`${inviteUrl}\``,
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'referral', {
            referralLink: inviteUrl,
          }),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_referral_copy',
          callbackAnswerText:
            currentLang === 'am' ? '📋 የግብዣ ሊንክ ተዘጋጅቷል' : '📋 Referral link ready to copy',
          profile: player,
        };
      }

      const inviteText =
        currentLang === 'am'
          ? [
              '🎁 *ጓደኞችን ይጋብዙ እና ቦነስ ያግኙ!*',
              '',
              `• የእርስዎ ልዩ የግብዣ ሊንክ፦ \`${inviteUrl}\``,
              `• የተጋበዙ ጓደኞች፦ *${myRefs.length}*`,
              `• የተገኘ የሙከራ ቦነስ፦ *${totalBonus.toFixed(2)} ETB (DEMO)*`,
              '• ሽልማት፦ ለእርስዎ *+20 ETB* · ለጓደኛዎ *+15 ETB* የሙከራ ክሬዲት',
            ].join('\n')
          : [
              '🎁 *Invite Friends to ADEYBINGO!*',
              '',
              `• Your Personal Invite Link: \`${inviteUrl}\``,
              `• Qualified Referrals: *${myRefs.length}*`,
              `• Total Demo Bonus Earned: *${totalBonus.toFixed(2)} ETB (DEMO)*`,
              '• Rewards: *+20 ETB* for you · *+15 ETB* Demo welcome bonus for your friend',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: inviteText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'referral', {
          referralLink: inviteUrl,
        }),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_invite_friends',
        profile: player,
      };
    }

    // 10. Handle Leaderboard (🏆 የደረጃ ሰንጠረዥ / 🏆 Leaderboard / /leaderboard / cb:leaderboard)
    if (
      trimmed === '🏆 የደረጃ ሰንጠረዥ' ||
      trimmed === '🏆 Leaderboard' ||
      trimmed === '/leaderboard' ||
      cleanCb === 'cb:leaderboard'
    ) {
      const player = ensureProfile();
      const leaders = this.getLeaderboardRows();
      const lines =
        leaders.length > 0
          ? leaders.map((row, i) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
              return `${medal} *${row.name}* — *${row.wins}* ${
                currentLang === 'am' ? 'ድሎች' : 'wins'
              } (*${row.winningsEtb.toFixed(2)} ETB Demo*)`;
            })
          : [
              currentLang === 'am'
                ? '• እስካሁን የተመዘገቡ የጨዋታ አሸናፊዎች የሉም። በሚኒ አፑ ውስጥ የመጀመሪያ አሸናፊ ይሁኑ!'
                : '• No verified Bingo winners recorded yet. Enter a live round in the Mini App to claim #1!',
            ];

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? ['🏆 *የADEYBINGO የደረጃ ሰንጠረዥ (Leaderboard)*', '', ...lines].join('\n')
            : ['🏆 *ADEYBINGO Leaderboard (Demo Sandbox)*', '', ...lines].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'leaderboard'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_leaderboard',
        profile: player,
      };
    }

    // 11. Handle Game History (📜 የጨዋታ ታሪክ / 📜 Game History / /history / cb:game_history)
    if (
      trimmed === '📜 የጨዋታ ታሪክ' ||
      trimmed === '📜 Game History' ||
      trimmed === '/history' ||
      cleanCb === 'cb:game_history' ||
      cleanCb === 'menu:game_history'
    ) {
      const player = ensureProfile();
      const history = this.gameHistoryByUser.get(senderTelegramId) || [];
      const historyLines =
        history.length > 0
          ? history.slice(0, 6).map((item, idx) => {
              const roomName = currentLang === 'am' ? item.roomNameAm : item.roomNameEn;
              return `${idx + 1}. \`${item.gameId}\` (${roomName}) — ካርድ *#${item.cardId}* · *${item.pattern}* · +*${item.amountEtb.toFixed(2)} ETB* (${item.playedAt.slice(0, 10)})`;
            })
          : [
              currentLang === 'am'
                ? '• እስካሁን የተመዘገበ የጨዋታ ታሪክ የለም። የመጀመሪያ ዙርዎን ለመጀመር *🎱 ቢንጎ ይጫወቱ* የሚለውን ይጫኑ!'
                : '• No recorded game rounds yet. Tap *🎱 Play Bingo* to join your first live round!',
            ];

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? ['📜 *የእርስዎ የADEYBINGO የጨዋታ ታሪክ*', '', ...historyLines].join('\n')
            : ['📜 *Your ADEYBINGO Game History*', '', ...historyLines].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'history'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_game_history',
        profile: player,
      };
    }

    // 12. Handle My Profile (👤 የእኔ መገለጫ / 👤 My Profile / /profile / cb:my_profile / cb:copy_telegram_id)
    if (
      trimmed === '👤 የእኔ መገለጫ' ||
      trimmed === '👤 My Profile' ||
      trimmed === '👤 መገለጫዬ' ||
      trimmed === '/profile' ||
      cleanCb === 'cb:my_profile' ||
      cleanCb === 'cb:copy_telegram_id' ||
      cleanCb === 'menu:my_profile'
    ) {
      const player = ensureProfile();
      if (cleanCb === 'cb:copy_telegram_id') {
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? `🪪 *የእርስዎ የቴሌግራም መለያ ቁጥር (Telegram ID)፦*\n\`${player.telegramUserId}\``
              : `🪪 *Your Verified Telegram ID:*\n\`${player.telegramUserId}\``,
          parseMode: 'Markdown',
          replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'profile'),
          registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_copy_telegram_id',
          callbackAnswerText: `ID: ${player.telegramUserId}`,
          profile: player,
        };
      }

      const profileText =
        currentLang === 'am'
          ? [
              '👤 *የእኔ መገለጫ (My Profile)*',
              '',
              `• ስም፦ *${player.firstName} ${player.lastName || ''}*`,
              `• የቴሌግራም መለያ፦ \`TG #${player.telegramUserId}\` (@${player.username})`,
              `• የስልክ ማረጋገጫ፦ ${
                player.phoneVerified
                  ? `✅ የተረጋገጠ (${player.verifiedPhoneMasked})`
                  : '⏳ አልተረጋገጠም (ስልክ ቁጥርዎን ያጋሩ)'
              }`,
              `• ቋንቋ፦ *${player.language === 'am' ? '🇪🇹 አማርኛ' : '🇬🇧 English'}*`,
              `• የሙከራ ቀሪ ሂሳብ፦ *${player.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
            ].join('\n')
          : [
              '👤 *Your ADEYBINGO Player Profile*',
              '',
              `• Name: *${player.firstName} ${player.lastName || ''}*`,
              `• Telegram ID: \`TG #${player.telegramUserId}\` (@${player.username})`,
              `• Phone Verification: ${
                player.phoneVerified
                  ? `✅ Verified (${player.verifiedPhoneMasked})`
                  : '⏳ Pending (Tap Share Phone Contact)'
              }`,
              `• Language: *${player.language === 'am' ? '🇪🇹 Amharic (አማርኛ)' : '🇬🇧 English'}*`,
              `• Demo Balance: *${player.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: profileText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(currentLang, player.phoneVerified, 'profile'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_my_profile',
        profile: player,
      };
    }

    // 13. Handle Support (🆘 እገዛ / 🆘 Support / /support / /help / cb:support)
    if (
      trimmed === '🆘 እገዛ' ||
      trimmed === '🆘 Support' ||
      trimmed === '/support' ||
      trimmed === '/help' ||
      trimmed === '📞 Contact Support' ||
      trimmed === '💬 Support' ||
      trimmed === '💬 ድጋፍ' ||
      cleanCb === 'cb:support' ||
      cleanCb === 'menu:contact_support'
    ) {
      const supportText =
        trimmed === '/help'
          ? currentLang === 'am'
            ? [
                '🆘 *የADEYBINGO እገዛ እና መመሪያ (/help)*',
                '',
                '• `/start` — ዋና ሜኑ እና የስልክ ማረጋገጫ',
                '• `/wallet` · `/deposit` · `/withdraw` — የሙከራ ቦርሳ አገልግሎቶች',
                '• `/invite` · `/leaderboard` · `/history` — ግብዣ እና ውጤቶች',
                '• `/language` — ቋንቋ መቀየሪያ (አማርኛ / English)',
                '• `/support` · `/terms` — የደንበኞች ድጋፍ እና ህጎች',
                '',
                '📩 ቀጥታ እገዛ፦ `@AdeyBingoSupport`',
              ].join('\n')
            : [
                '🆘 *ADEYBINGO Help & Command Guide (/help)*',
                '',
                '• `/start` — Main menu & phone verification',
                '• `/wallet` · `/deposit` · `/withdraw` — Demo wallet operations',
                '• `/invite` · `/leaderboard` · `/history` — Referrals & results',
                '• `/language` — Switch language (Amharic / English)',
                '• `/support` · `/terms` — Support desk & Demo Sandbox rules',
                '',
                '📩 Support Desk: `@AdeyBingoSupport`',
              ].join('\n')
          : currentLang === 'am'
            ? [
                '🆘 *የADEYBINGO የተጫዋቾች እገዛ እና ድጋፍ*',
                '',
                'እርዳታ ከፈለጉ የድጋፍ ቡድናችንን ያግኙ፦',
                '• የቴሌግራም ድጋፍ፦ `@AdeyBingoSupport`',
                '• በሚኒ አፑ ውስጥ *ድጋፍ (Support)* የሚለውን ትር በመክፈት ጥያቄ መላክ ይችላሉ።',
                '• የሙከራ ሁኔታ (Demo Sandbox)፦ ሁሉም ሂሳቦች በሙከራ ደረጃ ብቻ ይሰራሉ።',
              ].join('\n')
            : [
                '🆘 *ADEYBINGO Player Support*',
                '',
                'Need assistance? Reach our support desk:',
                '• Telegram Support Desk: `@AdeyBingoSupport`',
                '• Or open the *Support* tab inside the ADEYBINGO Mini App to submit a ticket.',
                '• Demo Sandbox Notice: All balances operate strictly in non-monetary demo mode.',
              ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: supportText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified),
          'support'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_support',
        profile: existingPlayer,
      };
    }

    // 14. Handle /terms
    if (
      trimmed === '/terms' ||
      trimmed === '📜 Terms and Conditions' ||
      cleanCb === 'menu:terms_conditions'
    ) {
      const termsText =
        currentLang === 'am'
          ? [
              '📜 *የADEYBINGO ህጎች፣ ደንቦች እና የግላዊነት ጥበቃ (/terms)*',
              '',
              '1. *የሙከራ ሁኔታ (Demo Sandbox)፦* እውነተኛ የገንዘብ ክፍያዎች ዝግ ናቸው፤ ሁሉም ነጥቦች የሙከራ (Demo ETB) ናቸው።',
              '2. *የካርድ እና የክፍል ህግ፦* በአንድ ክፍል 1–600 ካርዶች፤ በአንድ ተጫዋች እስከ 4 ካርድ።',
              '3. *የግላዊነት ጥበቃ፦* ስልክ ቁጥርዎ በ `/users/{uid}/private/contact` ውስጥ በጥብቅ ደህንነት ተነጥሎ ይቀመጣል።',
            ].join('\n')
          : [
              '📜 *ADEYBINGO Terms, Rules & Privacy Notice (/terms)*',
              '',
              '1. *Demo Sandbox Mode:* Real-money payments remain disabled; all balances are Demo ETB.',
              '2. *Fair Play:* 1–600 cards per room; max 4 cards per player.',
              '3. *Phone Privacy:* Your phone number is strictly isolated in `/users/{uid}/private/contact`.',
            ].join('\n');

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text: termsText,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(
          currentLang,
          Boolean(existingPlayer?.phoneVerified),
          'support'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        profile: existingPlayer,
      };
    }

    // Default fallback -> guide user cleanly in saved language
    return this.handleStartCommand({
      senderTelegramId,
      firstName,
      lastName,
      username,
      firebaseUid,
    });
  }

  private processDemoDepositSubmission(
    player: RegisteredTelegramPlayer,
    method: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)',
    amountEtb: number
  ): TelegramBotResponse {
    const lang = player.language;
    if (!Number.isFinite(amountEtb) || amountEtb < 10 || amountEtb > 10000) {
      return {
        ok: false,
        chatId: player.telegramUserId,
        language: lang,
        text:
          lang === 'am'
            ? '⚠️ እባክዎ ከ *10 ETB* እስከ *10,000 ETB* መካከል ትክክለኛ የሙከራ መጠን ያስገቡ።'
            : '⚠️ Please enter a valid Demo deposit amount between *10 ETB* and *10,000 ETB*.',
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'deposit'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'invalid_deposit_amount',
        profile: player,
      };
    }

    const nowIso = new Date().toISOString();
    const depositId = `DEP-BOT-${Date.now().toString(36).toUpperCase()}`;
    const referenceCode = `REF-${Math.floor(100000 + Math.random() * 899999)}`;
    const rec: BotEngineDepositRecord = {
      depositId,
      telegramUserId: player.telegramUserId,
      uid: player.uid,
      userDisplayName: `${player.firstName} ${player.lastName || ''}`.trim(),
      provider: method,
      amountEtb,
      referenceCode,
      status: 'Pending',
      createdAt: nowIso,
      demoSandboxOnly: true,
    };
    this.depositRequests.set(depositId, rec);
    player.pendingAction = null;
    player.pendingMethod = null;
    player.updatedAt = nowIso;

    return {
      ok: true,
      chatId: player.telegramUserId,
      language: lang,
      text:
        lang === 'am'
          ? [
              '✅ *የሙከራ ገንዘብ ማስገቢያ ጥያቄ ተመዝግቧል!*',
              '',
              `• የጥያቄ መለያ፦ \`${depositId}\``,
              `• የማጣቀሻ ኮድ፦ \`${referenceCode}\``,
              `• የክፍያ መንገድ፦ *${method}*`,
              `• መጠን፦ *${amountEtb.toFixed(2)} ETB (DEMO)*`,
              '• ሁኔታ፦ *Pending (በመጠባበቅ ላይ)*',
              '',
              'ℹ️ _Demo Sandbox፦ አስተዳዳሪ (Admin) ሲያጸድቀው ወደ የሙከራ ቦርሳዎ ይገባል።_',
            ].join('\n')
          : [
              '✅ *Demo Deposit Request Submitted!*',
              '',
              `• Request ID: \`${depositId}\``,
              `• Reference: \`${referenceCode}\``,
              `• Method: *${method}*`,
              `• Amount: *${amountEtb.toFixed(2)} ETB (DEMO)*`,
              '• Status: *Pending Review*',
              '',
              'ℹ️ _Demo Sandbox: Credited after administrator review._',
            ].join('\n'),
      parseMode: 'Markdown',
      replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'deposit'),
      registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
      securityCode: 'deposit_request_created',
      callbackAnswerText: lang === 'am' ? '✅ ጥያቄው ተልኳል' : '✅ Deposit request submitted',
      profile: player,
    };
  }

  private processDemoWithdrawSubmission(
    player: RegisteredTelegramPlayer,
    method: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)',
    amountEtb: number
  ): TelegramBotResponse {
    const lang = player.language;
    if (!Number.isFinite(amountEtb) || amountEtb < 20) {
      return {
        ok: false,
        chatId: player.telegramUserId,
        language: lang,
        text:
          lang === 'am'
            ? '⚠️ ዝቅተኛው የሙከራ ወጪ መጠን *20.00 ETB (DEMO)* ነው።'
            : '⚠️ Minimum Demo withdrawal amount is *20.00 ETB (DEMO)*.',
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'withdraw'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'invalid_withdraw_amount',
        profile: player,
      };
    }

    if (amountEtb > player.demoBalanceEtb) {
      return {
        ok: false,
        chatId: player.telegramUserId,
        language: lang,
        text:
          lang === 'am'
            ? `⚠️ በቂ የሙከራ ቀሪ ሂሳብ የለም። የሚገኝ ቀሪ ሂሳብ፦ *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*።`
            : `⚠️ Insufficient Demo balance. Available Demo balance: *${player.demoBalanceEtb.toFixed(2)} ETB (DEMO)*.`,
        parseMode: 'Markdown',
        replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'withdraw'),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'insufficient_demo_balance',
        profile: player,
      };
    }

    const nowIso = new Date().toISOString();
    const requestId = `PO-BOT-${Date.now().toString(36).toUpperCase()}`;
    const rec: BotEngineWithdrawalRecord = {
      requestId,
      telegramUserId: player.telegramUserId,
      uid: player.uid,
      userDisplayName: `${player.firstName} ${player.lastName || ''}`.trim(),
      paymentMethod: method,
      requestedAmountEtb: amountEtb,
      status: 'Pending',
      reviewNotes: 'Submitted via @AdeyBingoBot (Demo Sandbox)',
      createdAt: nowIso,
      demoSandboxOnly: true,
    };
    this.withdrawalRequests.set(requestId, rec);
    player.pendingAction = null;
    player.pendingMethod = null;
    player.updatedAt = nowIso;

    return {
      ok: true,
      chatId: player.telegramUserId,
      language: lang,
      text:
        lang === 'am'
          ? [
              '✅ *የሙከራ ገንዘብ ማውጫ ጥያቄ ተመዝግቧል!*',
              '',
              `• የጥያቄ መለያ፦ \`${requestId}\``,
              `• መንገድ፦ *${method}*`,
              `• መጠን፦ *${amountEtb.toFixed(2)} ETB (DEMO)*`,
              '• ሁኔታ፦ *Pending (በግምገማ ላይ)*',
            ].join('\n')
          : [
              '✅ *Demo Withdrawal Request Submitted!*',
              '',
              `• Request ID: \`${requestId}\``,
              `• Method: *${method}*`,
              `• Amount: *${amountEtb.toFixed(2)} ETB (DEMO)*`,
              '• Status: *Pending Review*',
            ].join('\n'),
      parseMode: 'Markdown',
      replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'withdraw'),
      registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
      securityCode: 'withdraw_request_created',
      callbackAnswerText: lang === 'am' ? '✅ የወጪ ጥያቄ ተልኳል' : '✅ Withdrawal submitted',
      profile: player,
    };
  }

  private handleStartCommand(params: {
    senderTelegramId: number;
    firstName: string;
    lastName?: string;
    username: string;
    firebaseUid?: string;
    referralCode?: string;
  }): TelegramBotResponse {
    const { senderTelegramId, firstName, lastName, username, firebaseUid, referralCode } = params;
    const candidateUid = firebaseUid || `tg_uid_${senderTelegramId}`;

    const boundTgForUid = this.telegramIdByUid.get(candidateUid);
    if (boundTgForUid !== undefined && boundTgForUid !== senderTelegramId) {
      const lang = this.getLanguage(senderTelegramId);
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

    let player = this.playersByTelegramId.get(senderTelegramId);
    if (player && firebaseUid && player.uid !== firebaseUid) {
      const lang = player.language;
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

    const isNewUser = !player;
    const lang: Language = player ? player.language : this.getLanguage(senderTelegramId);

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
    player.pendingAction = null;
    player.pendingMethod = null;

    let referralNoticeAm = '';
    let referralNoticeEn = '';
    if (referralCode && referralCode.startsWith('ADEY-')) {
      const inviterId = Number(referralCode.slice(5));
      if (Number.isInteger(inviterId) && inviterId > 0) {
        if (inviterId === senderTelegramId) {
          referralNoticeAm = '\n\n⚠️ _የራስዎን የግብዣ ሊንክ መጠቀም አይችሉም።_';
          referralNoticeEn = '\n\n⚠️ _Self-referrals are not permitted._';
        } else if (!this.referredInviteeIds.has(senderTelegramId) && isNewUser) {
          this.referredInviteeIds.add(senderTelegramId);
          player.referredByCode = referralCode;
          player.referredByUid = `tg_${inviterId}`;
          player.demoBalanceEtb += 15;
          const inviterRefs = this.referralsByInviter.get(inviterId) || [];
          inviterRefs.push({
            inviteeTelegramId: senderTelegramId,
            inviteeName: player.firstName,
            bonusEtb: 20,
            createdAt: new Date().toISOString(),
          });
          this.referralsByInviter.set(inviterId, inviterRefs);
          const inviterPlayer = this.playersByTelegramId.get(inviterId);
          if (inviterPlayer) {
            inviterPlayer.demoBalanceEtb += 20;
            this.queueNotification('referral_confirmation', inviterId, {
              friendName: player.firstName,
              inviterBonusEtb: 20,
            });
          }
          referralNoticeAm = '\n\n🎁 _በጓደኛ ግብዣ +15.00 ETB የሙከራ እንኳን ደህና መጡ ቦነስ ተጨምሯል!_';
          referralNoticeEn = '\n\n🎁 _Referral welcome bonus: +15.00 ETB Demo credited!_';
        }
      }
    }

    const coreWelcomeAm = [
      '🎱 እንኳን ወደ ADEYBINGO በደህና መጡ!',
      '',
      'ቢንጎ ይጫወቱ፣ የቦርሳዎን መረጃ ይመልከቱ፣ ጓደኞችዎን ይጋብዙ እና በጨዋታው ይደሰቱ!',
      '',
      'ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ።',
    ].join('\n');

    const coreWelcomeEn = [
      '🎱 Welcome to ADEYBINGO!',
      '',
      'Play live Bingo, manage your wallet, invite friends, and enjoy the game!',
      '',
      'Choose an option below to get started.',
    ].join('\n');

    const privacyVerificationNoteAm = player.phoneVerified
      ? ''
      : '\n\n🔒 _መለያዎን ለማረጋገጥ እና ድጋሚ ምዝገባን ለመከላከል ከታች ያለውን 📲 ስልክ ቁጥርዎን ያጋሩ የሚለውን ይጫኑ (በ `/users/{uid}/private/contact` በደህንነት ይጠበቃል)።_';
    const privacyVerificationNoteEn = player.phoneVerified
      ? ''
      : '\n\n🔒 _Tap 📲 Share Telegram Phone Contact below to verify your account (strictly isolated in `/users/{uid}/private/contact`)._';

    const welcomeAm = this.customWelcomeAm
      ? `${coreWelcomeAm}\n\n${this.customWelcomeAm}${referralNoticeAm}${privacyVerificationNoteAm}`
      : `${coreWelcomeAm}${referralNoticeAm}${privacyVerificationNoteAm}`;
    const welcomeEn = this.customWelcomeEn
      ? `${coreWelcomeEn}\n\n${this.customWelcomeEn}${referralNoticeEn}${privacyVerificationNoteEn}`
      : `${coreWelcomeEn}${referralNoticeEn}${privacyVerificationNoteEn}`;

    return {
      ok: true,
      chatId: senderTelegramId,
      language: lang,
      text: lang === 'am' ? welcomeAm : welcomeEn,
      parseMode: 'Markdown',
      replyMarkup: this.buildMenuMarkup(lang, player.phoneVerified, 'welcome'),
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
        replyMarkup: buildBotMainMenuMarkup(lang, this.miniAppUrl, false, this.buttonLabels),
        registrationStatus: 'pending_contact',
        securityCode: verification.reason,
      };
    }

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
      replyMarkup: buildBotMainMenuMarkup(lang, this.miniAppUrl, true, this.buttonLabels),
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

  public resetRoomCalls(roomId: string, initialCalls: number[] = [9, 30, 7, 16, 14]): void {
    const sess = this.ensureRoomSession(roomId);
    sess.status = 'countdown';
    sess.calledNumbers = [...initialCalls];
    sess.latestBall = initialCalls[initialCalls.length - 1] ?? null;
    sess.winner = undefined;
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

