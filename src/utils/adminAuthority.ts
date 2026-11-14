import crypto from 'node:crypto';
import type { Language } from '../types/bingo.ts';
import { validateTelegramWebAppInitData } from './telegramVerify.ts';
import type {
  AdeyBingoTelegramBotEngine,
  BotAdminConfig,
  BotAnnouncementRecord,
  BotButtonLabelsConfig,
} from './telegramBot.ts';

export type UserRole = 'player' | 'admin';

export type PayoutOrderStatus =
  | 'Pending'
  | 'Under Review'
  | 'Approved'
  | 'Rejected'
  | 'Completed';

export type DepositRequestStatus = 'Pending' | 'Approved' | 'Rejected';

export interface VerifiedSessionActor {
  uid: string;
  telegramUserId: number;
  displayName: string;
  username: string;
  email?: string;
  role: UserRole;
  authMethod: 'server_session_token' | 'telegram_init_data' | 'firebase_id_token';
  issuedAt: number;
  expiresAt: number;
}

export interface AdminAuthorizationResult {
  authorized: boolean;
  statusCode: 200 | 401 | 403;
  reason:
    | 'authorized_admin'
    | 'unauthenticated'
    | 'invalid_or_expired_token'
    | 'forbidden_not_admin'
    | 'self_role_escalation_forbidden';
  actor?: VerifiedSessionActor;
}

export interface AdminAuditRecord {
  id: string;
  sequence: number;
  timestamp: string;
  adminUid: string;
  adminName: string;
  adminTelegramId: number;
  action:
    | 'USER_STATUS_CHANGED'
    | 'PAYOUT_STATUS_REVIEWED'
    | 'DEPOSIT_STATUS_REVIEWED'
    | 'ROOM_CONFIG_UPDATED'
    | 'BOT_CONFIG_UPDATED'
    | 'BOT_ANNOUNCEMENT_SENT'
    | 'ROLE_ESCALATION_BLOCKED';
  targetId: string;
  summary: string;
  previousValue?: string;
  newValue?: string;
  notes?: string;
  prevHash: string;
  entryHash: string;
}

export interface AdminUserWalletEntry {
  id: string;
  type: 'deposit_demo' | 'withdraw_demo' | 'bingo_win' | 'card_entry' | 'referral_bonus';
  amountEtb: number;
  description: string;
  reference: string;
  timestamp: string;
  status: string;
}

export interface AdminManagedUserRecord {
  uid: string;
  telegramUserId: number;
  displayName: string;
  username: string;
  role: UserRole;
  accountStatus: 'active' | 'suspended';
  suspensionReason?: string;
  phoneVerified: boolean;
  maskedPhone: string; // PII-safe masked representation; raw phone stays isolated in /private/contact
  language: Language;
  demoBalanceEtb: number;
  gamesPlayed: number;
  gamesWon: number;
  referralCode: string;
  referredByCode?: string;
  referralsCount: number;
  lastActiveAt: string;
  registeredAt: string;
  walletLedger: AdminUserWalletEntry[];
}

export interface PayoutStatusTransition {
  timestamp: string;
  fromStatus: PayoutOrderStatus | 'Created';
  toStatus: PayoutOrderStatus;
  reviewedBy: string;
  notes: string;
}

export interface AdminPayoutOrder {
  requestId: string;
  uid: string;
  userDisplayName: string;
  telegramUserId: number;
  requestedAmountEtb: number;
  requestDate: string;
  paymentMethod: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)';
  destinationMasked: string;
  status: PayoutOrderStatus;
  reviewNotes: string;
  reviewedBy?: string;
  reviewedAt?: string;
  demoSandboxOnly: true;
  auditTrail: PayoutStatusTransition[];
}

export interface AdminDepositRequest {
  depositId: string;
  uid: string;
  userDisplayName: string;
  telegramUserId: number;
  amountEtb: number;
  requestDate: string;
  provider: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)';
  referenceCode: string;
  status: DepositRequestStatus;
  reviewNotes: string;
  reviewedBy?: string;
  reviewedAt?: string;
  demoSandboxOnly: true;
}

export interface AdminRoomConfigRecord {
  id: string;
  nameAm: string;
  nameEn: string;
  cardPriceEtb: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  lobbyCountdownSeconds: number;
  minPlayers: number;
  activePlayers: number;
  status: 'open' | 'starting' | 'live' | 'maintenance';
  updatedAt: string;
}

export interface AdminReferralRecord {
  id: string;
  inviterUid: string;
  inviterName: string;
  inviterTelegramId: number;
  inviteeUid: string;
  inviteeName: string;
  inviteeHandle: string;
  joinedAt: string;
  status: 'qualified' | 'pending_verification';
  inviterBonusEtb: number;
  inviteeBonusEtb: number;
}

export const AUTHORIZED_ADMIN_TELEGRAM_IDS: readonly number[] = Object.freeze([8842109]);
export const AUTHORIZED_ADMIN_EMAILS: readonly string[] = Object.freeze([
  'abelbimrew868@gmail.com',
]);

/**
 * Signs a tamper-evident server session token using HMAC-SHA256 with an explicit expiration timestamp.
 * Roles are determined strictly on the backend from the server-side admin allowlist—never from client input.
 */
