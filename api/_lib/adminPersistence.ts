import crypto from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  calculateAuthoritativeGameFinancials,
  resolveGameLifecycleStage,
} from '../../src/game/rules.ts';
import { AUTHORITATIVE_PRODUCTION_ROOMS } from '../../src/game/roomCatalog.ts';
import type { GameLifecycleStage, Language } from '../../src/types/bingo.ts';
import type {
  AdminAuditRecord,
  AdminDepositRequest,
  AdminFinancialDashboardMetrics,
  AdminLiveActivityItem,
  AdminManagedUserRecord,
  AdminPayoutOrder,
  AdminReferralRecord,
  AdminRoomConfigRecord,
  AdminUserWalletEntry,
  DepositRequestStatus,
  PayoutOrderStatus,
  VerifiedSessionActor,
} from '../../src/utils/adminAuthority.ts';
import {
  AUTHORIZED_ADMIN_EMAILS,
  AUTHORIZED_ADMIN_TELEGRAM_IDS,
} from '../../src/utils/adminAuthority.ts';
import {
  type BotAdminConfig,
  type BotAnnouncementRecord,
  type BotButtonLabelsConfig,
  type BotNotificationMessage,
  DEFAULT_BOT_BUTTON_LABELS,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  isDisallowedMiniAppPreviewUrl,
  sanitizeProductionMiniAppUrl,
} from '../../src/utils/telegramBot.ts';

export const ADMIN_AUDIT_LOGS_COLLECTION = 'adminAuditLogs';
export const ADMIN_AUDIT_META_COLLECTION = 'adminAuditMeta';
export const PAYOUT_REQUESTS_COLLECTION = 'payoutRequests';
export const DEPOSIT_REQUESTS_COLLECTION = 'depositRequests';
export const BOT_CONFIG_COLLECTION = 'botConfig';
export const BOT_ANNOUNCEMENTS_COLLECTION = 'botAnnouncements';
export const BOT_OUTBOX_COLLECTION = 'botOutbox';

