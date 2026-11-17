export type Language = 'am' | 'en';

export type ScreenId =
  | 'home'
  | 'lobby'
  | 'cards'
  | 'game'
  | 'leaderboard'
  | 'wallet'
  | 'deposit'
  | 'withdraw'
  | 'referral'
  | 'profile'
  | 'support'
  | 'terms';

export type AppScreen = ScreenId;

export type BingoLetter = 'B' | 'I' | 'N' | 'G' | 'O';

export interface BingoColumnSpec {
  letter: BingoLetter;
  min: number;
  max: number;
  color: string;
  accentBg: string;
}

export interface BingoCard {
  id: number; // 1 to 600
  serial: string;
  /** 5x5 grid indexed [row][col]. Center [2][2] is 0 (Free Space). */
  grid: number[][];
}

export type WinPatternType = 'row' | 'column' | 'diagonal' | 'four_corners';

export interface WinResult {
  won: boolean;
  cardId: number;
  patternType?: WinPatternType;
  patternLabelAm?: string;
  patternLabelEn?: string;
  winningCells: [number, number][];
  missingNumbers?: number[];
}

export type GameLifecycleStage =
  | 'WAITING'
  | 'REGISTRATION'
  | 'READY'
  | 'IN_PROGRESS'
  | 'COMPLETED';

export interface RoomConfig {
  id: string;
  nameAm: string;
  nameEn: string;
  subtitleAm: string;
  subtitleEn: string;
  cardPrice: number; // Default 10 ETB
  maxCardsPerRoom: number; // 600
  maxCardsPerPlayer: number; // 4
  maxPlayers?: number; // 600 individual players
  minPlayers: number; // 3
  countdownSeconds: number;
  activePlayers: number;
  confirmedPlayersCount?: number;
  verifiedPaidEntriesCount?: number;
  availableSpaces?: number;
  totalCardsSold?: number;
  totalCollectedEtb?: number;
  adeyShareEtb?: number;
  winnersPrizePoolEtb?: number;
  takenCardIds: number[];
  status: 'countdown' | 'live' | 'waiting' | 'completed';
  lifecycleStage?: GameLifecycleStage;
  badgeAm: string;
  badgeEn: string;
}

export interface WalletTransaction {
  id: string;
  type: 'deposit_demo' | 'withdraw_demo' | 'card_entry' | 'bingo_win' | 'referral_bonus';
  amount: number;
  provider?: string;
  status: 'demo_completed' | 'demo_pending';
  labelAm: string;
  labelEn: string;
  timestamp: string;
  reference: string;
}

export interface DepositRequestSummary {
  depositId: string;
  amountEtb: number;
  provider: string;
  referenceCode: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestDate: string;
}

export interface PayoutRequestSummary {
  requestId: string;
  requestedAmountEtb: number;
  paymentMethod: string;
  status: 'Pending' | 'Under Review' | 'Approved' | 'Rejected' | 'Completed';
  requestDate: string;
  reviewNotes: string;
}

export interface LeaderboardEntry {
  uid: string;
  telegramUserId: number;
  displayName: string;
  wins: number;
  winningsEtb: number;
}

export interface PlayerStateResponse {
  ok: boolean;
  profile: {
    uid: string;
    telegramUserId: number;
    displayName: string;
    username: string;
    language: Language;
    phoneVerified: boolean;
    referralCode: string;
    referredByCode?: string;
  };
  wallet: {
    availableBalanceEtb: number;
    winningsBalanceEtb: number;
    demoSandboxOnly: boolean;
  };
  transactions: WalletTransaction[];
  depositRequests: DepositRequestSummary[];
  payoutRequests: PayoutRequestSummary[];
  referrals: ReferralRecord[];
  gameHistory: GameHistoryItem[];
  leaderboard: LeaderboardEntry[];
}

export interface ReferralRecord {
  id: string;
  friendName: string;
  handle: string;
  joinedAt: string;
  status: 'qualified' | 'pending';
  inviterBonus: number; // 20 ETB
  inviteeBonus: number; // 15 ETB
}

export interface GameHistoryItem {
  id: string;
  roomNameAm: string;
  roomNameEn: string;
  playedAt: string;
  cardIds: number[];
  entryFeeDemo: number;
  outcome: 'won' | 'completed';
  prizeDemo: number;
  winningBall?: string;
  callsCount: number;
  patternEn?: string;
  patternAm?: string;
}

export interface SupportTicket {
  id: string;
  category: string;
  subject: string;
  message: string;
  createdAt: string;
  status: 'received' | 'answered';
}

export interface NotificationItem {
  id: string;
  titleAm: string;
  titleEn: string;
  bodyAm: string;
  bodyEn: string;
  time: string;
  read: boolean;
}

export type ConnectionState = 'online' | 'reconnecting' | 'offline';