export function mintServerSessionToken(
  params: {
    uid?: string;
    telegramUserId: number;
    displayName: string;
    username: string;
    email?: string;
    isAdminOverride?: boolean;
    nowUnixSeconds?: number;
    expiresInSeconds?: number;
  },
  secretKey: string
): { token: string; actor: VerifiedSessionActor } {
  const nowSec = params.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSec = Math.max(60, Math.min(86400, params.expiresInSeconds ?? 3600));
  const isAdmin =
    Boolean(params.isAdminOverride) ||
    AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(params.telegramUserId) ||
    (params.email ? AUTHORIZED_ADMIN_EMAILS.includes(params.email.toLowerCase()) : false);

  const actor: VerifiedSessionActor = {
    uid: params.uid || `tg_${params.telegramUserId}`,
    telegramUserId: params.telegramUserId,
    displayName: params.displayName,
    username: params.username,
    email: params.email,
    role: isAdmin ? 'admin' : 'player',
    authMethod: 'server_session_token',
    issuedAt: nowSec,
    expiresAt: nowSec + ttlSec,
  };

  const payloadB64 = Buffer.from(JSON.stringify(actor), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secretKey)
    .update(payloadB64)
    .digest('base64url');

  return {
    token: `${payloadB64}.${sig}`,
    actor,
  };
}

/**
 * Verifies a server-issued session token using constant-time HMAC comparison and expiration bounds.
 * Re-computes the actor's role against the server-side allowlist so even a forged payload role cannot escalate privileges.
 */
export function verifyServerSessionToken(
  token: string | undefined,
  secretKey: string,
  maxAgeSeconds: number = 86400,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000)
): VerifiedSessionActor | null {
  if (!token || typeof token !== 'string' || !token.includes('.') || !secretKey) {
    return null;
  }
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts;

  const expectedSig = crypto
    .createHmac('sha256', secretKey)
    .update(payloadB64)
    .digest('base64url');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as VerifiedSessionActor;
    if (
      typeof parsed.telegramUserId !== 'number' ||
      typeof parsed.issuedAt !== 'number'
    ) {
      return null;
    }
    const expiresAt =
      typeof parsed.expiresAt === 'number'
        ? parsed.expiresAt
        : parsed.issuedAt + maxAgeSeconds;

    if (
      nowUnixSeconds >= expiresAt ||
      nowUnixSeconds - parsed.issuedAt > maxAgeSeconds ||
      parsed.issuedAt > nowUnixSeconds + 60
    ) {
      return null;
    }

    // Re-evaluate admin authorization from the server allowlist (never trust serialized role alone)
    const isServerAuthorizedAdmin =
      AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(parsed.telegramUserId) ||
      (parsed.email ? AUTHORIZED_ADMIN_EMAILS.includes(parsed.email.toLowerCase()) : false);

    return {
      ...parsed,
      expiresAt,
      role: isServerAuthorizedAdmin ? 'admin' : 'player',
    };
  } catch {
    return null;
  }
}

/**
 * Part C: Server-side Admin Authorization Guard.
 * - Never trusts client-supplied `clientClaimedRole` or `localStorage` values.
 * - Returns HTTP 401 when unauthenticated.
 * - Returns HTTP 403 when authenticated as a normal player (`role === 'player'`).
 * - Returns HTTP 200 only when authenticated as a server-verified administrator.
 */
export function authorizeAdminRequest(params: {
  sessionToken?: string;
  telegramInitData?: string;
  botToken: string;
  sessionSecret: string;
  nowUnixSeconds?: number;
}): AdminAuthorizationResult {
  const {
    sessionToken,
    telegramInitData,
    botToken,
    sessionSecret,
    nowUnixSeconds = Math.floor(Date.now() / 1000),
  } = params;

  // 1. Check signed server session token if provided
  if (sessionToken && sessionToken.trim().length > 0) {
    const actor = verifyServerSessionToken(sessionToken, sessionSecret, 86400, nowUnixSeconds);
    if (!actor) {
      return {
        authorized: false,
        statusCode: 401,
        reason: 'invalid_or_expired_token',
      };
    }
    if (actor.role !== 'admin') {
      return {
        authorized: false,
        statusCode: 403,
        reason: 'forbidden_not_admin',
        actor,
      };
    }
    return {
      authorized: true,
      statusCode: 200,
      reason: 'authorized_admin',
      actor,
    };
  }

  // 2. Check cryptographic Telegram WebApp initData if provided
  if (telegramInitData && telegramInitData.trim().length > 0) {
    const initCheck = validateTelegramWebAppInitData(telegramInitData, botToken, {
      nowUnixSeconds,
      maxAgeSeconds: 86400,
    });
    if (!initCheck.valid || !initCheck.telegramUser) {
      return {
        authorized: false,
        statusCode: 401,
        reason: 'invalid_or_expired_token',
      };
    }
    const tgUser = initCheck.telegramUser;
    const isAdmin = AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(tgUser.id);
    const actor: VerifiedSessionActor = {
      uid: `tg_${tgUser.id}`,
      telegramUserId: tgUser.id,
      displayName: `${tgUser.first_name} ${tgUser.last_name || ''}`.trim(),
      username: tgUser.username || `tg_${tgUser.id}`,
      role: isAdmin ? 'admin' : 'player',
      authMethod: 'telegram_init_data',
      issuedAt: nowUnixSeconds,
      expiresAt: nowUnixSeconds + 3600,
    };

    if (!isAdmin) {
      return {
        authorized: false,
        statusCode: 403,
        reason: 'forbidden_not_admin',
        actor,
      };
    }

    return {
      authorized: true,
      statusCode: 200,
      reason: 'authorized_admin',
      actor,
    };
  }

  // 3. Unauthenticated request -> HTTP 401
  return {
    authorized: false,
    statusCode: 401,
    reason: 'unauthenticated',
  };
}