function computeAuditEntryHash(payload: {
  sequence: number;
  timestamp: string;
  adminUid: string;
  action: string;
  targetId: string;
  summary: string;
  previousValue?: string;
  newValue?: string;
  notes?: string;
  prevHash: string;
}): string {
  const canonical = [
    String(payload.sequence),
    payload.timestamp,
    payload.adminUid,
    payload.action,
    payload.targetId,
    payload.summary,
    payload.previousValue ?? '',
    payload.newValue ?? '',
    payload.notes ?? '',
    payload.prevHash,
  ].join('|');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function mapRoomStatusToAdminStatus(
  rawStatus: string
): AdminRoomConfigRecord['status'] {
  if (rawStatus === 'live') return 'live';
  if (rawStatus === 'starting' || rawStatus === 'countdown') return 'starting';
  if (rawStatus === 'maintenance') return 'maintenance';
  return 'open';
}

function mapAdminStatusToRoomStatus(
  status: AdminRoomConfigRecord['status']
): 'waiting' | 'countdown' | 'live' | 'completed' {
  if (status === 'live') return 'live';
  if (status === 'starting') return 'countdown';
  return 'waiting';
}

export class PersistentAdminService {
  private readonly db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  /**
   * Idempotently ensures canonical production room documents and default bot configuration exist
   * in Firestore without EVER overwriting existing production documents or injecting fake players,
   * fake payments, fake payouts, fake referrals, or fake audit records.
   */
  public async ensureSeedData(): Promise<void> {
    const roomsCol = this.db.collection('rooms');
    const botConfigRef = this.db.collection(BOT_CONFIG_COLLECTION).doc('default');
    const nowIso = new Date().toISOString();

    for (const def of AUTHORITATIVE_PRODUCTION_ROOMS) {
      const rRef = roomsCol.doc(def.id);
      const snap = await rRef.get();
      if (!snap.exists) {
        await rRef.set({
          roomId: def.id,
          id: def.id,
          nameAm: def.nameAm,
          nameEn: def.nameEn,
          cardPrice: def.cardPrice,
          cardPriceEtb: def.cardPrice,
          maxPlayersPerRoom: def.maxPlayersPerRoom,
          maxCardsPerRoom: def.maxCardsPerRoom,
          maxCardsPerPlayer: def.maxCardsPerPlayer,
          minPlayers: def.minPlayers,
          countdownSeconds: def.countdownSeconds,
          lobbyCountdownSeconds: def.countdownSeconds,
          activePlayersCount: 0,
          activePlayers: 0,
          confirmedPlayersCount: 0,
          verifiedPaidEntriesCount: 0,
          availableSpaces: def.maxPlayersPerRoom,
          reservedCardsCount: 0,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          roundNumber: 1,
          roundStartedAtMs: 0,
          registrationDeadlineMs: 0,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          extendedRegistrationCount: 0,
          scheduleNoticeAm: '',
          scheduleNoticeEn: '',
          adminStatus: 'open',
          status: 'countdown',
          lifecycleStage: 'WAITING',
          currentGameId: `game_${def.id}_live`,
          updatedAt: nowIso,
        });
      }
    }

    const botCfgSnap = await botConfigRef.get();
    if (!botCfgSnap.exists) {
      await botConfigRef.set({
        miniAppUrl: DEFAULT_DEPLOYED_MINI_APP_URL,
        customWelcomeAm: null,
        customWelcomeEn: null,
        buttonLabels: { ...DEFAULT_BOT_BUTTON_LABELS },
        stats: {
          totalUpdatesProcessed: 0,
          callbacksHandled: 0,
          duplicateCallbacksBlocked: 0,
          announcementsSent: 0,
        },
        updatedAt: nowIso,
        updatedBy: 'system_init',
      });
    } else if (isDisallowedMiniAppPreviewUrl(String(botCfgSnap.get('miniAppUrl') || ''))) {
      await botConfigRef.set(
        {
          miniAppUrl: DEFAULT_DEPLOYED_MINI_APP_URL,
          updatedAt: nowIso,
          updatedBy: 'system_url_heal',
        },
        { merge: true }
      );
    }
  }

  /**
   * Helper to build an append-only SHA-256 hash-chained audit record inside a Firestore transaction.
   * Requires `chainSnap` to have been read BEFORE any transaction writes!
   */
  private buildAuditRecordFromChainSnap(
    chainSnap: { exists: boolean; get: (field: string) => unknown },
    params: {
      adminActor: VerifiedSessionActor;
      action: AdminAuditRecord['action'];
      targetId: string;
      summary: string;
      previousValue?: string;
      newValue?: string;
      notes?: string;
    }
  ): { auditRecord: AdminAuditRecord; nextSequence: number; nextHash: string } {
    const prevSeq = chainSnap.exists ? Number(chainSnap.get('sequence') ?? 0) : 0;
    const prevHash =
      chainSnap.exists && typeof chainSnap.get('lastHash') === 'string'
        ? String(chainSnap.get('lastHash'))
        : 'GENESIS_ADEYBINGO_AUDIT_CHAIN_V1';

    const sequence = prevSeq + 1;
    const timestamp = new Date().toISOString();
    const entryHash = computeAuditEntryHash({
      sequence,
      timestamp,
      adminUid: params.adminActor.uid,
      action: params.action,
      targetId: params.targetId,
      summary: params.summary,
      previousValue: params.previousValue,
      newValue: params.newValue,
      notes: params.notes,
      prevHash,
    });

    const auditRecord: AdminAuditRecord = {
      id: `AUD-${String(sequence).padStart(4, '0')}`,
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
    };

    return { auditRecord, nextSequence: sequence, nextHash: entryHash };
  }

  private writeAuditRecordToTx(
    tx: Transaction,
    built: { auditRecord: AdminAuditRecord; nextSequence: number; nextHash: string }
  ): void {
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');
    const auditRef = this.db
      .collection(ADMIN_AUDIT_LOGS_COLLECTION)
      .doc(built.auditRecord.id);

    tx.set(auditRef, built.auditRecord);
    tx.set(chainRef, {
      sequence: built.nextSequence,
      lastHash: built.nextHash,
      updatedAt: built.auditRecord.timestamp,
    });
  }

  public async verifyAuditChainIntegrity(): Promise<{
    valid: boolean;
    checkedCount: number;
    totalEntries: number;
  }> {
    await this.ensureSeedData();
    const snap = await this.db
      .collection(ADMIN_AUDIT_LOGS_COLLECTION)
      .orderBy('sequence', 'asc')
      .get();

    const records = snap.docs
      .map((d) => d.data() as AdminAuditRecord)
      .sort((a, b) => a.sequence - b.sequence);

    let expectedPrev = 'GENESIS_ADEYBINGO_AUDIT_CHAIN_V1';
    for (const record of records) {
      if (record.prevHash !== expectedPrev) {
        return { valid: false, checkedCount: records.length, totalEntries: records.length };
      }
      const recomputed = computeAuditEntryHash({
        sequence: record.sequence,
        timestamp: record.timestamp,
        adminUid: record.adminUid,
        action: record.action,
        targetId: record.targetId,
        summary: record.summary,
        previousValue: record.previousValue,
        newValue: record.newValue,
        notes: record.notes,
        prevHash: record.prevHash,
      });
      if (recomputed !== record.entryHash) {
        return { valid: false, checkedCount: records.length, totalEntries: records.length };
      }
      expectedPrev = record.entryHash;
    }

    return { valid: true, checkedCount: records.length, totalEntries: records.length };
  }

  public async getAuditTrail(): Promise<AdminAuditRecord[]> {
    await this.ensureSeedData();
    const snap = await this.db
      .collection(ADMIN_AUDIT_LOGS_COLLECTION)
      .orderBy('sequence', 'desc')
      .get();
    return snap.docs
      .map((d) => d.data() as AdminAuditRecord)
      .sort((a, b) => b.sequence - a.sequence);
  }

  private async loadMergedUsers(): Promise<AdminManagedUserRecord[]> {
    await this.ensureSeedData();
    const [usersSnap, botPlayersSnap, txSnap, refSnap, gamesSnap, roomsSnap] = await Promise.all([
      this.db.collection('users').get(),
      this.db.collection('botPlayers').get(),
      this.db.collection('transactions').get(),
      this.db.collection('referrals').get(),
      this.db.collection('games').get(),
      this.db.collection('rooms').get(),
    ]);

    const activeRoomCardsByUid = new Map<string, Array<{ roomId: string; cardIds: number[] }>>();
    const roomPlayerSnaps = await Promise.all(
      roomsSnap.docs.map(async (roomDoc) => ({
        roomId: roomDoc.id,
        playersSnap: await this.db.collection('rooms').doc(roomDoc.id).collection('players').get(),
      }))
    );
    for (const { roomId, playersSnap } of roomPlayerSnaps) {
      for (const pDoc of playersSnap.docs) {
        const pData = pDoc.data() || {};
        const uid = String(pData.playerId || pDoc.id);
        const cardIds = Array.isArray(pData.cardIds)
          ? (pData.cardIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 600)
          : [];
        if (cardIds.length === 0) continue;
        const list = activeRoomCardsByUid.get(uid) || [];
        list.push({ roomId, cardIds: cardIds.sort((a, b) => a - b) });
        activeRoomCardsByUid.set(uid, list);
      }
    }

    const referralCountByInviter = new Map<string, number>();
    for (const rDoc of refSnap.docs) {
      const rData = rDoc.data() || {};
      const inviterUid = String(rData.inviterUid || '');
      if (!inviterUid) continue;
      referralCountByInviter.set(inviterUid, (referralCountByInviter.get(inviterUid) || 0) + 1);
    }

    const winsByUid = new Map<
      string,
      Array<{ gameId: string; roomId: string; cardIds: number[]; prizeEtb: number; completedAt: string }>
    >();
    for (const gDoc of gamesSnap.docs) {
      const gData = gDoc.data() || {};
      if (String(gData.status || '') !== 'completed') continue;
      const gameId = String(gData.gameId || gDoc.id);
      const roomId = String(gData.roomId || 'adey-main');
      const completedAt = String(gData.completedAt || '');
      const winnersArr = Array.isArray(gData.winners)
        ? (gData.winners as Array<Record<string, unknown>>)
        : [];
      if (winnersArr.length > 0) {
        const grouped = new Map<string, { cardIds: number[]; prizeEtb: number }>();
        for (const w of winnersArr) {
          const wUid = String(w.uid || '');
          if (!wUid) continue;
          const entry = grouped.get(wUid) || { cardIds: [], prizeEtb: 0 };
          const cid = Number(w.cardId ?? 0);
          if (Number.isInteger(cid) && cid > 0) entry.cardIds.push(cid);
          entry.prizeEtb = Number((entry.prizeEtb + Number(w.prizeEtb ?? 0)).toFixed(2));
          grouped.set(wUid, entry);
        }
        for (const [wUid, entry] of grouped.entries()) {
          const list = winsByUid.get(wUid) || [];
          list.push({ gameId, roomId, cardIds: entry.cardIds, prizeEtb: entry.prizeEtb, completedAt });
          winsByUid.set(wUid, list);
        }
      } else if (typeof gData.winnerUid === 'string' && gData.winnerUid) {
        const wUid = gData.winnerUid;
        const cid = Number(gData.winningCardId ?? 0);
        const list = winsByUid.get(wUid) || [];
        list.push({
          gameId,
          roomId,
          cardIds: cid > 0 ? [cid] : [],
          prizeEtb: Number(gData.demoPrizeEtb ?? gData.winnersPrizePoolEtb ?? 0),
          completedAt,
        });
        winsByUid.set(wUid, list);
      }
    }

    const txByUser = new Map<string, AdminUserWalletEntry[]>();
    for (const d of txSnap.docs) {
      const data = d.data() || {};
      const uid = String(data.userId || '');
      if (!uid) continue;
      const list = txByUser.get(uid) || [];
      const rawCreatedAt = data.createdAt;
      const timestamp =
        typeof rawCreatedAt === 'string'
          ? rawCreatedAt
          : rawCreatedAt && typeof (rawCreatedAt as { toDate?: () => Date }).toDate === 'function'
            ? (rawCreatedAt as { toDate: () => Date }).toDate().toISOString()
            : rawCreatedAt instanceof Date
              ? rawCreatedAt.toISOString()
              : new Date().toISOString();

      list.push({
        id: String(data.transactionId || d.id),
        type: (data.type || 'card_entry') as AdminUserWalletEntry['type'],
        amountEtb: Number(data.amountEtb ?? 0),
        description: String(data.description || ''),
        reference: String(data.reference || d.id),
        timestamp,
        status: String(data.status || 'demo_completed'),
      });
      txByUser.set(uid, list);
    }

    const userMap = new Map<string, AdminManagedUserRecord>();

    for (const doc of usersSnap.docs) {
      const data = doc.data() || {};
      const uid = String(data.uid || doc.id);
      const rawTg = data.telegramUserId;
      const telegramUserId =
        typeof rawTg === 'number'
          ? rawTg
          : typeof rawTg === 'string' && rawTg.startsWith('tg_')
            ? Number(rawTg.slice(3)) || 0
            : uid.startsWith('tg_')
              ? Number(uid.slice(3)) || 0
              : 0;

      const cleanUsername = String(data.username || uid).replace(/^@/, '');
      const existingLedger: AdminUserWalletEntry[] = Array.isArray(data.walletLedger)
        ? (data.walletLedger as AdminUserWalletEntry[])
        : [];
      const liveTx = txByUser.get(uid) || [];
      const combinedLedger = [...liveTx, ...existingLedger].slice(0, 20);
      const userWins = winsByUid.get(uid) || [];
      const activeRoomCards = activeRoomCardsByUid.get(uid) || [];
      const actualReferralsCount = Math.max(
        Number(data.referralsCount ?? 0),
        referralCountByInviter.get(uid) || 0
      );

      userMap.set(uid, {
        uid,
        telegramUserId,
        displayName: String(data.displayName || 'Adey Player'),
        username: cleanUsername,
        role:
          data.role === 'admin' || AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(telegramUserId)
            ? 'admin'
            : 'player',
        accountStatus: data.accountStatus === 'suspended' ? 'suspended' : 'active',
        suspensionReason:
          typeof data.suspensionReason === 'string' ? data.suspensionReason : undefined,
        phoneVerified: Boolean(data.phoneVerified),
        maskedPhone:
          typeof data.maskedPhone === 'string' && data.maskedPhone
            ? data.maskedPhone
            : data.phoneVerified
              ? '+2519****'
              : 'Unverified',
        language: (data.language === 'en' ? 'en' : 'am') as Language,
        demoBalanceEtb: Number(data.demoBalanceEtb ?? 0),
        gamesPlayed: Number(data.gamesPlayed ?? liveTx.filter((t) => t.type === 'card_entry').length),
        gamesWon: Math.max(
          Number(data.gamesWon ?? 0),
          liveTx.filter((t) => t.type === 'bingo_win').length,
          userWins.length
        ),
        referralCode: String(data.referralCode || `ADEY-${telegramUserId || uid}`),
        referredByCode:
          typeof data.referredByCode === 'string' ? data.referredByCode : undefined,
        referralsCount: actualReferralsCount,
        lastActiveAt: String(data.lastActiveAt || new Date().toISOString()),
        registeredAt: String(data.registeredAt || new Date().toISOString()),
        walletLedger: combinedLedger,
        activeRoomCards,
        recentWins: userWins.slice(0, 10),
      });
    }

    for (const bpDoc of botPlayersSnap.docs) {
      const bp = bpDoc.data() || {};
      const tgId = Number(bp.telegramUserId || bpDoc.id);
      if (!Number.isInteger(tgId) || tgId <= 0) continue;
      const uid = String(bp.uid || `tg_${tgId}`);
      const existing = userMap.get(uid);
      if (!existing) {
        const userWins = winsByUid.get(uid) || [];
        userMap.set(uid, {
          uid,
          telegramUserId: tgId,
          displayName: `${String(bp.firstName || 'Player')} ${String(bp.lastName || '')}`.trim(),
          username: String(bp.username || uid).replace(/^@/, ''),
          role: AUTHORIZED_ADMIN_TELEGRAM_IDS.includes(tgId) ? 'admin' : 'player',
          accountStatus: 'active',
          phoneVerified: Boolean(bp.phoneVerified),
          maskedPhone: String(bp.verifiedPhoneMasked || 'Unverified'),
          language: (bp.language === 'en' ? 'en' : 'am') as Language,
          demoBalanceEtb: Number(bp.demoBalanceEtb ?? 0),
          gamesPlayed: (txByUser.get(uid) || []).filter((t) => t.type === 'card_entry').length,
          gamesWon: userWins.length,
          referralCode: String(bp.referralCode || `ADEY-${tgId}`),
          referredByCode:
            typeof bp.referredByCode === 'string' ? bp.referredByCode : undefined,
          referralsCount: referralCountByInviter.get(uid) || 0,
          lastActiveAt: String(bp.updatedAt || new Date().toISOString()),
          registeredAt: String(bp.registeredAt || new Date().toISOString()),
          walletLedger: txByUser.get(uid) || [],
          activeRoomCards: activeRoomCardsByUid.get(uid) || [],
          recentWins: userWins.slice(0, 10),
        });
      } else {
        if (bp.phoneVerified && typeof bp.verifiedPhoneMasked === 'string') {
          existing.phoneVerified = true;
          existing.maskedPhone = bp.verifiedPhoneMasked;
        }
        if (bp.language === 'am' || bp.language === 'en') {
          existing.language = bp.language;
        }
        if (!existing.referredByCode && typeof bp.referredByCode === 'string') {
          existing.referredByCode = bp.referredByCode;
        }
      }
    }

    return Array.from(userMap.values());
  }

  public async searchUsers(query: string = ''): Promise<AdminManagedUserRecord[]> {
    const all = await this.loadMergedUsers();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q) ||
        String(u.telegramUserId).includes(q) ||
        u.referralCode.toLowerCase().includes(q)
    );
  }

  public async updateUserStatus(params: {
    uid: string;
    accountStatus: 'active' | 'suspended';
    reason: string;
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'user_not_found' | 'self_suspension_forbidden' | 'invalid_status';
    user?: AdminManagedUserRecord;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    if (params.accountStatus !== 'active' && params.accountStatus !== 'suspended') {
      return { ok: false, reason: 'invalid_status' };
    }
    if (params.uid === params.adminActor.uid && params.accountStatus === 'suspended') {
      return { ok: false, reason: 'self_suspension_forbidden' };
    }

    const userRef = this.db.collection('users').doc(params.uid);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    const txRes = await this.db.runTransaction(async (tx) => {
      const [userSnap, chainSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(chainRef),
      ]);

      if (!userSnap.exists) {
        return { ok: false as const, reason: 'user_not_found' as const };
      }

      const data = userSnap.data() || {};
      const prevStatus = data.accountStatus === 'suspended' ? 'suspended' : 'active';
      const cleanReason = params.reason.trim() || 'Admin account status update';
      const displayName = String(data.displayName || params.uid);

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'USER_STATUS_CHANGED',
        targetId: params.uid,
        summary: `Changed user ${displayName} (${params.uid}) status from ${prevStatus} to ${params.accountStatus}`,
        previousValue: prevStatus,
        newValue: params.accountStatus,
        notes: cleanReason,
      });

      tx.update(userRef, {
        accountStatus: params.accountStatus,
        suspensionReason: params.accountStatus === 'suspended' ? cleanReason : '',
        updatedAt: FieldValue.serverTimestamp(),
      });

      this.writeAuditRecordToTx(tx, builtAudit);

      return {
        ok: true as const,
        auditRecord: builtAudit.auditRecord,
      };
    });

    if (!txRes.ok) {
      return txRes;
    }

    const updatedList = await this.searchUsers(params.uid);
    const updatedUser = updatedList.find((u) => u.uid === params.uid);

    return {
      ok: true,
      user: updatedUser,
      auditRecord: txRes.auditRecord,
    };
  }

  public async adjustUserWallet(params: {
    uid: string;
    operation: 'credit' | 'debit';
    amountEtb: number;
    reason: string;
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'user_not_found' | 'invalid_amount' | 'insufficient_balance';
    user?: AdminManagedUserRecord;
    updatedBalanceEtb?: number;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    const amount = Number(params.amountEtb);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50000) {
      return { ok: false, reason: 'invalid_amount' };
    }

    const userRef = this.db.collection('users').doc(params.uid);
    const tgMatch = /^tg_([1-9]\d*)$/.exec(params.uid);
    const tgId = tgMatch ? Number(tgMatch[1]) : 0;
    const botPlayerRef = tgId > 0 ? this.db.collection('botPlayers').doc(String(tgId)) : null;
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');
    const transactionsCol = this.db.collection('transactions');

    const txRes = await this.db.runTransaction(async (tx) => {
      const [userSnap, botPlayerSnap, chainSnap] = await Promise.all([
        tx.get(userRef),
        botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
        tx.get(chainRef),
      ]);

      if (!userSnap.exists && !botPlayerSnap?.exists) {
        return { ok: false as const, reason: 'user_not_found' as const };
      }

      const currentBal = userSnap.exists
        ? Number(userSnap.get('demoBalanceEtb') ?? 0)
        : Number(botPlayerSnap?.get('demoBalanceEtb') ?? 0);

      if (params.operation === 'debit' && amount > currentBal) {
        return { ok: false as const, reason: 'insufficient_balance' as const };
      }

      const delta = params.operation === 'credit' ? amount : -amount;
      const nextBal = Math.min(1_000_000, Math.max(0, Number((currentBal + delta).toFixed(2))));
      const nowIso = new Date().toISOString();
      const cleanReason =
        params.reason.trim() ||
        (params.operation === 'credit'
          ? 'Admin Sandbox Wallet Credit'
          : 'Admin Sandbox Wallet Debit');

      if (userSnap.exists) {
        tx.update(userRef, {
          demoBalanceEtb: nextBal,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (botPlayerRef && botPlayerSnap?.exists) {
        tx.update(botPlayerRef, {
          demoBalanceEtb: nextBal,
          updatedAt: nowIso,
        });
      }

      const txId = `tx_adj_${params.uid}_${Date.now()}`;
      tx.set(transactionsCol.doc(txId), {
        transactionId: txId,
        userId: params.uid,
        type: params.operation === 'credit' ? 'deposit_demo' : 'withdraw_demo',
        amountEtb: delta,
        balanceBeforeEtb: currentBal,
        balanceAfterEtb: nextBal,
        status: 'demo_completed',
        description: `Admin ${params.operation === 'credit' ? 'Credit' : 'Debit'}: ${cleanReason}`.slice(0, 160),
        reference: `ADB-ADJ-${Date.now().toString(36).toUpperCase()}`,
        relatedId: params.uid,
        idempotencyKey: txId,
        createdAt: nowIso,
      });

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'WALLET_BALANCE_ADJUSTED',
        targetId: params.uid,
        summary: `Admin ${params.operation} ${amount} ETB for ${params.uid} (${currentBal} -> ${nextBal} ETB)`,
        previousValue: String(currentBal),
        newValue: String(nextBal),
        notes: cleanReason,
      });

      this.writeAuditRecordToTx(tx, builtAudit);
      return {
        ok: true as const,
        updatedBalanceEtb: nextBal,
        auditRecord: builtAudit.auditRecord,
      };
    });

    if (!txRes.ok) {
      return txRes;
    }

    const updatedList = await this.searchUsers(params.uid);
    const updatedUser = updatedList.find((u) => u.uid === params.uid);
    return {
      ok: true,
      user: updatedUser,
      updatedBalanceEtb: txRes.updatedBalanceEtb,
      auditRecord: txRes.auditRecord,
    };
  }

  public async blockRoleEscalationAttempt(params: {
    actor: VerifiedSessionActor;
    targetUid: string;
    requestedRole: string;
  }): Promise<{
    ok: false;
    statusCode: 403;
    reason: 'self_role_escalation_forbidden';
    auditRecord: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    const auditRecord = await this.db.runTransaction(async (tx) => {
      const chainSnap = await tx.get(chainRef);
      const built = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.actor,
        action: 'ROLE_ESCALATION_BLOCKED',
        targetId: params.targetUid,
        summary: `Blocked unauthorized role escalation attempt to '${params.requestedRole}' by ${params.actor.uid}`,
        previousValue: params.actor.role,
        newValue: params.requestedRole,
        notes: 'Admin roles are strictly controlled by server-side configuration.',
      });
      this.writeAuditRecordToTx(tx, built);
      return built.auditRecord;
    });

    return {
      ok: false,
      statusCode: 403,
      reason: 'self_role_escalation_forbidden',
      auditRecord,
    };
  }

  public async getPayoutOrders(statusFilter?: string): Promise<AdminPayoutOrder[]> {
    await this.ensureSeedData();
    const snap = await this.db.collection(PAYOUT_REQUESTS_COLLECTION).get();
    const all = snap.docs.map((d) => d.data() as AdminPayoutOrder);
    if (!statusFilter || statusFilter === 'ALL') return all;
    return all.filter((p) => p.status === statusFilter);
  }

  /**
   * Reviews a payout request atomically inside a Firestore transaction.
   * When a payout is rejected (transitioning from non-Rejected to Rejected), refunds the player's
   * Demo balance in `users/{uid}` and records a `withdraw_demo` refund ledger entry in `transactions`.
   */
  public async reviewPayoutOrder(params: {
    requestId: string;
    nextStatus: PayoutOrderStatus;
    reviewNotes: string;
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'payout_not_found' | 'invalid_status' | 'already_finalized' | 'invalid_transition';
    payout?: AdminPayoutOrder;
    refundedBalanceEtb?: number;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
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

    const payoutRef = this.db.collection(PAYOUT_REQUESTS_COLLECTION).doc(params.requestId);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');
    const transactionsCol = this.db.collection('transactions');

    return await this.db.runTransaction(async (tx) => {
      // 1. Read payout and chain first
      const [payoutSnap, chainSnap] = await Promise.all([
        tx.get(payoutRef),
        tx.get(chainRef),
      ]);

      if (!payoutSnap.exists) {
        return { ok: false, reason: 'payout_not_found' as const };
      }

      const order = payoutSnap.data() as AdminPayoutOrder;
      const userRef = this.db.collection('users').doc(order.uid);
      const orderTgMatch = /^tg_([1-9]\d*)$/.exec(order.uid);
      const orderTgId = Number(order.telegramUserId || (orderTgMatch ? Number(orderTgMatch[1]) : 0));
      const botPlayerRef =
        orderTgId > 0 ? this.db.collection('botPlayers').doc(String(orderTgId)) : null;
      const [userSnap, botPlayerSnap] = await Promise.all([
        tx.get(userRef),
        botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
      ]);

      const prevStatus = order.status;
      if (prevStatus === 'Rejected' || prevStatus === 'Completed') {
        return { ok: false, reason: 'already_finalized' as const };
      }

      const allowedNextByPrev: Record<string, PayoutOrderStatus[]> = {
        Pending: ['Under Review', 'Approved', 'Rejected'],
        'Under Review': ['Approved', 'Rejected'],
        Approved: ['Completed', 'Rejected'],
      };
      const validNext = allowedNextByPrev[prevStatus] || [];
      if (!validNext.includes(params.nextStatus)) {
        return { ok: false, reason: 'invalid_transition' as const };
      }

      const cleanNotes =
        params.reviewNotes.trim() || `Status updated to ${params.nextStatus} (Demo Sandbox)`;
      const nowIso = new Date().toISOString();

      const updatedAuditTrail = Array.isArray(order.auditTrail)
        ? [...order.auditTrail]
        : [];
      updatedAuditTrail.push({
        timestamp: nowIso,
        fromStatus: prevStatus,
        toStatus: params.nextStatus,
        reviewedBy: params.adminActor.displayName,
        notes: cleanNotes,
      });

      const updatedOrder: AdminPayoutOrder = {
        ...order,
        status: params.nextStatus,
        reviewNotes: cleanNotes,
        reviewedBy: params.adminActor.displayName,
        reviewedAt: nowIso,
        demoSandboxOnly: true,
        auditTrail: updatedAuditTrail,
      };

      let refundedBalanceEtb: number | undefined;

      // If transitioning to Rejected from a non-Rejected state, atomically refund the player's Demo balance
      if (params.nextStatus === 'Rejected') {
        const currentBalance = userSnap.exists
          ? Number(userSnap.get('demoBalanceEtb') ?? 0)
          : botPlayerSnap?.exists
            ? Number(botPlayerSnap.get('demoBalanceEtb') ?? 0)
            : 0;
        const refundAmt = Number(order.requestedAmountEtb);
        const nextBalance = Math.min(1_000_000, Number((currentBalance + refundAmt).toFixed(2)));
        refundedBalanceEtb = nextBalance;

        if (userSnap.exists) {
          tx.update(userRef, {
            demoBalanceEtb: nextBalance,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(userRef, {
            uid: order.uid,
            telegramUserId: order.uid,
            displayName: order.userDisplayName,
            username: order.uid,
            language: 'am',
            phoneVerified: true,
            demoBalanceEtb: nextBalance,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        if (botPlayerRef && botPlayerSnap?.exists) {
          tx.update(botPlayerRef, {
            demoBalanceEtb: nextBalance,
            updatedAt: nowIso,
          });
        }

        const txId = `tx_poref_${order.requestId}`;
        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: order.uid,
          type: 'withdraw_demo',
          amountEtb: refundAmt,
          balanceBeforeEtb: currentBalance,
          balanceAfterEtb: nextBalance,
          status: 'demo_completed',
          description: `Demo Payout Rejected Refund (${order.requestId})`.slice(0, 160),
          reference: `ADB-POREF-${order.requestId}`.slice(0, 64),
          relatedId: order.requestId,
          idempotencyKey: txId,
          createdAt: nowIso,
        });
      }

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'PAYOUT_STATUS_REVIEWED',
        targetId: order.requestId,
        summary: `Payout order ${order.requestId} (${order.requestedAmountEtb} ETB Demo) changed from ${prevStatus} to ${params.nextStatus}`,
        previousValue: prevStatus,
        newValue: params.nextStatus,
        notes: cleanNotes,
      });

      tx.set(payoutRef, updatedOrder);
      this.writeAuditRecordToTx(tx, builtAudit);

      return {
        ok: true,
        payout: updatedOrder,
        refundedBalanceEtb,
        auditRecord: builtAudit.auditRecord,
      };
    });
  }

  public async getDepositRequests(): Promise<AdminDepositRequest[]> {
    await this.ensureSeedData();
    const snap = await this.db.collection(DEPOSIT_REQUESTS_COLLECTION).get();
    return snap.docs.map((d) => d.data() as AdminDepositRequest);
  }

  /**
   * Reviews a deposit request atomically inside a Firestore transaction.
   * When a deposit is approved (transitioning from non-Approved to Approved), credits the player's
   * Demo balance in `users/{uid}` and records a `deposit_demo` ledger entry in `transactions`.
   */
  public async reviewDepositRequest(params: {
    depositId: string;
    nextStatus: DepositRequestStatus;
    reviewNotes: string;
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'deposit_not_found' | 'invalid_status' | 'already_finalized' | 'invalid_transition';
    deposit?: AdminDepositRequest;
    creditedBalanceEtb?: number;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    const allowed: DepositRequestStatus[] = ['Pending', 'Approved', 'Rejected'];
    if (!allowed.includes(params.nextStatus)) {
      return { ok: false, reason: 'invalid_status' };
    }

    const depRef = this.db.collection(DEPOSIT_REQUESTS_COLLECTION).doc(params.depositId);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');
    const transactionsCol = this.db.collection('transactions');

    return await this.db.runTransaction(async (tx) => {
      // 1. Read deposit and audit chain first
      const [depSnap, chainSnap] = await Promise.all([
        tx.get(depRef),
        tx.get(chainRef),
      ]);

      if (!depSnap.exists) {
        return { ok: false, reason: 'deposit_not_found' as const };
      }

      const dep = depSnap.data() as AdminDepositRequest;
      const userRef = this.db.collection('users').doc(dep.uid);
      const depTgMatch = /^tg_([1-9]\d*)$/.exec(dep.uid);
      const depTgId = Number(dep.telegramUserId || (depTgMatch ? Number(depTgMatch[1]) : 0));
      const botPlayerRef =
        depTgId > 0 ? this.db.collection('botPlayers').doc(String(depTgId)) : null;
      const [userSnap, botPlayerSnap] = await Promise.all([
        tx.get(userRef),
        botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
      ]);

      const prevStatus = dep.status;
      if (prevStatus === 'Approved' || prevStatus === 'Rejected') {
        return { ok: false, reason: 'already_finalized' as const };
      }
      if (params.nextStatus !== 'Approved' && params.nextStatus !== 'Rejected') {
        return { ok: false, reason: 'invalid_transition' as const };
      }

      const cleanNotes =
        params.reviewNotes.trim() || `Deposit ${params.nextStatus} (Demo Sandbox)`;
      const nowIso = new Date().toISOString();

      const updatedDep: AdminDepositRequest = {
        ...dep,
        status: params.nextStatus,
        reviewNotes: cleanNotes,
        reviewedBy: params.adminActor.displayName,
        reviewedAt: nowIso,
        demoSandboxOnly: true,
      };

      let creditedBalanceEtb: number | undefined;

      // If transitioning to Approved from Pending, atomically credit the player's balance
      if (params.nextStatus === 'Approved') {
        const currentBalance = userSnap.exists
          ? Number(userSnap.get('demoBalanceEtb') ?? 0)
          : botPlayerSnap?.exists
            ? Number(botPlayerSnap.get('demoBalanceEtb') ?? 0)
            : 0;
        const creditAmt = Number(dep.amountEtb);
        const nextBalance = Math.min(1_000_000, Number((currentBalance + creditAmt).toFixed(2)));
        creditedBalanceEtb = nextBalance;

        if (userSnap.exists) {
          tx.update(userRef, {
            demoBalanceEtb: nextBalance,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(userRef, {
            uid: dep.uid,
            telegramUserId: dep.uid,
            displayName: dep.userDisplayName,
            username: dep.uid,
            language: 'am',
            phoneVerified: true,
            demoBalanceEtb: nextBalance,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        if (botPlayerRef && botPlayerSnap?.exists) {
          tx.update(botPlayerRef, {
            demoBalanceEtb: nextBalance,
            updatedAt: nowIso,
          });
        }

        const txId = `tx_dep_${dep.depositId}`;
        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: dep.uid,
          type: 'deposit_demo',
          amountEtb: creditAmt,
          balanceBeforeEtb: currentBalance,
          balanceAfterEtb: nextBalance,
          status: 'demo_completed',
          description: `Approved Manual Deposit (${dep.provider} · ${dep.referenceCode})`.slice(0, 160),
          reference: dep.referenceCode || `ADB-DEP-${dep.depositId}`,
          relatedId: dep.depositId,
          idempotencyKey: txId,
          createdAt: nowIso,
        });
      }

      // Queue player notification for both Approved and Rejected manual deposits
      if (depTgId > 0 && (params.nextStatus === 'Approved' || params.nextStatus === 'Rejected')) {
        const notifId = `notif_dep_${dep.depositId}_${params.nextStatus.toLowerCase()}`;
        const playerLang: Language =
          (userSnap.exists && userSnap.get('language') === 'en') ||
          (botPlayerSnap?.exists && botPlayerSnap.get('language') === 'en')
            ? 'en'
            : 'am';
        const isApproved = params.nextStatus === 'Approved';
        const title = isApproved
          ? playerLang === 'am'
            ? '✅ የተቀማጭ ክፍያዎ ጸድቋል'
            : '✅ Deposit Approved'
          : playerLang === 'am'
            ? '❌ የተቀማጭ ክፍያ ጥያቄዎ አልጸደቀም'
            : '❌ Deposit Request Rejected';
        const body = isApproved
          ? playerLang === 'am'
            ? `የ ${dep.amountEtb.toFixed(2)} ETB (${dep.provider}, Ref: ${dep.referenceCode}) ተቀማጭዎ ጸድቆ ወደ ሂሳብዎ ተጨምሯል። አዲስ ቀሪ ሂሳብ፦ ${(creditedBalanceEtb ?? 0).toFixed(2)} ETB።`
            : `Your manual deposit of ${dep.amountEtb.toFixed(2)} ETB (${dep.provider}, Ref: ${dep.referenceCode}) was approved and credited. New balance: ${(creditedBalanceEtb ?? 0).toFixed(2)} ETB.`
          : playerLang === 'am'
            ? `የ ${dep.amountEtb.toFixed(2)} ETB (${dep.provider}, Ref: ${dep.referenceCode}) ተቀማጭ ጥያቄዎ አልጸደቀም። ምክንያት፦ ${cleanNotes}`
            : `Your manual deposit of ${dep.amountEtb.toFixed(2)} ETB (${dep.provider}, Ref: ${dep.referenceCode}) was rejected. Reason: ${cleanNotes}`;

        tx.set(this.db.collection(BOT_OUTBOX_COLLECTION).doc(notifId), {
          id: notifId,
          event: 'support_response',
          telegramUserId: depTgId,
          language: playerLang,
          title,
          body,
          createdAt: nowIso,
          createdAtMs: Date.now(),
          deliveredViaBotApi: false,
        });
      }

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'DEPOSIT_STATUS_REVIEWED',
        targetId: dep.depositId,
        summary: `Manual deposit ${dep.depositId} (${dep.amountEtb} ETB, Ref: ${dep.referenceCode}) changed from ${prevStatus} to ${params.nextStatus}`,
        previousValue: prevStatus,
        newValue: params.nextStatus,
        notes: cleanNotes,
      });

      tx.set(depRef, updatedDep);
      this.writeAuditRecordToTx(tx, builtAudit);

      return {
        ok: true,
        deposit: updatedDep,
        creditedBalanceEtb,
        auditRecord: builtAudit.auditRecord,
      };
    });
  }

  public async getRooms(): Promise<AdminRoomConfigRecord[]> {
    await this.ensureSeedData();
    const snap = await this.db.collection('rooms').get();
    return snap.docs.map((d) => {
      const data = d.data() || {};
      const id = String(data.id || data.roomId || d.id);
      const rawAdminStatus = String(data.adminStatus || data.status || 'open');
      const cardPriceEtb = Number(data.cardPriceEtb ?? data.cardPrice ?? 10);
      const activePlayers = Number(
        data.confirmedPlayersCount ?? data.activePlayers ?? data.activePlayersCount ?? 0
      );
      const reservedCardsCount = Number(
        data.totalCardsSold ?? data.reservedCardsCount ?? activePlayers
      );
      const financials = calculateAuthoritativeGameFinancials(
        activePlayers,
        reservedCardsCount,
        cardPriceEtb
      );
      const rawRoomStatus: 'waiting' | 'countdown' | 'live' | 'completed' =
        rawAdminStatus === 'live'
          ? 'live'
          : rawAdminStatus === 'completed'
          ? 'completed'
          : rawAdminStatus === 'starting' || rawAdminStatus === 'countdown'
          ? 'countdown'
          : 'waiting';
      const lifecycleStage = resolveGameLifecycleStage({
        status: rawRoomStatus,
        confirmedPlayersCount: financials.confirmedPlayersCount,
        countdownSeconds: Number(
          data.lobbyCountdownSeconds ?? data.countdownSeconds ?? 60
        ),
        minPlayers: Number(data.minPlayers ?? 3),
        explicitStage:
          typeof data.lifecycleStage === 'string'
            ? (data.lifecycleStage as GameLifecycleStage)
            : undefined,
      });
      return {
        id,
        nameAm: String(data.nameAm || ''),
        nameEn: String(data.nameEn || ''),
        cardPriceEtb,
        maxPlayersPerRoom: financials.maxCapacityPlayers,
        maxCardsPerRoom: Number(data.maxCardsPerRoom ?? 600),
        maxCardsPerPlayer: Number(data.maxCardsPerPlayer ?? 4),
        lobbyCountdownSeconds: Number(
          data.lobbyCountdownSeconds ?? data.countdownSeconds ?? 60
        ),
        minPlayers: Number(data.minPlayers ?? 3),
        activePlayers: financials.confirmedPlayersCount,
        confirmedPlayersCount: financials.confirmedPlayersCount,
        availableSpaces: financials.availableSpaces,
        reservedCardsCount: financials.totalCardsSold,
        totalCardsSold: financials.totalCardsSold,
        totalCollectedEtb: financials.totalCollectedEtb,
        adeyShareEtb: financials.adeyShareEtb,
        winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
        lifecycleStage,
        status: mapRoomStatusToAdminStatus(rawAdminStatus),
        updatedAt:
          typeof data.updatedAt === 'string'
            ? data.updatedAt
            : new Date().toISOString(),
      };
    });
  }

  public async updateRoomConfig(params: {
    roomId: string;
    cardPriceEtb?: number;
    lobbyCountdownSeconds?: number;
    minPlayers?: number;
    status?: AdminRoomConfigRecord['status'];
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'room_not_found' | 'invalid_parameters';
    room?: AdminRoomConfigRecord;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();

    if (
      params.cardPriceEtb !== undefined &&
      (!Number.isFinite(params.cardPriceEtb) ||
        params.cardPriceEtb < 1 ||
        params.cardPriceEtb > 500)
    ) {
      return { ok: false, reason: 'invalid_parameters' };
    }
    if (
      params.lobbyCountdownSeconds !== undefined &&
      (!Number.isFinite(params.lobbyCountdownSeconds) ||
        params.lobbyCountdownSeconds < 10 ||
        params.lobbyCountdownSeconds > 300)
    ) {
      return { ok: false, reason: 'invalid_parameters' };
    }
    if (
      params.minPlayers !== undefined &&
      (!Number.isFinite(params.minPlayers) ||
        params.minPlayers < 2 ||
        params.minPlayers > 50)
    ) {
      return { ok: false, reason: 'invalid_parameters' };
    }

    const roomRef = this.db.collection('rooms').doc(params.roomId);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    return await this.db.runTransaction(async (tx) => {
      const [roomSnap, chainSnap] = await Promise.all([
        tx.get(roomRef),
        tx.get(chainRef),
      ]);

      if (!roomSnap.exists) {
        return { ok: false, reason: 'room_not_found' as const };
      }

      const data = roomSnap.data() || {};
      const prevPrice = Number(data.cardPriceEtb ?? data.cardPrice ?? 10);
      const prevCountdown = Number(
        data.lobbyCountdownSeconds ?? data.countdownSeconds ?? 60
      );
      const prevMinPlayers = Number(data.minPlayers ?? 3);
      const prevStatus = mapRoomStatusToAdminStatus(
        String(data.adminStatus || data.status || 'open')
      );

      const nextPrice = params.cardPriceEtb ?? prevPrice;
      const nextCountdown = params.lobbyCountdownSeconds ?? prevCountdown;
      const nextMinPlayers = params.minPlayers ?? prevMinPlayers;
      const nextStatus = params.status ?? prevStatus;
      const nowIso = new Date().toISOString();

      const prevSummary = `price=${prevPrice},countdown=${prevCountdown},minPlayers=${prevMinPlayers},status=${prevStatus}`;
      const nextSummary = `price=${nextPrice},countdown=${nextCountdown},minPlayers=${nextMinPlayers},status=${nextStatus}`;

      const updatedRoom: AdminRoomConfigRecord = {
        id: params.roomId,
        nameAm: String(data.nameAm || ''),
        nameEn: String(data.nameEn || ''),
        cardPriceEtb: nextPrice,
        maxCardsPerRoom: Number(data.maxCardsPerRoom ?? 600),
        maxCardsPerPlayer: Number(data.maxCardsPerPlayer ?? 4),
        lobbyCountdownSeconds: nextCountdown,
        minPlayers: nextMinPlayers,
        activePlayers: Number(data.activePlayers ?? data.activePlayersCount ?? 0),
        status: nextStatus,
        updatedAt: nowIso,
      };

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'ROOM_CONFIG_UPDATED',
        targetId: params.roomId,
        summary: `Updated room ${updatedRoom.nameEn || params.roomId} (${params.roomId}) parameters`,
        previousValue: prevSummary,
        newValue: nextSummary,
      });

      tx.update(roomRef, {
        cardPrice: nextPrice,
        cardPriceEtb: nextPrice,
        countdownSeconds: nextCountdown,
        lobbyCountdownSeconds: nextCountdown,
        minPlayers: nextMinPlayers,
        adminStatus: nextStatus,
        status: mapAdminStatusToRoomStatus(nextStatus),
        updatedAt: nowIso,
      });

      this.writeAuditRecordToTx(tx, builtAudit);

      return {
        ok: true,
        room: updatedRoom,
        auditRecord: builtAudit.auditRecord,
      };
    });
  }

  public async getReferrals(): Promise<AdminReferralRecord[]> {
    await this.ensureSeedData();
    const snap = await this.db.collection('referrals').get();
    return snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: String(data.id || d.id),
        inviterUid: String(data.inviterUid || ''),
        inviterName: String(data.inviterName || 'Unknown'),
        inviterTelegramId: Number(data.inviterTelegramId ?? 0),
        inviteeUid: String(data.inviteeUid || `tg_${d.id}`),
        inviteeName: String(data.inviteeName || data.friendName || 'Player'),
        inviteeHandle: String(data.inviteeHandle || data.handle || '@player'),
        joinedAt: String(data.joinedAt || new Date().toISOString()),
        status:
          data.status === 'qualified' ? 'qualified' : 'pending_verification',
        inviterBonusEtb: Number(data.inviterBonusEtb ?? data.inviterBonus ?? 20),
        inviteeBonusEtb: Number(data.inviteeBonusEtb ?? data.inviteeBonus ?? 0),
      };
    });
  }

  public async getBotManagementState(): Promise<BotAdminConfig> {
    await this.ensureSeedData();
    const [cfgSnap, annSnap] = await Promise.all([
      this.db.collection(BOT_CONFIG_COLLECTION).doc('default').get(),
      this.db.collection(BOT_ANNOUNCEMENTS_COLLECTION).get(),
    ]);

    const cfgData = (cfgSnap.exists ? cfgSnap.data() : {}) || {};
    const announcements = annSnap.docs
      .map((d) => d.data() as BotAnnouncementRecord)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const rawLabels = ((cfgData.buttonLabels as Record<string, string>) || {});
    const mergedLabels = {
      ...DEFAULT_BOT_BUTTON_LABELS,
      ...rawLabels,
      playBingoAm: rawLabels.playBingoAm || rawLabels.playAm || DEFAULT_BOT_BUTTON_LABELS.playBingoAm,
      playBingoEn: rawLabels.playBingoEn || rawLabels.playEn || DEFAULT_BOT_BUTTON_LABELS.playBingoEn,
      playAm: rawLabels.playBingoAm || rawLabels.playAm || DEFAULT_BOT_BUTTON_LABELS.playBingoAm,
      playEn: rawLabels.playBingoEn || rawLabels.playEn || DEFAULT_BOT_BUTTON_LABELS.playBingoEn,
    };

    return {
      miniAppUrl: sanitizeProductionMiniAppUrl(
        String(cfgData.miniAppUrl || DEFAULT_DEPLOYED_MINI_APP_URL)
      ),
      customWelcomeAm:
        typeof cfgData.customWelcomeAm === 'string' ? cfgData.customWelcomeAm : null,
      customWelcomeEn:
        typeof cfgData.customWelcomeEn === 'string' ? cfgData.customWelcomeEn : null,
      buttonLabels: mergedLabels as BotButtonLabelsConfig,
      announcements,
      stats: {
        totalUpdatesProcessed: Number(cfgData.stats?.totalUpdatesProcessed ?? 0),
        callbacksHandled: Number(cfgData.stats?.callbacksHandled ?? 0),
        duplicateCallbacksBlocked: Number(cfgData.stats?.duplicateCallbacksBlocked ?? 0),
        announcementsSent: announcements.length,
      },
      updatedAt: String(cfgData.updatedAt || new Date().toISOString()),
      updatedBy: String(cfgData.updatedBy || 'system'),
    };
  }

  public async updateBotManagementConfig(params: {
    miniAppUrl?: string;
    customWelcomeAm?: string | null;
    customWelcomeEn?: string | null;
    buttonLabels?: Partial<BotButtonLabelsConfig> & { playAm?: string; playEn?: string };
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    config: BotAdminConfig;
    auditRecord: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    const cfgRef = this.db.collection(BOT_CONFIG_COLLECTION).doc('default');
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    const auditRecord = await this.db.runTransaction(async (tx) => {
      const [cfgSnap, chainSnap] = await Promise.all([
        tx.get(cfgRef),
        tx.get(chainRef),
      ]);

      const current = (cfgSnap.exists ? cfgSnap.data() : {}) || {};
      const prevUrl = sanitizeProductionMiniAppUrl(
        String(current.miniAppUrl || DEFAULT_DEPLOYED_MINI_APP_URL)
      );
      const prevWelcomeAm =
        typeof current.customWelcomeAm === 'string' ? current.customWelcomeAm : null;
      const prevWelcomeEn =
        typeof current.customWelcomeEn === 'string' ? current.customWelcomeEn : null;

      const nextUrl =
        params.miniAppUrl !== undefined && params.miniAppUrl.trim()
          ? sanitizeProductionMiniAppUrl(params.miniAppUrl.trim())
          : prevUrl;
      const nextWelcomeAm =
        params.customWelcomeAm !== undefined
          ? params.customWelcomeAm?.trim() || null
          : prevWelcomeAm;
      const nextWelcomeEn =
        params.customWelcomeEn !== undefined
          ? params.customWelcomeEn?.trim() || null
          : prevWelcomeEn;
      const incomingLabels = params.buttonLabels || {};
      const normalizedIncoming: Partial<BotButtonLabelsConfig> = {
        ...incomingLabels,
        ...(incomingLabels.playAm && !incomingLabels.playBingoAm
          ? { playBingoAm: incomingLabels.playAm }
          : {}),
        ...(incomingLabels.playEn && !incomingLabels.playBingoEn
          ? { playBingoEn: incomingLabels.playEn }
          : {}),
      };
      const nextLabels: BotButtonLabelsConfig = {
        ...DEFAULT_BOT_BUTTON_LABELS,
        ...((current.buttonLabels as Partial<BotButtonLabelsConfig>) || {}),
        ...normalizedIncoming,
      };
      const nowIso = new Date().toISOString();

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'BOT_CONFIG_UPDATED',
        targetId: 'telegram_bot_config',
        summary: 'Updated Telegram bot welcome message & button configuration',
        previousValue: `url=${prevUrl},welcomeAm=${prevWelcomeAm ? 'custom' : 'default'}`,
        newValue: `url=${nextUrl},welcomeAm=${nextWelcomeAm ? 'custom' : 'default'}`,
      });

      tx.set(
        cfgRef,
        {
          miniAppUrl: nextUrl,
          customWelcomeAm: nextWelcomeAm,
          customWelcomeEn: nextWelcomeEn,
          buttonLabels: nextLabels,
          updatedAt: nowIso,
          updatedBy: params.adminActor.displayName,
        },
        { merge: true }
      );

      this.writeAuditRecordToTx(tx, builtAudit);
      return builtAudit.auditRecord;
    });

    const config = await this.getBotManagementState();
    return { ok: true, config, auditRecord };
  }

  public async sendBotAnnouncement(params: {
    titleAm: string;
    titleEn: string;
    bodyAm: string;
    bodyEn: string;
    targetAudience?: 'all_players' | 'verified_players';
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'empty_announcement';
    announcement?: BotAnnouncementRecord;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    if (!params.bodyAm.trim() && !params.bodyEn.trim()) {
      return { ok: false, reason: 'empty_announcement' };
    }

    const users = await this.loadMergedUsers();
    const audience = params.targetAudience || 'all_players';
    const recipients =
      audience === 'verified_players'
        ? users.filter((u) => u.phoneVerified)
        : users;

    const nowIso = new Date().toISOString();
    const annId = `ANN-${Date.now().toString().slice(-6)}`;
    const announcement: BotAnnouncementRecord = {
      id: annId,
      titleAm: params.titleAm.trim() || '🌼 የADEYBINGO ማስታወቂያ',
      titleEn: params.titleEn.trim() || '🌼 ADEYBINGO Announcement',
      bodyAm: (params.bodyAm || params.bodyEn).trim(),
      bodyEn: (params.bodyEn || params.bodyAm).trim(),
      targetAudience: audience,
      recipientCount: Math.max(1, recipients.length),
      sentByAdmin: params.adminActor.displayName,
      sentAt: nowIso,
    };

    const annRef = this.db.collection(BOT_ANNOUNCEMENTS_COLLECTION).doc(annId);
    const outboxCol = this.db.collection(BOT_OUTBOX_COLLECTION);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    const auditRecord = await this.db.runTransaction(async (tx) => {
      const chainSnap = await tx.get(chainRef);
      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'BOT_ANNOUNCEMENT_SENT',
        targetId: announcement.id,
        summary: `Sent Telegram bot announcement '${announcement.titleEn}' to ${announcement.recipientCount} player(s)`,
        newValue: announcement.targetAudience,
        notes: announcement.bodyEn.slice(0, 120),
      });

      tx.set(annRef, announcement);
      for (const recipient of recipients.slice(0, 25)) {
        if (!recipient.telegramUserId) continue;
        const msgId = `ntf_ann_${annId}_${recipient.telegramUserId}`;
        const ntf: BotNotificationMessage & { createdAtMs: number } = {
          id: msgId,
          event: 'admin_announcement',
          telegramUserId: recipient.telegramUserId,
          language: recipient.language,
          title:
            recipient.language === 'am' ? announcement.titleAm : announcement.titleEn,
          body: recipient.language === 'am' ? announcement.bodyAm : announcement.bodyEn,
          createdAt: nowIso,
          createdAtMs: Date.now(),
          deliveredViaBotApi: false,
        };
        tx.set(outboxCol.doc(msgId), ntf);
      }

      this.writeAuditRecordToTx(tx, builtAudit);
      return builtAudit.auditRecord;
    });

    return { ok: true, announcement, auditRecord };
  }

  public async listNotifications(limit = 25): Promise<
    Array<
      BotNotificationMessage & {
        messageText: string;
        delivered: boolean;
        skippedReason?: string;
      }
    >
  > {
    await this.ensureSeedData();
    const snap = await this.db.collection(BOT_OUTBOX_COLLECTION).get();
    const items = snap.docs.map((d) => {
      const data = d.data() || {};
      const resolvedBody = String(data.body || data.messageText || data.textEn || data.textAm || '');
      const resolvedDelivered = Boolean(data.deliveredViaBotApi ?? data.delivered);
      return {
        id: String(data.id || d.id),
        event: (data.event || 'admin_announcement') as BotNotificationMessage['event'],
        telegramUserId: Number(data.telegramUserId ?? data.recipientTelegramId ?? 0),
        language: (data.language === 'en' ? 'en' : 'am') as Language,
        title: String(data.title || data.event || 'ADEYBINGO Notification'),
        body: resolvedBody,
        messageText: resolvedBody,
        createdAt: String(data.createdAt || new Date().toISOString()),
        deliveredViaBotApi: resolvedDelivered,
        delivered: resolvedDelivered,
        skippedReason: resolvedDelivered
          ? undefined
          : String(data.skippedReason || 'queued_for_bot_delivery'),
      };
    });
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items.slice(0, Math.max(1, Math.min(100, limit)));
  }

  public async sendNotification(params: {
    telegramUserId: number;
    title: string;
    body: string;
    language?: Language;
    adminActor: VerifiedSessionActor;
  }): Promise<{
    ok: boolean;
    reason?: 'invalid_notification';
    notification?: BotNotificationMessage;
    auditRecord?: AdminAuditRecord;
  }> {
    await this.ensureSeedData();
    if (
      !Number.isInteger(params.telegramUserId) ||
      params.telegramUserId <= 0 ||
      !params.body.trim()
    ) {
      return { ok: false, reason: 'invalid_notification' };
    }

    const nowIso = new Date().toISOString();
    const id = `ntf_${crypto.randomUUID()}`;
    const notification: BotNotificationMessage = {
      id,
      event: 'support_response',
      telegramUserId: params.telegramUserId,
      language: params.language === 'en' ? 'en' : 'am',
      title: params.title.trim() || '🌼 ADEYBINGO Notification',
      body: params.body.trim(),
      createdAt: nowIso,
      deliveredViaBotApi: false,
    };

    const outboxRef = this.db.collection(BOT_OUTBOX_COLLECTION).doc(id);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    const auditRecord = await this.db.runTransaction(async (tx) => {
      const chainSnap = await tx.get(chainRef);
      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'BOT_ANNOUNCEMENT_SENT',
        targetId: `tg_${params.telegramUserId}`,
        summary: `Queued direct Telegram notification '${notification.title}' to TG #${params.telegramUserId}`,
        newValue: notification.language,
        notes: notification.body.slice(0, 120),
      });

      tx.set(outboxRef, {
        ...notification,
        createdAtMs: Date.now(),
      });
      this.writeAuditRecordToTx(tx, builtAudit);
      return builtAudit.auditRecord;
    });

    return { ok: true, notification, auditRecord };
  }

  public async getOverviewMetrics() {
    await this.ensureSeedData();
    const [
      allUsers,
      allPayouts,
      allDeposits,
      allRooms,
      allReferrals,
      botCfg,
      auditTrail,
      auditIntegrity,
      gamesSnap,
      txSnap,
    ] = await Promise.all([
      this.loadMergedUsers(),
      this.getPayoutOrders(),
      this.getDepositRequests(),
      this.getRooms(),
      this.getReferrals(),
      this.getBotManagementState(),
      this.getAuditTrail(),
      this.verifyAuditChainIntegrity(),
      this.db.collection('games').get(),
      this.db.collection('transactions').get(),
    ]);

    const primaryRoom = allRooms.find((r) => r.id === 'adey-main') || allRooms[0];
    const primaryGameId = `game_${primaryRoom?.id || 'adey-main'}_live`;
    const primaryGameDoc = gamesSnap.docs.find((d) => d.id === primaryGameId);
    const primaryGameData = primaryGameDoc ? primaryGameDoc.data() || {} : {};
    const calledNumbers = Array.isArray(primaryGameData.calledNumbers)
      ? (primaryGameData.calledNumbers as unknown[]).map(Number).filter(Number.isInteger)
      : [];
    const latestBall = Number(
      primaryGameData.latestBall ??
        (calledNumbers.length > 0 ? calledNumbers[calledNumbers.length - 1] : 0)
    );

    const confirmedPlayersCount = Math.min(
      600,
      Math.max(0, Number(primaryRoom?.confirmedPlayersCount ?? primaryRoom?.activePlayers ?? 0))
    );
    const totalCardsSold = Math.max(
      confirmedPlayersCount,
      Number(primaryRoom?.totalCardsSold ?? primaryRoom?.reservedCardsCount ?? confirmedPlayersCount)
    );
    const primaryCardPrice = Math.max(1, Number(primaryRoom?.cardPriceEtb ?? 10));
    const financials = calculateAuthoritativeGameFinancials(
      confirmedPlayersCount,
      totalCardsSold,
      primaryCardPrice
    );

    const pendingDeposits = allDeposits.filter((d) => d.status === 'Pending');
    const approvedDeposits = allDeposits.filter((d) => d.status === 'Approved');
    const rejectedDeposits = allDeposits.filter((d) => d.status === 'Rejected');
    const rejectedPayouts = allPayouts.filter((p) => p.status === 'Rejected');

    let cardRefundCount = 0;
    let cardRefundEtb = 0;
    for (const d of txSnap.docs) {
      const ref = String(d.get('reference') || '');
      const amt = Number(d.get('amountEtb') ?? 0);
      if (ref.startsWith('ADB-REL-') && amt > 0) {
        cardRefundCount += 1;
        cardRefundEtb += amt;
      }
    }

    const pendingPaymentsEtb = Number(
      pendingDeposits.reduce((sum, d) => sum + Number(d.amountEtb || 0), 0).toFixed(2)
    );
    const rejectedPaymentsEtb = Number(
      rejectedDeposits.reduce((sum, d) => sum + Number(d.amountEtb || 0), 0).toFixed(2)
    );
    const approvedDepositsEtb = Number(
      approvedDeposits.reduce((sum, d) => sum + Number(d.amountEtb || 0), 0).toFixed(2)
    );
    const refundedPaymentsEtb = Number(
      (
        rejectedPayouts.reduce((sum, p) => sum + Number(p.requestedAmountEtb || 0), 0) +
        cardRefundEtb
      ).toFixed(2)
    );

    const liveActivityFeed: AdminLiveActivityItem[] = [
      ...allDeposits.slice(0, 4).map((d) => {
        const label = `${d.userDisplayName} · ${d.provider} (${d.referenceCode})`;
        return {
          id: `act_dep_${d.depositId}`,
          timestamp: d.requestDate,
          type: 'payment' as const,
          label,
          summary: label,
          amountEtb: d.amountEtb,
          status: d.status,
        };
      }),
      ...allPayouts.slice(0, 3).map((p) => {
        const label = `${p.userDisplayName} · Payout ${p.requestId}`;
        return {
          id: `act_po_${p.requestId}`,
          timestamp: p.requestDate,
          type: 'payment' as const,
          label,
          summary: label,
          amountEtb: -p.requestedAmountEtb,
          status: p.status,
        };
      }),
      ...auditTrail.slice(0, 4).map((a) => ({
        id: `act_aud_${a.id}`,
        timestamp: a.timestamp,
        type: 'audit' as const,
        label: a.summary,
        summary: a.summary,
        status: a.action,
      })),
    ].slice(0, 8);

    const financialDashboard: AdminFinancialDashboardMetrics = {
      roomId: primaryRoom?.id || 'adey-main',
      gameId: primaryGameId,
      gameStatus: String(primaryGameData.status || primaryRoom?.status || 'open'),
      lifecycleStage: primaryRoom?.lifecycleStage || 'WAITING',
      maxCapacityPlayers: financials.maxCapacityPlayers,
      maxPlayersCapacity: financials.maxCapacityPlayers,
      entryPriceEtb: financials.entryPriceEtb,
      confirmedPlayersCount: financials.confirmedPlayersCount,
      verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
      availableSpaces: financials.availableSpaces,
      totalCardsSold: financials.totalCardsSold,
      verifiedTotalRevenueEtb: financials.totalCollectedEtb,
      adeySharePercent: 20,
      adeyShareEtb: financials.adeyShareEtb,
      winnersPrizePoolPercent: 80,
      winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
      approvedDepositsCount: approvedDeposits.length,
      approvedDepositsEtb,
      pendingPaymentsCount: pendingDeposits.length,
      pendingPaymentsEtb,
      rejectedPaymentsCount: rejectedDeposits.length,
      rejectedPaymentsEtb,
      refundedPaymentsCount: rejectedPayouts.length + cardRefundCount,
      refundedPaymentsEtb,
      latestBall,
      currentDrawnNumber: latestBall > 0 ? latestBall : null,
      calledNumbersCount: calledNumbers.length,
      liveActivityFeed,
      updatedAt: new Date().toISOString(),
    };

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
        Rejected: rejectedPayouts.length,
        Completed: allPayouts.filter((p) => p.status === 'Completed').length,
      },
      depositCounts: {
        total: allDeposits.length,
        Pending: pendingDeposits.length,
        Approved: approvedDeposits.length,
        Rejected: rejectedDeposits.length,
      },
      activeRoomsCount: allRooms.length,
      totalOnlinePlayers: allRooms.reduce((acc, r) => acc + r.activePlayers, 0),
      totalReferrals: allReferrals.length,
      botStats: botCfg.stats,
      auditTrailEntries: auditTrail.length,
      auditIntegrity,
      financialDashboard,
      mode: 'demo_sandbox',
    };
  }

  public async getAdminSettings() {
    await this.ensureSeedData();
    const [auditChainIntegrity, auditTrail] = await Promise.all([
      this.verifyAuditChainIntegrity(),
      this.getAuditTrail(),
    ]);

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
      auditChainIntegrity,
      auditTrail,
    };
  }

  /**
   * Audits existing accounts that received the legacy incorrect 250 ETB initialization
   * instead of the authoritative 15 ETB initial credit. Never deletes balances or history.
   */
  public async auditLegacyInitialCredits(): Promise<
    Array<{
      uid: string;
      displayName: string;
      initialTxId: string;
      initialCreditEtb: number;
      expectedInitialCreditEtb: number;
      excessEtb: number;
      currentBalanceEtb: number;
      recommendedAdjustmentEtb: number;
      alreadyReconciled: boolean;
    }>
  > {
    const [usersSnap, txSnap] = await Promise.all([
      this.db.collection('users').get(),
      this.db.collection('transactions').get(),
    ]);

    const userMap = new Map<string, { displayName: string; demoBalanceEtb: number }>();
    for (const uDoc of usersSnap.docs) {
      const d = uDoc.data() || {};
      userMap.set(uDoc.id, {
        displayName: String(d.displayName || uDoc.id),
        demoBalanceEtb: Number(d.demoBalanceEtb ?? 0),
      });
    }

    const reconciledUids = new Set<string>();
    const legacyInitEntries: Array<{ uid: string; txId: string; amountEtb: number }> = [];

    for (const tDoc of txSnap.docs) {
      const d = tDoc.data() || {};
      const txId = String(d.transactionId || tDoc.id);
      const userId = String(d.userId || '');
      if (txId.startsWith('tx_reconcile_init_') && userId) {
        reconciledUids.add(userId);
      }
      const amount = Number(d.amountEtb ?? 0);
      if (txId.startsWith('tx_init_') && amount > 15 && userId) {
        legacyInitEntries.push({ uid: userId, txId, amountEtb: amount });
      }
    }

    return legacyInitEntries.map((entry) => {
      const userInfo = userMap.get(entry.uid);
      const currentBalanceEtb = userInfo ? userInfo.demoBalanceEtb : 0;
      const excessEtb = Number(Math.max(0, entry.amountEtb - 15).toFixed(2));
      const alreadyReconciled = reconciledUids.has(entry.uid);
      const recommendedAdjustmentEtb = alreadyReconciled
        ? 0
        : Number(Math.min(excessEtb, Math.max(0, currentBalanceEtb)).toFixed(2));
      return {
        uid: entry.uid,
        displayName: userInfo?.displayName || entry.uid,
        initialTxId: entry.txId,
        initialCreditEtb: entry.amountEtb,
        expectedInitialCreditEtb: 15,
        excessEtb,
        currentBalanceEtb,
        recommendedAdjustmentEtb,
        alreadyReconciled,
      };
    });
  }

  /**
   * Reconciles a legacy over-credited initial balance (e.g. 250 ETB -> 15 ETB) via a non-destructive,
   * idempotent, auditable ledger adjustment transaction and SHA-256 chained audit record.
   * Preserves legitimate earned balances and full transaction history.
   */
  public async reconcileLegacyInitialCredit(params: {
    uid: string;
    adminActor: VerifiedSessionActor;
    notes?: string;
  }): Promise<{
    ok: boolean;
    reason?: 'user_not_found' | 'no_legacy_excess' | 'already_reconciled';
    uid?: string;
    adjustmentEtb?: number;
    previousBalanceEtb?: number;
    updatedBalanceEtb?: number;
    transactionId?: string;
    auditRecord?: AdminAuditRecord;
  }> {
    const userRef = this.db.collection('users').doc(params.uid);
    const tgMatch = /^tg_([1-9]\d*)$/.exec(params.uid);
    const tgId = tgMatch ? Number(tgMatch[1]) : 0;
    const botPlayerRef = tgId > 0 ? this.db.collection('botPlayers').doc(String(tgId)) : null;
    const initTxRef = this.db.collection('transactions').doc(`tx_init_${params.uid}`);
    const reconcileTxId = `tx_reconcile_init_${params.uid}`;
    const reconcileTxRef = this.db.collection('transactions').doc(reconcileTxId);
    const chainRef = this.db.collection(ADMIN_AUDIT_META_COLLECTION).doc('chain');

    return await this.db.runTransaction(async (tx) => {
      const [userSnap, botPlayerSnap, initTxSnap, reconcileSnap, chainSnap] = await Promise.all([
        tx.get(userRef),
        botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
        tx.get(initTxRef),
        tx.get(reconcileTxRef),
        tx.get(chainRef),
      ]);

      if (!userSnap.exists) {
        return { ok: false, reason: 'user_not_found' as const };
      }
      if (reconcileSnap.exists) {
        return { ok: false, reason: 'already_reconciled' as const };
      }
      const initialCredit = initTxSnap.exists ? Number(initTxSnap.get('amountEtb') ?? 0) : 0;
      const excessEtb = Number(Math.max(0, initialCredit - 15).toFixed(2));
      if (excessEtb <= 0) {
        return { ok: false, reason: 'no_legacy_excess' as const };
      }

      const previousBalanceEtb = Math.max(0, Number(userSnap.get('demoBalanceEtb') ?? 0));
      const recoverableAdjustment = Number(Math.min(excessEtb, previousBalanceEtb).toFixed(2));
      const updatedBalanceEtb = Number(Math.max(0, previousBalanceEtb - recoverableAdjustment).toFixed(2));
      const nowIso = new Date().toISOString();
      const cleanNotes =
        params.notes?.trim() ||
        `Auditable correction of legacy ${initialCredit} ETB initial credit to 15 ETB (excess -${recoverableAdjustment} ETB)`;

      tx.update(userRef, {
        demoBalanceEtb: updatedBalanceEtb,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (botPlayerRef && botPlayerSnap?.exists) {
        tx.update(botPlayerRef, {
          demoBalanceEtb: updatedBalanceEtb,
          updatedAt: nowIso,
        });
      }

      tx.set(reconcileTxRef, {
        transactionId: reconcileTxId,
        userId: params.uid,
        type: 'withdraw_demo',
        amountEtb: -recoverableAdjustment,
        balanceBeforeEtb: previousBalanceEtb,
        balanceAfterEtb: updatedBalanceEtb,
        status: 'demo_completed',
        description: cleanNotes.slice(0, 160),
        reference: `ADB-RECON-${params.uid}`.slice(0, 64),
        relatedId: `tx_init_${params.uid}`,
        idempotencyKey: reconcileTxId,
        createdAt: nowIso,
      });

      const builtAudit = this.buildAuditRecordFromChainSnap(chainSnap, {
        adminActor: params.adminActor,
        action: 'WALLET_BALANCE_ADJUSTED',
        targetId: params.uid,
        summary: `Reconciled legacy initial credit (${initialCredit} -> 15 ETB) for ${params.uid}: -${recoverableAdjustment} ETB`,
        previousValue: `${previousBalanceEtb.toFixed(2)} ETB`,
        newValue: `${updatedBalanceEtb.toFixed(2)} ETB`,
        notes: cleanNotes,
      });
      this.writeAuditRecordToTx(tx, builtAudit);

      return {
        ok: true,
        uid: params.uid,
        adjustmentEtb: -recoverableAdjustment,
        previousBalanceEtb,
        updatedBalanceEtb,
        transactionId: reconcileTxId,
        auditRecord: builtAudit.auditRecord,
      };
    });
  }
}
