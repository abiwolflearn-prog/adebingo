import type {
  GameHistoryItem,
  NotificationItem,
  ReferralRecord,
  RoomConfig,
  SupportTicket,
  WalletTransaction,
} from '../types/bingo.ts';

import { createCleanInitialRoomConfigs } from '../game/roomCatalog.ts';

/**
 * Clean pre-hydration UI room configurations derived from the single authoritative
 * production room catalog (0 players, 0 taken cards, countdown status).
 * Never injects fabricated players, fake taken cards, or fake live games.
 */
export const INITIAL_ROOMS: RoomConfig[] = createCleanInitialRoomConfigs();

/**
 * Clearly isolated static UI preview fixtures (never persisted to Firestore or used as real records).
 */
export const DEMO_UI_FIXTURE_ONLY = true;

export const INITIAL_TRANSACTIONS: WalletTransaction[] = [
  {
    id: 'tx-101',
    type: 'deposit_demo',
    amount: 200,
    provider: 'Telebirr (Demo Sandbox)',
    status: 'demo_completed',
    labelAm: 'የሙከራ ሂሳብ መሙያ (Telebirr Demo)',
    labelEn: 'Demo Balance Top-up (Telebirr Sandbox)',
    timestamp: 'ዛሬ · 10:15 AM',
    reference: 'ADB-DEP-90821',
  },
  {
    id: 'tx-102',
    type: 'referral_bonus',
    amount: 20,
    provider: 'ADEY Referral',
    status: 'demo_completed',
    labelAm: 'የጓደኛ ግብዣ ቦነስ (@dawit_t)',
    labelEn: 'Friend Referral Bonus (@dawit_t)',
    timestamp: 'ዛሬ · 10:40 AM',
    reference: 'ADB-REF-44102',
  },
  {
    id: 'tx-103',
    type: 'card_entry',
    amount: -20,
    provider: 'Adey Main Hall',
    status: 'demo_completed',
    labelAm: '2 የቢንጎ ካርዶች (#1, #7) — የሙከራ ዙር',
    labelEn: '2 Bingo Cards (#1, #7) — Demo Entry',
    timestamp: 'ዛሬ · 11:02 AM',
    reference: 'ADB-GME-77319',
  },
  {
    id: 'tx-104',
    type: 'bingo_win',
    amount: 50,
    provider: 'Adey Main Hall',
    status: 'demo_completed',
    labelAm: 'የቢንጎ አሸናፊነት ሽልማት (Demo Credit)',
    labelEn: 'Bingo Round Win Credit (Demo)',
    timestamp: 'ዛሬ · 11:08 AM',
    reference: 'ADB-WIN-77399',
  },
];

export const INITIAL_REFERRALS: ReferralRecord[] = [
  {
    id: 'ref-1',
    friendName: 'Dawit Tadesse',
    handle: '@dawit_t',
    joinedAt: '2 ሰዓት በፊት · 2h ago',
    status: 'qualified',
    inviterBonus: 20,
    inviteeBonus: 0,
  },
  {
    id: 'ref-2',
    friendName: 'Hanna Mekonnen',
    handle: '@hanna_m',
    joinedAt: 'ትናንት · Yesterday',
    status: 'qualified',
    inviterBonus: 20,
    inviteeBonus: 0,
  },
  {
    id: 'ref-3',
    friendName: 'Yonas Kebede',
    handle: '@yonas_k',
    joinedAt: '3 ቀን በፊት · 3d ago',
    status: 'pending',
    inviterBonus: 20,
    inviteeBonus: 0,
  },
];

export const INITIAL_GAME_HISTORY: GameHistoryItem[] = [
  {
    id: 'gh-301',
    roomNameAm: 'አደይ ዋና አዳራሽ',
    roomNameEn: 'Adey Main Hall',
    playedAt: 'ዛሬ · 11:08 AM',
    cardIds: [1, 7],
    entryFeeDemo: 20,
    outcome: 'won',
    prizeDemo: 50,
    winningBall: 'N-34',
    callsCount: 19,
    patternAm: 'አግድም መስመር (ረድፍ 3)',
    patternEn: 'Horizontal Line (Row 3)',
  },
  {
    id: 'gh-300',
    roomNameAm: 'አዲስ ፈጣን ቢንጎ',
    roomNameEn: 'Addis Turbo Arena',
    playedAt: 'ትናንት · 8:45 PM',
    cardIds: [12, 45, 108],
    entryFeeDemo: 30,
    outcome: 'completed',
    prizeDemo: 0,
    winningBall: 'G-52',
    callsCount: 24,
  },
];

export const INITIAL_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'not-1',
    titleAm: 'እንኳን ወደ ADEYBINGO በደህና መጡ!',
    titleEn: 'Welcome to ADEYBINGO!',
    bodyAm: '15.00 ETB የመጀመሪያ ቀሪ ሂሳብ ተዘጋጅቶልዎታል። እስከ 4 ካርዶችን ይምረጡ እና ይጫወቱ።',
    bodyEn: 'Your 15.00 ETB initial balance is ready. Pick up to 4 cards and join the live arena.',
    time: 'አሁን · Just now',
    read: false,
  },
  {
    id: 'not-2',
    titleAm: 'የጓደኛ ግብዣ ቦነስ ህግ',
    titleEn: 'Referral Reward Program',
    bodyAm: 'ጓደኛዎ ሲቀላቀል ለእርስዎ 20 ETB የግብዣ ሽልማት ይሰጣል፤ አዲሱ ተጫዋች 15 ETB የመጀመሪያ ሂሳብ ያገኛል።',
    bodyEn: 'Earn 20 ETB for every referred new player; every new player starts with 15 ETB initial credit.',
    time: '1 ሰዓት በፊት · 1h ago',
    read: false,
  },
];

export const INITIAL_SUPPORT_TICKETS: SupportTicket[] = [
  {
    id: 'TKT-1042',
    category: 'game_rules',
    subject: 'Auto-marking cards in live room',
    message: 'How do I switch between automatic and manual card marking?',
    createdAt: 'Yesterday',
    status: 'answered',
  },
];

export const LIVE_DEMO_PLAYERS = [
  { name: 'Meron A.', cards: 3, avatar: 'MA' },
  { name: 'Dawit T.', cards: 4, avatar: 'DT' },
  { name: 'Selam W.', cards: 2, avatar: 'SW' },
  { name: 'Biniyam K.', cards: 4, avatar: 'BK' },
  { name: 'Tigist H.', cards: 1, avatar: 'TH' },
  { name: 'Nahom G.', cards: 3, avatar: 'NG' },
];