/**
 * Server-Authoritative Admin & Operations Authority.
 * Manages users, demo payout orders, demo deposit requests, game rooms, referrals, bot settings,
 * notifications, and an immutable SHA-256 hash-chained audit trail.
 */
export class ServerAdminAuthority {
  private users = new Map<string, AdminManagedUserRecord>();
  private payouts = new Map<string, AdminPayoutOrder>();
  private deposits = new Map<string, AdminDepositRequest>();
  private rooms = new Map<string, AdminRoomConfigRecord>();
  private referrals: AdminReferralRecord[] = [];
  private auditChain: AdminAuditRecord[] = [];
  private botEngine: AdeyBingoTelegramBotEngine;

  constructor(botEngine: AdeyBingoTelegramBotEngine) {
    this.botEngine = botEngine;
    this.seedInitialData();
  }

  private appendAuditRecord(params: {
    adminActor: VerifiedSessionActor;
    action: AdminAuditRecord['action'];
    targetId: string;
    summary: string;
    previousValue?: string;
    newValue?: string;
    notes?: string;
  }): AdminAuditRecord {
    const sequence = this.auditChain.length + 1;
    const prevHash =
      this.auditChain.length > 0
        ? this.auditChain[this.auditChain.length - 1].entryHash
        : 'GENESIS_ADEYBINGO_AUDIT_0000000000000000';
    const timestamp = new Date().toISOString();
    const id = `aud_${sequence}_${Date.now()}`;

    const canonical = [
      id,
      String(sequence),
      timestamp,
      params.adminActor.uid,
      String(params.adminActor.telegramUserId),
      params.action,
      params.targetId,
      params.summary,
      params.previousValue || '',
      params.newValue || '',
      params.notes || '',
      prevHash,
    ].join('|');

    const entryHash = crypto.createHash('sha256').update(canonical).digest('hex');

    const record: AdminAuditRecord = Object.freeze({
      id,
      sequence,
      timestamp,
      adminUid: params.adminActor.uid,
      adminName: params.adminActor.displayName,
      adminTelegramId: params.adminActor.telegramUserId,
      action: params.action,
      targetId: params.targetId,
      summary: params.summary,
      previousValue: params.previousValue,
      newValue: params.newValue,
      notes: params.notes,
      prevHash,
      entryHash,
    });

    this.auditChain.push(record);
    return record;
  }

  public verifyAuditChainIntegrity(): { valid: boolean; totalEntries: number } {
    for (let i = 0; i < this.auditChain.length; i++) {
      const rec = this.auditChain[i];
      const expectedPrev =
        i === 0
          ? 'GENESIS_ADEYBINGO_AUDIT_0000000000000000'
          : this.auditChain[i - 1].entryHash;
      if (rec.prevHash !== expectedPrev) {
        return { valid: false, totalEntries: this.auditChain.length };
      }
      const canonical = [
        rec.id,
        String(rec.sequence),
        rec.timestamp,
        rec.adminUid,
        String(rec.adminTelegramId),
        rec.action,
        rec.targetId,
        rec.summary,
        rec.previousValue || '',
        rec.newValue || '',
        rec.notes || '',
        rec.prevHash,
      ].join('|');
      const recomputed = crypto.createHash('sha256').update(canonical).digest('hex');
      if (recomputed !== rec.entryHash) {
        return { valid: false, totalEntries: this.auditChain.length };
      }
    }
    return { valid: true, totalEntries: this.auditChain.length };
  }

  private seedInitialData(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const seedAdmin: VerifiedSessionActor = {
      uid: 'tg_8842109',
      telegramUserId: 8842109,
      displayName: 'Abebe Bikila (Lead Admin)',
      username: 'abebe_adey',
      email: 'abelbimrew868@gmail.com',
      role: 'admin',
      authMethod: 'server_session_token',
      issuedAt: nowSec,
      expiresAt: nowSec + 3600,
    };

    const seedUsers: AdminManagedUserRecord[] = [
      {
        uid: 'tg_8842109',
        telegramUserId: 8842109,
        displayName: 'Abebe Bikila',
        username: 'abebe_adey',
        role: 'admin',
        accountStatus: 'active',
        phoneVerified: true,
        maskedPhone: '+25191****44',
        language: 'am',
        demoBalanceEtb: 250.0,
        gamesPlayed: 18,
        gamesWon: 5,
        referralCode: 'ADEY-8842109',
        referralsCount: 3,
        lastActiveAt: '2026-03-30T10:15:00Z',
        registeredAt: '2026-03-01T08:00:00Z',
        walletLedger: [
          {
            id: 'tx-101',
            type: 'bingo_win',
            amountEtb: 80,
            description: 'Bingo Win Credit (Card #14 · Demo)',
            reference: 'ADB-WIN-90412',
            timestamp: '2026-03-30 09:40',
            status: 'demo_completed',
          },
          {
            id: 'tx-102',
            type: 'deposit_demo',
            amountEtb: 100,
            description: 'Demo Sandbox Deposit (Telebirr)',
            reference: 'ADB-DEP-77201',
            timestamp: '2026-03-29 18:15',
            status: 'demo_completed',
          },
        ],
      },
      {
        uid: 'tg_7777777',
        telegramUserId: 7777777,
        displayName: 'Dawit Mekonnen',
        username: 'dawit_m',
        role: 'player',
        accountStatus: 'active',
        phoneVerified: true,
        maskedPhone: '+25192****81',
        language: 'am',
        demoBalanceEtb: 190.0,
        gamesPlayed: 11,
        gamesWon: 2,
        referralCode: 'ADEY-7777777',
        referredByCode: 'ADEY-8842109',
        referralsCount: 1,
        lastActiveAt: '2026-03-30T10:05:00Z',
        registeredAt: '2026-03-10T14:20:00Z',
        walletLedger: [
          {
            id: 'tx-201',
            type: 'withdraw_demo',
            amountEtb: -60,
            description: 'Demo Payout Request (Telebirr)',
            reference: 'ADB-WDR-50112',
            timestamp: '2026-03-30 09:10',
            status: 'demo_pending',
          },
          {
            id: 'tx-202',
            type: 'referral_bonus',
            amountEtb: 15,
            description: 'Invitee Referral Demo Bonus',
            reference: 'ADB-REF-33019',
            timestamp: '2026-03-10 14:22',
            status: 'demo_completed',
          },
        ],
      },
      {
        uid: 'tg_6543210',
        telegramUserId: 6543210,
        displayName: 'Meron Tadesse',
        username: 'meron_et',
        role: 'player',
        accountStatus: 'active',
        phoneVerified: true,
        maskedPhone: '+25193****19',
        language: 'en',
        demoBalanceEtb: 340.0,
        gamesPlayed: 24,
        gamesWon: 6,
        referralCode: 'ADEY-6543210',
        referredByCode: 'ADEY-8842109',
        referralsCount: 2,
        lastActiveAt: '2026-03-30T09:50:00Z',
        registeredAt: '2026-03-12T11:30:00Z',
        walletLedger: [
          {
            id: 'tx-301',
            type: 'bingo_win',
            amountEtb: 120,
            description: 'Bingo Win Credit (Card #108 · Demo)',
            reference: 'ADB-WIN-88410',
            timestamp: '2026-03-29 21:00',
            status: 'demo_completed',
          },
        ],
      },
      {
        uid: 'tg_5109283',
        telegramUserId: 5109283,
        displayName: 'Yonas Kebede',
        username: 'yonas_bingo',
        role: 'player',
        accountStatus: 'suspended',
        suspensionReason: 'Duplicate multi-account phone verification attempt blocked',
        phoneVerified: false,
        maskedPhone: 'Unverified',
        language: 'am',
        demoBalanceEtb: 40.0,
        gamesPlayed: 3,
        gamesWon: 0,
        referralCode: 'ADEY-5109283',
        referralsCount: 0,
        lastActiveAt: '2026-03-25T16:10:00Z',
        registeredAt: '2026-03-24T12:00:00Z',
        walletLedger: [],
      },
    ];

    for (const u of seedUsers) {
      this.users.set(u.uid, u);
    }

    const seedPayouts: AdminPayoutOrder[] = [
      {
        requestId: 'PO-2026-901',
        uid: 'tg_7777777',
        userDisplayName: 'Dawit Mekonnen',
        telegramUserId: 7777777,
        requestedAmountEtb: 60.0,
        requestDate: '2026-03-30 09:10 UTC',
        paymentMethod: 'Telebirr (Demo)',
        destinationMasked: '+25192****81',
        status: 'Pending',
        reviewNotes: 'Awaiting initial admin verification (Demo Sandbox)',
        demoSandboxOnly: true,
        auditTrail: [
          {
            timestamp: '2026-03-30T09:10:00Z',
            fromStatus: 'Created',
            toStatus: 'Pending',
            reviewedBy: 'system_demo_queue',
            notes: 'Demo payout request submitted by player',
          },
        ],
      },
      {
        requestId: 'PO-2026-902',
        uid: 'tg_6543210',
        userDisplayName: 'Meron Tadesse',
        telegramUserId: 6543210,
        requestedAmountEtb: 120.0,
        requestDate: '2026-03-29 21:30 UTC',
        paymentMethod: 'CBE Birr (Demo)',
        destinationMasked: '+25193****19',
        status: 'Under Review',
        reviewNotes: 'Checking winning round #game_adey-main_live card #108',
        reviewedBy: 'Abebe Bikila (Lead Admin)',
        reviewedAt: '2026-03-29T22:00:00Z',
        demoSandboxOnly: true,
        auditTrail: [
          {
            timestamp: '2026-03-29T21:30:00Z',
            fromStatus: 'Created',
            toStatus: 'Pending',
            reviewedBy: 'system_demo_queue',
            notes: 'Demo payout request submitted by player',
          },
          {
            timestamp: '2026-03-29T22:00:00Z',
            fromStatus: 'Pending',
            toStatus: 'Under Review',
            reviewedBy: 'Abebe Bikila (Lead Admin)',
            notes: 'Checking winning round #game_adey-main_live card #108',
          },
        ],
      },
      {
        requestId: 'PO-2026-899',
        uid: 'tg_8842109',
        userDisplayName: 'Abebe Bikila',
        telegramUserId: 8842109,
        requestedAmountEtb: 50.0,
        requestDate: '2026-03-28 15:20 UTC',
        paymentMethod: 'Chapa Sandbox (Demo)',
        destinationMasked: '+25191****44',
        status: 'Completed',
        reviewNotes: 'Demo sandbox payout simulation completed',
        reviewedBy: 'Abebe Bikila (Lead Admin)',
        reviewedAt: '2026-03-28T16:00:00Z',
        demoSandboxOnly: true,
        auditTrail: [
          {
            timestamp: '2026-03-28T15:20:00Z',
            fromStatus: 'Created',
            toStatus: 'Pending',
            reviewedBy: 'system_demo_queue',
            notes: 'Demo payout request created',
          },
          {
            timestamp: '2026-03-28T15:45:00Z',
            fromStatus: 'Pending',
            toStatus: 'Approved',
            reviewedBy: 'Abebe Bikila (Lead Admin)',
            notes: 'Verified demo win ledger',
          },
          {
            timestamp: '2026-03-28T16:00:00Z',
            fromStatus: 'Approved',
            toStatus: 'Completed',
            reviewedBy: 'Abebe Bikila (Lead Admin)',
            notes: 'Demo sandbox payout simulation completed',
          },
        ],
      },
    ];

    for (const p of seedPayouts) {
      this.payouts.set(p.requestId, p);
    }

    const seedDeposits: AdminDepositRequest[] = [
      {
        depositId: 'DEP-2026-401',
        uid: 'tg_7777777',
        userDisplayName: 'Dawit Mekonnen',
        telegramUserId: 7777777,
        amountEtb: 100.0,
        requestDate: '2026-03-30 08:45 UTC',
        provider: 'Telebirr (Demo)',
        referenceCode: 'ADB-DEP-88219',
        status: 'Pending',
        reviewNotes: 'Demo deposit credit awaiting admin confirmation',
        demoSandboxOnly: true,
      },
      {
        depositId: 'DEP-2026-400',
        uid: 'tg_6543210',
        userDisplayName: 'Meron Tadesse',
        telegramUserId: 6543210,
        amountEtb: 200.0,
        requestDate: '2026-03-29 19:10 UTC',
        provider: 'CBE Birr (Demo)',
        referenceCode: 'ADB-DEP-64109',
        status: 'Approved',
        reviewNotes: 'Approved in Demo Sandbox mode',
        reviewedBy: 'Abebe Bikila (Lead Admin)',
        reviewedAt: '2026-03-29T19:25:00Z',
        demoSandboxOnly: true,
      },
    ];

    for (const d of seedDeposits) {
      this.deposits.set(d.depositId, d);
    }

    const seedRooms: AdminRoomConfigRecord[] = [
      {
        id: 'adey-main',
        nameAm: 'አደይ ዋና አዳራሽ',
        nameEn: 'Adey Main Hall',
        cardPriceEtb: 10,
        maxCardsPerRoom: 600,
        maxCardsPerPlayer: 4,
        lobbyCountdownSeconds: 60,
        minPlayers: 3,
        activePlayers: 42,
        status: 'live',
        updatedAt: '2026-03-30T08:00:00Z',
      },
      {
        id: 'adey-fast',
        nameAm: 'አደይ ፈጣን 30',
        nameEn: 'Adey Fast 30',
        cardPriceEtb: 10,
        maxCardsPerRoom: 600,
        maxCardsPerPlayer: 4,
        lobbyCountdownSeconds: 60,
        minPlayers: 3,
        activePlayers: 27,
        status: 'open',
        updatedAt: '2026-03-30T08:00:00Z',
      },
      {
        id: 'adey-vip',
        nameAm: 'አደይ ወርቃማ ክፍል',
        nameEn: 'Adey Gold Lounge',
        cardPriceEtb: 20,
        maxCardsPerRoom: 600,
        maxCardsPerPlayer: 4,
        lobbyCountdownSeconds: 60,
        minPlayers: 3,
        activePlayers: 19,
        status: 'starting',
        updatedAt: '2026-03-30T08:00:00Z',
      },
    ];

    for (const r of seedRooms) {
      this.rooms.set(r.id, r);
    }

    this.referrals = [
      {
        id: 'ref-1001',
        inviterUid: 'tg_8842109',
        inviterName: 'Abebe Bikila',
        inviterTelegramId: 8842109,
        inviteeUid: 'tg_7777777',
        inviteeName: 'Dawit Mekonnen',
        inviteeHandle: '@dawit_m',
        joinedAt: '2026-03-10 14:20 UTC',
        status: 'qualified',
        inviterBonusEtb: 20,
        inviteeBonusEtb: 15,
      },
      {
        id: 'ref-1002',
        inviterUid: 'tg_8842109',
        inviterName: 'Abebe Bikila',
        inviterTelegramId: 8842109,
        inviteeUid: 'tg_6543210',
        inviteeName: 'Meron Tadesse',
        inviteeHandle: '@meron_et',
        joinedAt: '2026-03-12 11:30 UTC',
        status: 'qualified',
        inviterBonusEtb: 20,
        inviteeBonusEtb: 15,
      },
    ];

    this.appendAuditRecord({
      adminActor: seedAdmin,
      action: 'PAYOUT_STATUS_REVIEWED',
      targetId: 'PO-2026-902',
      summary: 'Moved payout request PO-2026-902 to Under Review',
      previousValue: 'Pending',
      newValue: 'Under Review',
      notes: 'Checking winning round #game_adey-main_live card #108',
    });
  }

  /**
   * Syncs any newly registered bot players into the Admin User Registry without overwriting existing admin records.
   */
  private syncBotPlayers(): void {
    for (const bp of this.botEngine.getAllPlayers()) {
      const uid = bp.uid.startsWith('tg_') ? bp.uid : `tg_${bp.telegramUserId}`;
      const existing = this.users.get(uid);
      if (!existing) {
        this.users.set(uid, {
          uid,
          telegramUserId: bp.telegramUserId,
          displayName: `${bp.firstName} ${bp.lastName || ''}`.trim(),
          username: bp.username,
          role: AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(bp.telegramUserId) ? 'admin' : 'player',
          accountStatus: 'active',
          phoneVerified: bp.phoneVerified,
          maskedPhone: bp.verifiedPhoneMasked || 'Unverified',
          language: bp.language,
          demoBalanceEtb: bp.demoBalanceEtb,
          gamesPlayed: 1,
          gamesWon: 0,
          referralCode: bp.referralCode,
          referralsCount: 0,
          lastActiveAt: bp.updatedAt,
          registeredAt: bp.registeredAt,
          walletLedger: [],
        });
      } else {
        existing.language = bp.language;
        if (bp.phoneVerified && bp.verifiedPhoneMasked) {
          existing.phoneVerified = true;
          existing.maskedPhone = bp.verifiedPhoneMasked;
        }
      }
    }
  }

  public getOverviewMetrics() {
    this.syncBotPlayers();
    const allUsers = Array.from(this.users.values());
    const allPayouts = Array.from(this.payouts.values());
    const allDeposits = Array.from(this.deposits.values());
    const allRooms = Array.from(this.rooms.values());
    const botCfg = this.botEngine.getBotConfig();

    return {
      totalUsers: allUsers.length,
      activeUsers: allUsers.filter((u) => u.accountStatus === 'active').length,
      suspendedUsers: allUsers.filter((u) => u.accountStatus === 'suspended').length,
      verifiedPhoneUsers: allUsers.filter((u) => u.phoneVerified).length,
      payoutCounts: {
        total: allPayouts.length,
        Pending: allPayouts.filter((p) => p.status === 'Pending').length,
        'Under Review': allPayouts.filter((p) => p.status === 'Under Review').length,
        Approved: allPayouts.filter((p) => p.status === 'Approved').length,
        Rejected: allPayouts.filter((p) => p.status === 'Rejected').length,
        Completed: allPayouts.filter((p) => p.status === 'Completed').length,
      },
      depositCounts: {
        total: allDeposits.length,
        Pending: allDeposits.filter((d) => d.status === 'Pending').length,
        Approved: allDeposits.filter((d) => d.status === 'Approved').length,
        Rejected: allDeposits.filter((d) => d.status === 'Rejected').length,
      },
      activeRoomsCount: allRooms.length,
      totalOnlinePlayers: allRooms.reduce((acc, r) => acc + r.activePlayers, 0),
      totalReferrals: this.referrals.length,
      botStats: botCfg.stats,
      auditTrailEntries: this.auditChain.length,
      auditIntegrity: this.verifyAuditChainIntegrity(),
      mode: 'demo_sandbox',
    };
  }

  public searchUsers(query: string = ''): AdminManagedUserRecord[] {
    this.syncBotPlayers();
    const q = query.trim().toLowerCase();
    const list = Array.from(this.users.values());
    if (!q) return list;
    return list.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q) ||
        String(u.telegramUserId).includes(q) ||
        u.referralCode.toLowerCase().includes(q)
    );
  }

  public updateUserStatus(params: {
    uid: string;
    accountStatus: 'active' | 'suspended';
    reason: string;
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    reason?: string;
    user?: AdminManagedUserRecord;
    auditRecord?: AdminAuditRecord;
  } {
    this.syncBotPlayers();
    if (params.uid === params.adminActor.uid && params.accountStatus === 'suspended') {
      return { ok: false, reason: 'self_suspension_forbidden' };
    }
    const target = this.users.get(params.uid);
    if (!target) {
      return { ok: false, reason: 'user_not_found' };
    }
    const cleanReason = params.reason.trim() || 'Admin account status update';
    const prevStatus = target.accountStatus;
    target.accountStatus = params.accountStatus;
    target.suspensionReason =
      params.accountStatus === 'suspended' ? cleanReason : undefined;

    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'USER_STATUS_CHANGED',
      targetId: target.uid,
      summary: `Changed user ${target.displayName} (${target.uid}) status from ${prevStatus} to ${params.accountStatus}`,
      previousValue: prevStatus,
      newValue: params.accountStatus,
      notes: cleanReason,
    });

    return { ok: true, user: { ...target }, auditRecord };
  }

  /**
   * Explicitly blocks any attempt to grant or escalate roles via client requests.
   */
  public blockRoleEscalationAttempt(params: {
    actor: VerifiedSessionActor;
    targetUid: string;
    requestedRole: string;
  }): {
    ok: false;
    statusCode: 403;
    reason: 'self_role_escalation_forbidden';
    auditRecord: AdminAuditRecord;
  } {
    const auditRecord = this.appendAuditRecord({
      adminActor: params.actor,
      action: 'ROLE_ESCALATION_BLOCKED',
      targetId: params.targetUid,
      summary: `Blocked unauthorized role escalation attempt to '${params.requestedRole}' by ${params.actor.uid}`,
      previousValue: params.actor.role,
      newValue: params.requestedRole,
      notes: 'Admin roles are strictly controlled by server-side configuration.',
    });

    return {
      ok: false,
      statusCode: 403,
      reason: 'self_role_escalation_forbidden',
      auditRecord,
    };
  }

  public getPayoutOrders(statusFilter?: string): AdminPayoutOrder[] {
    const all = Array.from(this.payouts.values());
    if (!statusFilter || statusFilter === 'ALL') return all;
    return all.filter((p) => p.status === statusFilter);
  }

  public reviewPayoutOrder(params: {
    requestId: string;
    nextStatus: PayoutOrderStatus;
    reviewNotes: string;
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    reason?: 'payout_not_found' | 'invalid_status' | 'missing_review_notes' | 'already_finalized';
    payout?: AdminPayoutOrder;
    refundedBalanceEtb?: number;
    auditRecord?: AdminAuditRecord;
  } {
    const allowedStatuses: PayoutOrderStatus[] = [
      'Pending',
      'Under Review',
      'Approved',
      'Rejected',
      'Completed',
    ];
    if (!allowedStatuses.includes(params.nextStatus)) {
      return { ok: false, reason: 'invalid_status' };
    }

    const order = this.payouts.get(params.requestId);
    if (!order) {
      return { ok: false, reason: 'payout_not_found' };
    }

    const prevStatus = order.status;
    if (
      (prevStatus === 'Rejected' || prevStatus === 'Completed') &&
      prevStatus !== params.nextStatus
    ) {
      return { ok: false, reason: 'already_finalized' };
    }

    const cleanNotes =
      params.reviewNotes.trim() || `Status updated to ${params.nextStatus} (Demo Sandbox)`;
    const nowIso = new Date().toISOString();

    let refundedBalanceEtb: number | undefined;
    if (params.nextStatus === 'Rejected' && prevStatus !== 'Rejected') {
      this.syncBotPlayers();
      const targetUser = this.users.get(order.uid);
      if (targetUser) {
        targetUser.demoBalanceEtb = Math.min(
          100000,
          targetUser.demoBalanceEtb + order.requestedAmountEtb
        );
        refundedBalanceEtb = targetUser.demoBalanceEtb;
        targetUser.walletLedger.unshift({
          id: `tx_poref_${order.requestId}`,
          type: 'withdraw_demo',
          amountEtb: order.requestedAmountEtb,
          description: `Demo Payout Rejected Refund (${order.requestId})`,
          reference: `ADB-POREF-${order.requestId}`,
          timestamp: nowIso,
          status: 'demo_completed',
        });
      }
    }

    order.status = params.nextStatus;
    order.reviewNotes = cleanNotes;
    order.reviewedBy = params.adminActor.displayName;
    order.reviewedAt = nowIso;
    order.auditTrail.push({
      timestamp: nowIso,
      fromStatus: prevStatus,
      toStatus: params.nextStatus,
      reviewedBy: params.adminActor.displayName,
      notes: cleanNotes,
    });

    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'PAYOUT_STATUS_REVIEWED',
      targetId: order.requestId,
      summary: `Payout order ${order.requestId} (${order.requestedAmountEtb} ETB Demo) changed from ${prevStatus} to ${params.nextStatus}`,
      previousValue: prevStatus,
      newValue: params.nextStatus,
      notes: cleanNotes,
    });

    return {
      ok: true,
      payout: { ...order, auditTrail: [...order.auditTrail] },
      refundedBalanceEtb,
      auditRecord,
    };
  }

  public getDepositRequests(): AdminDepositRequest[] {
    return Array.from(this.deposits.values());
  }

  public reviewDepositRequest(params: {
    depositId: string;
    nextStatus: DepositRequestStatus;
    reviewNotes: string;
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    reason?: 'deposit_not_found' | 'invalid_status' | 'already_finalized';
    deposit?: AdminDepositRequest;
    creditedBalanceEtb?: number;
    auditRecord?: AdminAuditRecord;
  } {
    const allowed: DepositRequestStatus[] = ['Pending', 'Approved', 'Rejected'];
    if (!allowed.includes(params.nextStatus)) {
      return { ok: false, reason: 'invalid_status' };
    }
    const dep = this.deposits.get(params.depositId);
    if (!dep) {
      return { ok: false, reason: 'deposit_not_found' };
    }
    const prev = dep.status;
    if ((prev === 'Approved' || prev === 'Rejected') && prev !== params.nextStatus) {
      return { ok: false, reason: 'already_finalized' };
    }
    const nowIso = new Date().toISOString();
    const cleanNotes = params.reviewNotes.trim() || `Deposit ${params.nextStatus} (Demo Sandbox)`;

    let creditedBalanceEtb: number | undefined;
    if (params.nextStatus === 'Approved' && prev !== 'Approved') {
      this.syncBotPlayers();
      const targetUser = this.users.get(dep.uid);
      if (targetUser) {
        targetUser.demoBalanceEtb = Math.min(100000, targetUser.demoBalanceEtb + dep.amountEtb);
        creditedBalanceEtb = targetUser.demoBalanceEtb;
        targetUser.walletLedger.unshift({
          id: `tx_dep_${dep.depositId}`,
          type: 'deposit_demo',
          amountEtb: dep.amountEtb,
          description: `Approved ${dep.provider} Top-Up (${dep.depositId})`,
          reference: dep.referenceCode || `ADB-DEP-${dep.depositId}`,
          timestamp: nowIso,
          status: 'demo_completed',
        });
      }
    }

    dep.status = params.nextStatus;
    dep.reviewNotes = cleanNotes;
    dep.reviewedBy = params.adminActor.displayName;
    dep.reviewedAt = nowIso;

    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'DEPOSIT_STATUS_REVIEWED',
      targetId: dep.depositId,
      summary: `Demo deposit ${dep.depositId} (${dep.amountEtb} ETB) changed from ${prev} to ${params.nextStatus}`,
      previousValue: prev,
      newValue: params.nextStatus,
      notes: cleanNotes,
    });

    return { ok: true, deposit: { ...dep }, creditedBalanceEtb, auditRecord };
  }

  public getRooms(): AdminRoomConfigRecord[] {
    return Array.from(this.rooms.values());
  }

  public updateRoomConfig(params: {
    roomId: string;
    cardPriceEtb?: number;
    lobbyCountdownSeconds?: number;
    minPlayers?: number;
    status?: AdminRoomConfigRecord['status'];
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    reason?: 'room_not_found' | 'invalid_parameters';
    room?: AdminRoomConfigRecord;
    auditRecord?: AdminAuditRecord;
  } {
    const room = this.rooms.get(params.roomId);
    if (!room) {
      return { ok: false, reason: 'room_not_found' };
    }

    const prevSummary = `price=${room.cardPriceEtb},countdown=${room.lobbyCountdownSeconds},minPlayers=${room.minPlayers},status=${room.status}`;

    if (params.cardPriceEtb !== undefined) {
      if (params.cardPriceEtb < 1 || params.cardPriceEtb > 500) {
        return { ok: false, reason: 'invalid_parameters' };
      }
      room.cardPriceEtb = params.cardPriceEtb;
    }
    if (params.lobbyCountdownSeconds !== undefined) {
      if (params.lobbyCountdownSeconds < 10 || params.lobbyCountdownSeconds > 300) {
        return { ok: false, reason: 'invalid_parameters' };
      }
      room.lobbyCountdownSeconds = params.lobbyCountdownSeconds;
    }
    if (params.minPlayers !== undefined) {
      if (params.minPlayers < 2 || params.minPlayers > 50) {
        return { ok: false, reason: 'invalid_parameters' };
      }
      room.minPlayers = params.minPlayers;
    }
    if (params.status !== undefined) {
      room.status = params.status;
    }
    room.updatedAt = new Date().toISOString();

    const nextSummary = `price=${room.cardPriceEtb},countdown=${room.lobbyCountdownSeconds},minPlayers=${room.minPlayers},status=${room.status}`;
    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'ROOM_CONFIG_UPDATED',
      targetId: room.id,
      summary: `Updated room ${room.nameEn} (${room.id}) parameters`,
      previousValue: prevSummary,
      newValue: nextSummary,
    });

    return { ok: true, room: { ...room }, auditRecord };
  }

  public getReferrals(): AdminReferralRecord[] {
    return [...this.referrals];
  }

  public getBotManagementState(): BotAdminConfig {
    return this.botEngine.getBotConfig();
  }

  public updateBotManagementConfig(params: {
    miniAppUrl?: string;
    customWelcomeAm?: string | null;
    customWelcomeEn?: string | null;
    buttonLabels?: Partial<BotButtonLabelsConfig>;
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    config: BotAdminConfig;
    auditRecord: AdminAuditRecord;
  } {
    const prev = this.botEngine.getBotConfig();
    const updated = this.botEngine.updateBotConfig(
      {
        miniAppUrl: params.miniAppUrl,
        customWelcomeAm: params.customWelcomeAm,
        customWelcomeEn: params.customWelcomeEn,
        buttonLabels: params.buttonLabels,
      },
      params.adminActor.displayName
    );

    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'BOT_CONFIG_UPDATED',
      targetId: 'telegram_bot_config',
      summary: `Updated Telegram bot welcome message & button configuration`,
      previousValue: `url=${prev.miniAppUrl},welcomeAm=${prev.customWelcomeAm ? 'custom' : 'default'}`,
      newValue: `url=${updated.miniAppUrl},welcomeAm=${updated.customWelcomeAm ? 'custom' : 'default'}`,
    });

    return { ok: true, config: updated, auditRecord };
  }

  public sendBotAnnouncement(params: {
    titleAm: string;
    titleEn: string;
    bodyAm: string;
    bodyEn: string;
    targetAudience?: 'all_players' | 'verified_players';
    adminActor: VerifiedSessionActor;
  }): {
    ok: boolean;
    reason?: 'empty_announcement';
    announcement?: BotAnnouncementRecord;
    auditRecord?: AdminAuditRecord;
  } {
    if (!params.bodyAm.trim() && !params.bodyEn.trim()) {
      return { ok: false, reason: 'empty_announcement' };
    }
    const announcement = this.botEngine.sendAnnouncement(
      {
        titleAm: params.titleAm,
        titleEn: params.titleEn,
        bodyAm: params.bodyAm || params.bodyEn,
        bodyEn: params.bodyEn || params.bodyAm,
        targetAudience: params.targetAudience,
      },
      params.adminActor.displayName
    );

    const auditRecord = this.appendAuditRecord({
      adminActor: params.adminActor,
      action: 'BOT_ANNOUNCEMENT_SENT',
      targetId: announcement.id,
      summary: `Sent Telegram bot announcement '${announcement.titleEn}' to ${announcement.recipientCount} player(s)`,
      newValue: announcement.targetAudience,
      notes: announcement.bodyEn.slice(0, 120),
    });

    return { ok: true, announcement, auditRecord };
  }

  public getAuditTrail(): AdminAuditRecord[] {
    return [...this.auditChain].reverse();
  }

  public getAdminSettings() {
    return {
      authorizedAdminTelegramIds: [...AUTHORIZED_ADMIN_TELEGRAM_IDS],
      authorizedAdminEmails: [...AUTHORIZED_ADMIN_EMAILS],
      securityPolicies: {
        requireServerSideRoleVerification: true,
        trustFrontendLocalStorageRole: false,
        allowSelfRoleEscalation: false,
        isolatePhoneContactInPrivateSubcollection: true,
        realMoneyPaymentsDisabled: true,
        auditTrailHashAlgorithm: 'SHA-256',
      },
      auditChainIntegrity: this.verifyAuditChainIntegrity(),
      auditTrail: this.getAuditTrail(),
    };
  }
}
