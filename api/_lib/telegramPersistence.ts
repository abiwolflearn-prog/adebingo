import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { Language } from '../../src/types/bingo.ts';
import {
  type BotAdminConfig,
  type BotNotificationMessage,
  buildBotMainMenuMarkup,
  buildTelegramInviteLink,
  buildTelegramReferralCode,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  extractStartCommandReferralCode,
  formatTelegramNotification,
  isDisallowedMiniAppPreviewUrl,
  type NotificationEventType,
  type RegisteredTelegramPlayer,
  sanitizeProductionMiniAppUrl,
  type TelegramBotResponse,
} from '../../src/utils/telegramBot.ts';
import {
  type TelegramValidationResult,
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

export interface PlayerGameRoundRecord {
  gameId: string;
  roomId: string;
  cardId: number;
  pattern: string;
  amountEtb: number;
  playedAt: string;
}

export interface PlayerBotStatsAndHistory {
  balanceEtb: number;
  demoWinningsEtb: number;
  gamesPlayed: number;
  totalWins: number;
  referralCount: number;
  recentHistory: PlayerHistoryItem[];
  recentGames: PlayerGameRoundRecord[];
}

export interface BotDepositRequestView {
  depositId: string;
  amountEtb: number;
  provider: string;
  referenceCode: string;
  receiptProof?: string;
  reviewNotes?: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestDate: string;
}

export interface BotWithdrawalRequestView {
  requestId: string;
  requestedAmountEtb: number;
  paymentMethod: string;
  status: 'Pending' | 'Under Review' | 'Approved' | 'Rejected' | 'Completed';
  requestDate: string;
  reviewNotes: string;
}

export interface BotLeaderboardEntry {
  uid: string;
  telegramUserId: number;
  displayName: string;
  wins: number;
  winningsEtb: number;
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
  }): Promise<{
    ok: boolean;
    isNew?: boolean;
    reason?: 'duplicate_telegram_account' | 'invalid_uid';
    player?: RegisteredTelegramPlayer;
  }>;
  setLanguage(telegramUserId: number, language: Language): Promise<void>;
  setPendingFlow?(
    telegramUserId: number,
    pendingAction: 'deposit_amount' | 'withdraw_amount' | null,
    pendingMethod: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)' | null
  ): Promise<void>;
  processReferralDeepLink?(params: {
    inviteeTelegramId: number;
    inviteeName: string;
    inviteeUsername: string;
    referralCode: string;
  }): Promise<{
    applied: boolean;
    reason?: 'self_referral' | 'already_referred' | 'invalid_code' | 'inviter_not_found';
    inviterTelegramId?: number;
    inviteeBonusEtb?: number;
    inviterBonusEtb?: number;
    inviterBalanceEtb?: number;
    inviteeBalanceEtb?: number;
  }>;
  createDemoDepositRequest?(params: {
    telegramUserId: number;
    method: string;
    amountEtb: number;
    receiptReference?: string;
    receiptProof?: string;
  }): Promise<{ ok: boolean; reason?: string; deposit?: BotDepositRequestView }>;
  listPlayerDepositRequests?(telegramUserId: number): Promise<BotDepositRequestView[]>;
  createDemoWithdrawalRequest?(params: {
    telegramUserId: number;
    method: string;
    amountEtb: number;
  }): Promise<{
    ok: boolean;
    reason?: string;
    availableBalanceEtb?: number;
    updatedBalanceEtb?: number;
    withdrawal?: BotWithdrawalRequestView;
  }>;
  listPlayerWithdrawalRequests?(telegramUserId: number): Promise<BotWithdrawalRequestView[]>;
  getLeaderboard?(limit?: number): Promise<BotLeaderboardEntry[]>;
  verifyAndPersistContact(params: {
    telegramUserId: number;
    uid?: string;
    firstName: string;
    lastName?: string;
    username: string;
    verifiedPhoneNumber: string;
    maskedPhone: string;
  }): Promise<{
    ok: boolean;
    reason?:
      | 'duplicate_telegram_account'
      | 'duplicate_phone_number'
      | 'verified_contact_locked'
      | 'invalid_uid';
    player?: RegisteredTelegramPlayer;
  }>;
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
  const depositsCol = db.collection('depositRequests');
  const receiptLocksCol = db.collection('depositReceiptLocks');
  const payoutsCol = db.collection('payoutRequests');

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
        const userLang = userSnap.get('language');
        if (userLang === 'am' || userLang === 'en') {
          player.language = player.language || userLang;
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
            ? Number(userSnap.get('demoBalanceEtb') ?? 0)
            : existingPlayer?.demoBalanceEtb ?? 15,
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
          const initialBal = player.demoBalanceEtb;
          tx.set(userRef, {
            uid,
            telegramUserId: telegramKey,
            displayName: `${player.firstName} ${player.lastName || ''}`.trim().slice(0, 80),
            username: `@${player.username}`.slice(0, 64),
            language: resolvedLang,
            phoneVerified: player.phoneVerified,
            demoBalanceEtb: initialBal,
            referralCode: player.referralCode,
            referralsCount: 0,
            registeredAt: player.registeredAt,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          const initTxId = `tx_init_${uid}`;
          tx.set(transactionsCol.doc(initTxId), {
            transactionId: initTxId,
            userId: uid,
            type: 'deposit_demo',
            amountEtb: initialBal,
            balanceBeforeEtb: 0,
            balanceAfterEtb: initialBal,
            status: 'demo_completed',
            description: `Initial Account Balance (+${initialBal} ETB)`,
            reference: `ADB-INIT-${telegramUserId}`,
            relatedId: uid,
            idempotencyKey: initTxId,
            createdAt: nowIso,
          });
        } else {
          tx.update(userRef, {
            displayName: `${player.firstName} ${player.lastName || ''}`.trim().slice(0, 80),
            username: `@${player.username}`.slice(0, 64),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        const isNew = !playerSnap.exists && !userSnap.exists;
        tx.set(playerRef, player, { merge: true });
        return { ok: true, isNew, player };
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
        }

        if (userSnap.exists) {
          tx.update(userRef, { language, updatedAt: FieldValue.serverTimestamp() });
        }
      });
    },

    async setPendingFlow(
      telegramUserId: number,
      pendingAction: 'deposit_amount' | 'withdraw_amount' | null,
      pendingMethod: 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)' | null
    ): Promise<void> {
      assertValidTelegramUserId(telegramUserId);
      await playersCol.doc(String(telegramUserId)).set(
        {
          pendingAction,
          pendingMethod,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    },

    async processReferralDeepLink({
      inviteeTelegramId,
      inviteeName,
      inviteeUsername,
      referralCode,
    }) {
      assertValidTelegramUserId(inviteeTelegramId);
      const match = /^ADEY-([1-9]\d*)$/.exec(referralCode.trim().toUpperCase());
      if (!match) {
        return { applied: false, reason: 'invalid_code' as const };
      }
      const inviterTelegramId = Number(match[1]);
      if (!Number.isInteger(inviterTelegramId) || inviterTelegramId <= 0) {
        return { applied: false, reason: 'invalid_code' as const };
      }
      if (inviterTelegramId === inviteeTelegramId) {
        return { applied: false, reason: 'self_referral' as const };
      }

      const inviteeUid = getTelegramFirebaseUid(inviteeTelegramId);
      const inviterUid = getTelegramFirebaseUid(inviterTelegramId);
      const inviteePlayerRef = playersCol.doc(String(inviteeTelegramId));
      const inviteeUserRef = usersCol.doc(inviteeUid);
      const inviterPlayerRef = playersCol.doc(String(inviterTelegramId));
      const inviterUserRef = usersCol.doc(inviterUid);
      const refDocRef = referralsCol.doc(`ref_tg_${inviteeTelegramId}`);

      return await db.runTransaction(async (tx) => {
        const [
          inviteePlayerSnap,
          inviteeUserSnap,
          inviterPlayerSnap,
          inviterUserSnap,
          existingRefSnap,
        ] = await Promise.all([
          tx.get(inviteePlayerRef),
          tx.get(inviteeUserRef),
          tx.get(inviterPlayerRef),
          tx.get(inviterUserRef),
          tx.get(refDocRef),
        ]);

        if (
          existingRefSnap.exists ||
          (inviteePlayerSnap.exists && inviteePlayerSnap.get('referredByUid')) ||
          (inviteeUserSnap.exists && inviteeUserSnap.get('referredByUid'))
        ) {
          return { applied: false, reason: 'already_referred' as const };
        }
        if (!inviterPlayerSnap.exists && !inviterUserSnap.exists) {
          return { applied: false, reason: 'inviter_not_found' as const };
        }

        const nowIso = new Date().toISOString();
        const inviterBonusEtb = 20;
        const inviteeBonusEtb = 0; // New player receives 15 ETB initial credit once upon registration
        const referralId = `ref_tg_${inviteeTelegramId}`;

        const inviterFirstName = String(
          inviterPlayerSnap.get('firstName') ||
            inviterUserSnap.get('displayName') ||
            `TG #${inviterTelegramId}`
        );
        const currentInviterBal = inviterUserSnap.exists
          ? Number(inviterUserSnap.get('demoBalanceEtb') ?? 0)
          : Number(inviterPlayerSnap.get('demoBalanceEtb') ?? 0);
        const inviteeAlreadyInitialized = inviteeUserSnap.exists || inviteePlayerSnap.exists;
        const currentInviteeBal = inviteeUserSnap.exists
          ? Number(inviteeUserSnap.get('demoBalanceEtb') ?? 0)
          : inviteePlayerSnap.exists
            ? Number(inviteePlayerSnap.get('demoBalanceEtb') ?? 0)
            : 15;
        const nextInviterBal = Number((currentInviterBal + inviterBonusEtb).toFixed(2));
        const nextInviteeBal = Number(currentInviteeBal.toFixed(2));
        const prevInviterRefCount = inviterUserSnap.exists
          ? Number(inviterUserSnap.get('referralsCount') ?? 0)
          : 0;

        tx.set(refDocRef, {
          id: referralId,
          referralId,
          inviterUid,
          inviterName: inviterFirstName,
          inviterTelegramId,
          inviteeUid,
          inviteeName: inviteeName.slice(0, 80),
          inviteeHandle: `@${inviteeUsername.replace(/^@/, '')}`.slice(0, 64),
          joinedAt: nowIso,
          status: 'qualified',
          inviterBonusEtb,
          inviteeBonusEtb,
          createdAt: FieldValue.serverTimestamp(),
        });

        if (inviterUserSnap.exists) {
          tx.update(inviterUserRef, {
            demoBalanceEtb: nextInviterBal,
            referralsCount: prevInviterRefCount + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(inviterUserRef, {
            uid: inviterUid,
            telegramUserId: inviterUid,
            displayName: inviterFirstName.slice(0, 80),
            username: `@${String(inviterPlayerSnap.get('username') || inviterUid).replace(/^@/, '')}`.slice(0, 64),
            language: inviterPlayerSnap.get('language') === 'en' ? 'en' : 'am',
            phoneVerified: Boolean(inviterPlayerSnap.get('phoneVerified')),
            demoBalanceEtb: nextInviterBal,
            referralCode: `ADEY-${inviterTelegramId}`,
            referralsCount: 1,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        tx.set(
          inviterPlayerRef,
          {
            demoBalanceEtb: nextInviterBal,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        const cleanInviteeUsername = inviteeUsername.replace(/^@/, '') || inviteeUid;
        if (inviteeUserSnap.exists) {
          tx.update(inviteeUserRef, {
            referredByCode: referralCode.trim(),
            referredByUid: inviterUid,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(inviteeUserRef, {
            uid: inviteeUid,
            telegramUserId: inviteeUid,
            displayName: inviteeName.slice(0, 80) || 'Adey Player',
            username: `@${cleanInviteeUsername}`.slice(0, 64),
            language: inviteePlayerSnap.get('language') === 'en' ? 'en' : 'am',
            phoneVerified: Boolean(inviteePlayerSnap.get('phoneVerified')),
            demoBalanceEtb: nextInviteeBal,
            referralCode: `ADEY-${inviteeTelegramId}`,
            referredByCode: referralCode.trim(),
            referredByUid: inviterUid,
            referralsCount: 0,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          if (!inviteeAlreadyInitialized) {
            const initTxId = `tx_init_${inviteeUid}`;
            tx.set(transactionsCol.doc(initTxId), {
              transactionId: initTxId,
              userId: inviteeUid,
              type: 'deposit_demo',
              amountEtb: 15,
              balanceBeforeEtb: 0,
              balanceAfterEtb: 15,
              status: 'demo_completed',
              description: 'Initial Account Balance (+15 ETB)',
              reference: `ADB-INIT-${inviteeTelegramId}`,
              relatedId: inviteeUid,
              idempotencyKey: initTxId,
              createdAt: nowIso,
            });
          }
        }
        tx.set(
          inviteePlayerRef,
          {
            uid: inviteeUid,
            telegramUserId: inviteeTelegramId,
            telegramKey: inviteeUid,
            referralCode: `ADEY-${inviteeTelegramId}`,
            referredByCode: referralCode.trim(),
            referredByUid: inviterUid,
            demoBalanceEtb: nextInviteeBal,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        const inviterTxId = `tx_ref_inviter_${inviteeTelegramId}`;
        const inviterTxRef = transactionsCol.doc(inviterTxId);
        tx.set(inviterTxRef, {
          transactionId: inviterTxId,
          userId: inviterUid,
          type: 'referral_bonus',
          amountEtb: inviterBonusEtb,
          balanceBeforeEtb: currentInviterBal,
          balanceAfterEtb: nextInviterBal,
          status: 'demo_completed',
          description: `Referral Reward (+20 ETB · ${inviteeName})`,
          reference: `ADB-REF-${inviteeTelegramId}`,
          relatedId: referralId,
          idempotencyKey: inviterTxId,
          createdAt: nowIso,
        });

        return {
          applied: true,
          inviterTelegramId,
          inviterBonusEtb,
          inviteeBonusEtb,
          inviterBalanceEtb: nextInviterBal,
          inviteeBalanceEtb: nextInviteeBal,
        };
      });
    },

    async createDemoDepositRequest({
      telegramUserId,
      method,
      amountEtb,
      receiptReference,
      receiptProof,
    }) {
      assertValidTelegramUserId(telegramUserId);
      if (!Number.isFinite(amountEtb) || amountEtb < 10 || amountEtb > 10000) {
        return { ok: false, reason: 'invalid_deposit_amount' };
      }
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const playerRef = playersCol.doc(String(telegramUserId));
      const userRef = usersCol.doc(canonicalUid);
      const nowIso = new Date().toISOString();
      const depositId = `DEP-BOT-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const normalizedRef =
        typeof receiptReference === 'string' && receiptReference.trim().length >= 4
          ? receiptReference.trim().toUpperCase().slice(0, 64)
          : `REF-${Math.floor(100000 + Math.random() * 899999)}`;
      const cleanProof =
        typeof receiptProof === 'string' && receiptProof.trim().length > 0
          ? receiptProof.trim().slice(0, 300)
          : undefined;
      const lockKey = normalizedRef.replace(/[^A-Z0-9_-]/g, '_').slice(0, 64);
      const lockRef = receiptLocksCol.doc(lockKey);
      const depositRef = depositsCol.doc(depositId);

      return await db.runTransaction(async (tx) => {
        const [playerSnap, userSnap, lockSnap] = await Promise.all([
          tx.get(playerRef),
          tx.get(userRef),
          tx.get(lockRef),
        ]);

        if (lockSnap.exists) {
          return { ok: false, reason: 'duplicate_receipt' };
        }

        const displayName = String(
          userSnap.get('displayName') || playerSnap.get('firstName') || `TG #${telegramUserId}`
        );
        const reviewNotes = cleanProof
          ? `Manual receipt submitted: ${cleanProof}`
          : 'Manual payment receipt submitted — awaiting admin verification';

        tx.set(lockRef, {
          referenceCode: normalizedRef,
          depositId,
          uid: canonicalUid,
          telegramUserId,
          createdAt: nowIso,
        });
        tx.set(depositRef, {
          depositId,
          uid: canonicalUid,
          userDisplayName: displayName,
          telegramUserId,
          amountEtb,
          requestDate: nowIso,
          provider: method,
          referenceCode: normalizedRef,
          ...(cleanProof ? { receiptProof: cleanProof } : {}),
          status: 'Pending',
          reviewNotes,
          demoSandboxOnly: true,
        });
        tx.set(
          playerRef,
          {
            pendingAction: null,
            pendingMethod: null,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        return {
          ok: true,
          deposit: {
            depositId,
            amountEtb,
            provider: method,
            referenceCode: normalizedRef,
            ...(cleanProof ? { receiptProof: cleanProof } : {}),
            reviewNotes,
            status: 'Pending' as const,
            requestDate: nowIso,
          },
        };
      });
    },

    async listPlayerDepositRequests(telegramUserId: number): Promise<BotDepositRequestView[]> {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const snap = await depositsCol.where('uid', '==', canonicalUid).get();
      return snap.docs
        .map((d) => {
          const data = d.data() || {};
          return {
            depositId: String(data.depositId || d.id),
            amountEtb: Number(data.amountEtb ?? 0),
            provider: String(data.provider || 'Telebirr (Demo)'),
            referenceCode: String(data.referenceCode || d.id),
            ...(typeof data.receiptProof === 'string' ? { receiptProof: data.receiptProof } : {}),
            ...(typeof data.reviewNotes === 'string' ? { reviewNotes: data.reviewNotes } : {}),
            status: (data.status === 'Approved' || data.status === 'Rejected'
              ? data.status
              : 'Pending') as 'Pending' | 'Approved' | 'Rejected',
            requestDate: String(data.requestDate || ''),
          };
        })
        .sort((a, b) => b.requestDate.localeCompare(a.requestDate))
        .slice(0, 6);
    },

    async createDemoWithdrawalRequest({ telegramUserId, method, amountEtb }) {
      assertValidTelegramUserId(telegramUserId);
      if (!Number.isFinite(amountEtb) || amountEtb < 20 || amountEtb > 50000) {
        return { ok: false, reason: 'invalid_withdraw_amount' };
      }
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const userRef = usersCol.doc(canonicalUid);
      const playerRef = playersCol.doc(String(telegramUserId));
      const requestId = `PO-BOT-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const payoutRef = payoutsCol.doc(requestId);
      const txId = `tx_wdr_${requestId}`;

      return await db.runTransaction(async (tx) => {
        const [userSnap, playerSnap] = await Promise.all([
          tx.get(userRef),
          tx.get(playerRef),
        ]);
        // Never fabricate balance for missing accounts
        const availableBal = userSnap.exists
          ? Math.max(0, Number(userSnap.get('demoBalanceEtb') ?? 0))
          : playerSnap.exists
            ? Math.max(0, Number(playerSnap.get('demoBalanceEtb') ?? 0))
            : 0;
        if (amountEtb > availableBal) {
          return {
            ok: false,
            reason: 'insufficient_demo_balance',
            availableBalanceEtb: availableBal,
          };
        }
        const nextBalance = Number(Math.max(0, availableBal - amountEtb).toFixed(2));
        const displayName = String(
          userSnap.get('displayName') || playerSnap.get('firstName') || `TG #${telegramUserId}`
        );
        const nowIso = new Date().toISOString();
        const maskedDest = String(
          playerSnap.get('verifiedPhoneMasked') || `TG #${telegramUserId}`
        );

        // Atomically hold/deduct balance in BOTH users and botPlayers to prevent concurrent double-spend
        if (userSnap.exists) {
          tx.update(userRef, {
            demoBalanceEtb: nextBalance,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(userRef, {
            uid: canonicalUid,
            telegramUserId: canonicalUid,
            displayName: displayName.slice(0, 80),
            username: `@${String(playerSnap.get('username') || canonicalUid).replace(/^@/, '')}`.slice(0, 64),
            language: playerSnap.get('language') === 'en' ? 'en' : 'am',
            phoneVerified: Boolean(playerSnap.get('phoneVerified')),
            demoBalanceEtb: nextBalance,
            referralCode: `ADEY-${telegramUserId}`,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(
          playerRef,
          {
            demoBalanceEtb: nextBalance,
            pendingAction: null,
            pendingMethod: null,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: canonicalUid,
          type: 'withdraw_demo',
          amountEtb: -amountEtb,
          balanceBeforeEtb: availableBal,
          balanceAfterEtb: nextBalance,
          status: 'demo_pending',
          description: `Demo Withdrawal Hold (${method})`,
          reference: requestId,
          relatedId: requestId,
          idempotencyKey: txId,
          createdAt: nowIso,
        });

        tx.set(payoutRef, {
          requestId,
          uid: canonicalUid,
          userDisplayName: displayName,
          telegramUserId,
          requestedAmountEtb: amountEtb,
          requestDate: nowIso,
          paymentMethod: method,
          destinationMasked: maskedDest,
          status: 'Pending',
          reviewNotes: 'Submitted via @AdeyBingoGameBot (Demo Sandbox)',
          demoSandboxOnly: true,
          fundsHeldAtSubmission: true,
          auditTrail: [
            {
              timestamp: nowIso,
              fromStatus: 'Created',
              toStatus: 'Pending',
              reviewedBy: `player:${telegramUserId}`,
              notes: 'Demo withdrawal requested in Telegram Bot (funds held atomically)',
            },
          ],
        });

        return {
          ok: true,
          updatedBalanceEtb: nextBalance,
          withdrawal: {
            requestId,
            requestedAmountEtb: amountEtb,
            paymentMethod: method,
            status: 'Pending' as const,
            requestDate: nowIso,
            reviewNotes: 'Submitted via @AdeyBingoGameBot (Demo Sandbox)',
          },
        };
      });
    },

    async listPlayerWithdrawalRequests(telegramUserId: number): Promise<BotWithdrawalRequestView[]> {
      assertValidTelegramUserId(telegramUserId);
      const canonicalUid = getTelegramFirebaseUid(telegramUserId);
      const snap = await payoutsCol.where('uid', '==', canonicalUid).get();
      return snap.docs
        .map((d) => {
          const data = d.data() || {};
          const st = data.status;
          const validStatus =
            st === 'Under Review' ||
            st === 'Approved' ||
            st === 'Rejected' ||
            st === 'Completed'
              ? st
              : 'Pending';
          return {
            requestId: String(data.requestId || d.id),
            requestedAmountEtb: Number(data.requestedAmountEtb ?? 0),
            paymentMethod: String(data.paymentMethod || 'Telebirr (Demo)'),
            status: validStatus as BotWithdrawalRequestView['status'],
            requestDate: String(data.requestDate || ''),
            reviewNotes: String(data.reviewNotes || ''),
          };
        })
        .sort((a, b) => b.requestDate.localeCompare(a.requestDate))
        .slice(0, 6);
    },

    async getLeaderboard(limit = 10): Promise<BotLeaderboardEntry[]> {
      const winGamesSnap = await gamesCol.where('status', '==', 'completed').get();
      const winTxSnap = await transactionsCol.where('type', '==', 'bingo_win').get();

      const agg = new Map<
        string,
        { uid: string; displayName: string; wins: number; winningsEtb: number }
      >();

      for (const docSnap of winGamesSnap.docs) {
        const d = docSnap.data() || {};
        const uid = String(d.winnerUid || '');
        if (!uid) continue;
        const entry = agg.get(uid) || {
          uid,
          displayName: String(d.winnerName || uid),
          wins: 0,
          winningsEtb: 0,
        };
        entry.wins += 1;
        agg.set(uid, entry);
      }

      for (const txSnap of winTxSnap.docs) {
        const d = txSnap.data() || {};
        const uid = String(d.userId || '');
        if (!uid) continue;
        const entry = agg.get(uid) || {
          uid,
          displayName: uid,
          wins: 0,
          winningsEtb: 0,
        };
        entry.winningsEtb += Math.max(0, Number(d.amountEtb ?? 0));
        if (entry.wins === 0) entry.wins = 1;
        agg.set(uid, entry);
      }

      const list: BotLeaderboardEntry[] = [];
      for (const entry of agg.values()) {
        const tgMatch = /^tg_([1-9]\d*)$/.exec(entry.uid);
        const tgId = tgMatch ? Number(tgMatch[1]) : 0;
        let displayName = entry.displayName;
        if (displayName === entry.uid) {
          const uSnap = await usersCol.doc(entry.uid).get();
          if (uSnap.exists && uSnap.get('displayName')) {
            displayName = String(uSnap.get('displayName'));
          }
        }
        list.push({
          uid: entry.uid,
          telegramUserId: tgId,
          displayName,
          wins: entry.wins,
          winningsEtb: entry.winningsEtb,
        });
      }

      list.sort((a, b) => b.wins - a.wins || b.winningsEtb - a.winningsEtb);
      return list.slice(0, Math.max(1, Math.min(20, limit)));
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
      const normalizedDigits = verifiedPhoneNumber.replace(/[^\d]/g, '');
      const bindingRef = bindingsCol.doc(telegramKey);
      const phoneBindingRef = db.collection('phoneBindings').doc(normalizedDigits || 'invalid');
      const playerRef = playersCol.doc(String(telegramUserId));
      const userRef = usersCol.doc(uid);
      const contactRef = userRef.collection('private').doc('contact');

      return await db.runTransaction(async (tx) => {
        const [bindingSnap, phoneBindingSnap, playerSnap, userSnap, contactSnap] = await Promise.all([
          tx.get(bindingRef),
          tx.get(phoneBindingRef),
          tx.get(playerRef),
          tx.get(userRef),
          tx.get(contactRef),
        ]);

        if (bindingSnap.exists && bindingSnap.get('uid') !== uid) {
          return { ok: false, reason: 'duplicate_telegram_account' as const };
        }

        if (phoneBindingSnap.exists && phoneBindingSnap.get('uid') !== uid) {
          return { ok: false, reason: 'duplicate_phone_number' as const };
        }

        if (contactSnap.exists && contactSnap.get('phoneVerified') === true) {
          const existingPhoneDigits = String(contactSnap.get('phoneNumber') || '').replace(/[^\d]/g, '');
          if (existingPhoneDigits && normalizedDigits && existingPhoneDigits !== normalizedDigits) {
            return { ok: false, reason: 'verified_contact_locked' as const };
          }
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
            ? Number(userSnap.get('demoBalanceEtb') ?? 0)
            : existingPlayer?.demoBalanceEtb ?? 15,
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

        if (normalizedDigits && !phoneBindingSnap.exists) {
          tx.set(phoneBindingRef, {
            phoneKey: normalizedDigits,
            uid,
            telegramUserId,
            maskedPhone,
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
            demoBalanceEtb: 15,
            referralCode: player.referralCode,
            referralsCount: 0,
            registeredAt: player.registeredAt,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          const initTxId = `tx_init_${uid}`;
          tx.set(transactionsCol.doc(initTxId), {
            transactionId: initTxId,
            userId: uid,
            type: 'deposit_demo',
            amountEtb: 15,
            balanceBeforeEtb: 0,
            balanceAfterEtb: 15,
            status: 'demo_completed',
            description: 'Initial Account Balance (+15 ETB)',
            reference: `ADB-INIT-${telegramUserId}`,
            relatedId: uid,
            idempotencyKey: initTxId,
            createdAt: nowIso,
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
        ? Number(userSnap.get('demoBalanceEtb') ?? 0)
        : playerSnap.exists
          ? Number(playerSnap.get('demoBalanceEtb') ?? 0)
          : 0;

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
      const winTxs = userTxDocs.filter((t) => t.type === 'bingo_win');
      const demoWinningsEtb = winTxs.reduce((sum, t) => sum + Math.max(0, t.amountEtb), 0);
      const totalWins = Math.max(winTxs.length, gamesSnap.size);
      const gamesPlayed = Math.max(
        entryTxCount,
        totalWins,
        userSnap.exists ? Number(userSnap.get('gamesPlayed') ?? 0) : 0
      );

      const recentGames: PlayerGameRoundRecord[] = gamesSnap.docs.map((d) => {
        const data = d.data() || {};
        return {
          gameId: String(data.gameId || d.id),
          roomId: String(data.roomId || 'adey-main'),
          cardId: Number(data.winningCardId ?? 0),
          pattern: String(data.winningPattern || 'Line Win'),
          amountEtb: Number(data.demoPrizeEtb ?? 0),
          playedAt: String(data.completedAt || data.updatedAt || ''),
        };
      });

      return {
        balanceEtb,
        demoWinningsEtb,
        gamesPlayed,
        totalWins,
        referralCount: refSnap.size,
        recentHistory: userTxDocs.slice(0, 6),
        recentGames: recentGames.slice(0, 6),
      };
    },

    async getBotCustomConfig(): Promise<Partial<BotAdminConfig> | null> {
      const snap = await botConfigCol.doc('default').get();
      if (!snap.exists) return null;
      const rawData = (snap.data() || {}) as Partial<BotAdminConfig>;
      if (isDisallowedMiniAppPreviewUrl(rawData.miniAppUrl)) {
        // Auto-heal stale Google AI Studio preview URL stored in Firestore botConfig/default
        await botConfigCol
          .doc('default')
          .set({ miniAppUrl: DEFAULT_DEPLOYED_MINI_APP_URL }, { merge: true })
          .catch(() => {});
        return {
          ...rawData,
          miniAppUrl: DEFAULT_DEPLOYED_MINI_APP_URL,
        };
      }
      return {
        ...rawData,
        miniAppUrl: sanitizeProductionMiniAppUrl(rawData.miniAppUrl),
      };
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
    this.miniAppUrl = sanitizeProductionMiniAppUrl(miniAppUrl);
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
      firstName: rawFirstName,
      lastName: rawLastName,
      username: rawUsername,
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
    const firstName = rawFirstName?.trim() || existingPlayer?.firstName || 'Adey Player';
    const lastName =
      rawLastName !== undefined ? rawLastName : existingPlayer?.lastName || '';
    const username =
      rawUsername?.trim() || existingPlayer?.username || `tg_${senderTelegramId}`;
    const currentLang: Language = existingPlayer?.language || 'am';
    const customButtons = customConfig?.buttonLabels;
    const effectiveMiniAppUrl = sanitizeProductionMiniAppUrl(
      customConfig?.miniAppUrl || this.miniAppUrl
    );

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
        const failReason = persisted.reason || 'duplicate_telegram_account';
        const isDuplicatePhone = failReason === 'duplicate_phone_number';
        const isLockedContact = failReason === 'verified_contact_locked';
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text: isDuplicatePhone
            ? currentLang === 'am'
              ? '🚫 ይህ ስልክ ቁጥር ቀደም ብሎ በሌላ የADEYBINGO መለያ ላይ ተረጋግጧል።'
              : '🚫 This phone number is already verified on another ADEYBINGO account.'
            : isLockedContact
              ? currentLang === 'am'
                ? '🔒 የተረጋገጠው ስልክ ቁጥርዎ ተቆልፏል እና በሌላ ቁጥር ሊተካ አይችልም።'
                : '🔒 Your verified phone contact is locked and cannot be overwritten with a different number.'
              : currentLang === 'am'
                ? '🚫 ይህ የቴሌግራም መለያ ቀደም ብሎ ከሌላ የADEYBINGO መለያ ጋር ተገናኝቷል።'
                : '🚫 This Telegram account is already bound to another ADEYBINGO account.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons
          ),
          registrationStatus: isLockedContact ? 'verified' : 'duplicate_blocked',
          securityCode: failReason,
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
                '🎱 ከታች ያለውን *🎱 ቢንጎ ይጫወቱ* ቁልፍ በመጫን ADEYBINGO ሚኒ አፕን ይክፈቱ!',
              ].join('\n')
            : [
                '✅ *Phone & Telegram Account Verified!*',
                '',
                `• Verified Phone: \`${maskedPhone}\``,
                `• Demo Sandbox Balance: *${persisted.player.demoBalanceEtb.toFixed(2)} ETB (Demo)*`,
                '',
                '🎱 Tap *🎱 Play Bingo* below to launch the ADEYBINGO Mini App!',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          persisted.player.language,
          effectiveMiniAppUrl,
          true,
          customButtons,
          'welcome'
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
          customButtons,
          'welcome'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: check.reason || 'plain_text_phone_rejected',
        profile: existingPlayer ?? undefined,
      };
    }

    // 3. Language selection & switching (`lang:am`, `lang:en`, `cb:language`, `🌐 ቋንቋ`, `🌐 Language`, `/language`)
    if (
      cleanCallback === 'lang:am' ||
      cleanCallback === 'lang:en' ||
      trimmed === '🇪🇹 አማርኛ' ||
      trimmed === '🇬🇧 English'
    ) {
      const nextLang: Language =
        cleanCallback === 'lang:en' || trimmed === '🇬🇧 English' ? 'en' : 'am';
      await this.store.setLanguage(senderTelegramId, nextLang);

      return {
        ok: true,
        chatId: senderTelegramId,
        language: nextLang,
        text:
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
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          nextLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
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
      cleanCallback === 'cb:language' ||
      trimmed === '/language' ||
      trimmed === '🌐 ቋንቋ' ||
      trimmed === '🌐 Language' ||
      trimmed === '🌐 Change Language' ||
      trimmed === '🌐 ቋንቋ ቀይር' ||
      (customButtons?.languageAm && trimmed === customButtons.languageAm) ||
      (customButtons?.languageEn && trimmed === customButtons.languageEn)
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
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'language'
        ),
        registrationStatus: existingPlayer?.phoneVerified
          ? 'verified'
          : existingPlayer
          ? 'pending_contact'
          : 'unregistered',
        securityCode: 'callback_language',
        profile: existingPlayer ?? undefined,
      };
    }

    // 4. /start command (requires private 1-on-1 Telegram DM; supports /start <refCode>) & cb:main_menu
    const isStartCommand = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(trimmed);
    if (isStartCommand || cleanCallback === 'cb:main_menu') {
      if (isStartCommand && !isPrivateChat) {
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
            customButtons,
            'welcome'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'unregistered',
          securityCode: 'private_chat_required',
          profile: existingPlayer ?? undefined,
        };
      }

      const isNewUser = !existingPlayer;
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
          replyMarkup: buildBotMainMenuMarkup(currentLang, effectiveMiniAppUrl, false, customButtons, 'welcome'),
          registrationStatus: 'duplicate_blocked',
          securityCode: 'duplicate_telegram_account',
        };
      }

      if (this.store.setPendingFlow && existingPlayer?.pendingAction) {
        await this.store.setPendingFlow(senderTelegramId, null, null);
      }

      let referralNoticeAm = '';
      let referralNoticeEn = '';
      let inviterNotification: BotNotificationMessage | undefined;
      const referralCodeParam = extractStartCommandReferralCode(trimmed);
      if (referralCodeParam && this.store.processReferralDeepLink) {
        const refMatch = /^ADEY-([1-9]\d*)$/i.exec(referralCodeParam);
        const targetInviterId = refMatch ? Number(refMatch[1]) : 0;
        if (targetInviterId === senderTelegramId) {
          referralNoticeAm = '\n\n⚠️ _የራስዎን የግብዣ ሊንክ መጠቀም አይችሉም።_';
          referralNoticeEn = '\n\n⚠️ _Self-referrals are not permitted._';
        } else if (!isNewUser) {
          referralNoticeAm =
            '\n\nℹ️ _መለያዎ ቀደም ብሎ ተመዝግቧል — የግብዣ ሽልማት ለአዲስ ተጫዋቾች በመጀመሪያ ምዝገባ ብቻ ይሰጣል።_';
          referralNoticeEn =
            '\n\nℹ️ _Your account is already registered — referral rewards apply only once for new players._';
        } else {
          const refRes = await this.store.processReferralDeepLink({
            inviteeTelegramId: senderTelegramId,
            inviteeName: saved.player.firstName,
            inviteeUsername: saved.player.username,
            referralCode: referralCodeParam,
          });
          if (refRes.applied && refRes.inviterTelegramId) {
            if (typeof refRes.inviteeBalanceEtb === 'number') {
              saved.player.demoBalanceEtb = refRes.inviteeBalanceEtb;
            }
            inviterNotification = await this.queueNotification(
              'referral_confirmation',
              refRes.inviterTelegramId,
              {
                friendName: saved.player.firstName,
                inviterBonusEtb: refRes.inviterBonusEtb ?? 20,
              }
            );
            referralNoticeAm = `\n\n🎁 _በጓደኛ ግብዣ ተመዝግበዋል! የመጀመሪያ 15.00 ETB ሂሳብዎ ዝግጁ ነው (ጋባዥዎ +${refRes.inviterBonusEtb ?? 20}.00 ETB አግኝቷል)።_`;
            referralNoticeEn = `\n\n🎁 _Welcome via friend invitation! Your 15.00 ETB initial balance is ready (your inviter earned +${refRes.inviterBonusEtb ?? 20}.00 ETB)._`;
          } else if (refRes.reason === 'self_referral') {
            referralNoticeAm = '\n\n⚠️ _የራስዎን የግብዣ ሊንክ መጠቀም አይችሉም።_';
            referralNoticeEn = '\n\n⚠️ _Self-referrals are not permitted._';
          }
        }
      }

      const player = saved.player;
      const customWelcome =
        player.language === 'am'
          ? customConfig?.customWelcomeAm
          : customConfig?.customWelcomeEn;

      const coreWelcomeAm = isNewUser
        ? [
            '🎱 እንኳን ወደ ADEYBINGO በደህና መጡ!',
            '',
            `ሰላም *${player.firstName}*! የመጀመሪያ *15.00 ETB* የሙከራ ሂሳብዎ ተዘጋጅቷል።`,
            'ለመቀላቀል፦ *🎱 ቢንጎ ይጫወቱ* በመጫን የሚኒ አፕ ክፍል ይምረጡ፣ ሰዓቱ ከማለቁ በፊት 1–4 ካርድ ይያዙ እና በቀጥታ ይጫወቱ!',
            '',
            'ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ።',
          ].join('\n')
        : [
            '🎱 እንኳን ወደ ADEYBINGO በደህና መጡ!',
            '',
            `እንኳን በደህና ተመለሱ *${player.firstName}*! የእርስዎ ቀሪ ሂሳብ *${player.demoBalanceEtb.toFixed(2)} ETB* ነው።`,
            'ቢንጎ ይጫወቱ፣ የቦርሳዎን መረጃ ይመልከቱ፣ ጓደኞችዎን ይጋብዙ እና በጨዋታው ይደሰቱ!',
            '',
            'ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ።',
          ].join('\n');

      const coreWelcomeEn = isNewUser
        ? [
            '🎱 Welcome to ADEYBINGO!',
            '',
            `Hello *${player.firstName}*! Your *15.00 ETB* initial balance is ready.`,
            'How to join: Tap *🎱 Play Bingo* to open the Mini App, choose a room, reserve 1–4 cards before the timer ends, and play live!',
            '',
            'Choose an option below to get started.',
          ].join('\n')
        : [
            '🎱 Welcome to ADEYBINGO!',
            '',
            `Welcome back, *${player.firstName}*! Your current balance is *${player.demoBalanceEtb.toFixed(2)} ETB*.`,
            'Play live Bingo, manage your wallet, invite friends, and enjoy the game!',
            '',
            'Choose an option below to get started.',
          ].join('\n');

      const privacyNoteAm = player.phoneVerified
        ? ''
        : '\n\n🔒 _መለያዎን ለማረጋገጥ ከታች ያለውን 📲 ስልክ ቁጥርዎን ያጋሩ ቁልፍ ይጫኑ።_';
      const privacyNoteEn = player.phoneVerified
        ? ''
        : '\n\n🔒 _Tap 📲 Share Telegram Phone Contact below to verify your account._';

      const startText =
        player.language === 'am'
          ? `${coreWelcomeAm}${customWelcome ? `\n\n${customWelcome}` : ''}${referralNoticeAm}${privacyNoteAm}`
          : `${coreWelcomeEn}${customWelcome ? `\n\n${customWelcome}` : ''}${referralNoticeEn}${privacyNoteEn}`;

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
          customButtons,
          'welcome'
        ),
        registrationStatus: player.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: cleanCallback === 'cb:main_menu' ? 'callback_main_menu' : 'start_welcome_delivered',
        callbackAnswerText:
          cleanCallback === 'cb:main_menu'
            ? player.language === 'am'
              ? '🏠 ዋና ሜኑ'
              : '🏠 Main Menu'
            : undefined,
        profile: player,
        ...(inviterNotification ? { inviterNotification } : {}),
      };
    }

    // Use existing player record without fabricating accounts or initial credits on non-/start commands
    const activePlayer = existingPlayer;

    // 4B. Pending amount input for Demo Deposit or Demo Withdrawal
    if (
      existingPlayer?.pendingAction &&
      !cleanCallback &&
      !trimmed.startsWith('/') &&
      /^\d+(?:\.\d{1,2})?$/.test(trimmed)
    ) {
      const amount = Number(trimmed);
      const method = existingPlayer.pendingMethod || 'Telebirr (Demo)';
      if (existingPlayer.pendingAction === 'deposit_amount' && this.store.createDemoDepositRequest) {
        const depRes = await this.store.createDemoDepositRequest({
          telegramUserId: senderTelegramId,
          method,
          amountEtb: amount,
        });
        if (depRes.ok && depRes.deposit) {
          return {
            ok: true,
            chatId: senderTelegramId,
            language: currentLang,
            text:
              currentLang === 'am'
                ? [
                    '✅ *የሙከራ ገንዘብ ማስገቢያ ጥያቄ ተመዝግቧል!*',
                    '',
                    `• የጥያቄ መለያ፦ \`${depRes.deposit.depositId}\``,
                    `• የማጣቀሻ ኮድ፦ \`${depRes.deposit.referenceCode}\``,
                    `• መንገድ፦ *${depRes.deposit.provider}*`,
                    `• መጠን፦ *${depRes.deposit.amountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• ሁኔታ፦ *Pending (በመጠባበቅ ላይ)*',
                  ].join('\n')
                : [
                    '✅ *Demo Deposit Request Submitted!*',
                    '',
                    `• Request ID: \`${depRes.deposit.depositId}\``,
                    `• Reference: \`${depRes.deposit.referenceCode}\``,
                    `• Method: *${depRes.deposit.provider}*`,
                    `• Amount: *${depRes.deposit.amountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• Status: *Pending Review*',
                  ].join('\n'),
            parseMode: 'Markdown',
            replyMarkup: buildBotMainMenuMarkup(
              currentLang,
              effectiveMiniAppUrl,
              Boolean(existingPlayer.phoneVerified),
              customButtons,
              'deposit'
            ),
            registrationStatus: existingPlayer.phoneVerified ? 'verified' : 'pending_contact',
            securityCode: 'deposit_request_created',
            profile: existingPlayer,
          };
        }
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? '⚠️ እባክዎ ከ *10 ETB* እስከ *10,000 ETB* መካከል ትክክለኛ የሙከራ መጠን ያስገቡ።'
              : '⚠️ Please enter a valid Demo deposit amount between *10 ETB* and *10,000 ETB*.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer.phoneVerified),
            customButtons,
            'deposit'
          ),
          registrationStatus: existingPlayer.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'invalid_deposit_amount',
          profile: existingPlayer,
        };
      }

      if (existingPlayer.pendingAction === 'withdraw_amount' && this.store.createDemoWithdrawalRequest) {
        const wdrRes = await this.store.createDemoWithdrawalRequest({
          telegramUserId: senderTelegramId,
          method,
          amountEtb: amount,
        });
        if (wdrRes.ok && wdrRes.withdrawal) {
          return {
            ok: true,
            chatId: senderTelegramId,
            language: currentLang,
            text:
              currentLang === 'am'
                ? [
                    '✅ *የሙከራ ገንዘብ ማውጫ ጥያቄ ተመዝግቧል!*',
                    '',
                    `• የጥያቄ መለያ፦ \`${wdrRes.withdrawal.requestId}\``,
                    `• መንገድ፦ *${wdrRes.withdrawal.paymentMethod}*`,
                    `• መጠን፦ *${wdrRes.withdrawal.requestedAmountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• ሁኔታ፦ *Pending (በግምገማ ላይ)*',
                  ].join('\n')
                : [
                    '✅ *Demo Withdrawal Request Submitted!*',
                    '',
                    `• Request ID: \`${wdrRes.withdrawal.requestId}\``,
                    `• Method: *${wdrRes.withdrawal.paymentMethod}*`,
                    `• Amount: *${wdrRes.withdrawal.requestedAmountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• Status: *Pending Review*',
                  ].join('\n'),
            parseMode: 'Markdown',
            replyMarkup: buildBotMainMenuMarkup(
              currentLang,
              effectiveMiniAppUrl,
              Boolean(existingPlayer.phoneVerified),
              customButtons,
              'withdraw'
            ),
            registrationStatus: existingPlayer.phoneVerified ? 'verified' : 'pending_contact',
            securityCode: 'withdraw_request_created',
            profile: existingPlayer,
          };
        }
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            wdrRes.reason === 'insufficient_demo_balance'
              ? currentLang === 'am'
                ? `⚠️ በቂ የሙከራ ቀሪ ሂሳብ የለም። የሚገኝ ቀሪ ሂሳብ፦ *${Number(wdrRes.availableBalanceEtb ?? 0).toFixed(2)} ETB (DEMO)*።`
                : `⚠️ Insufficient Demo balance. Available Demo balance: *${Number(wdrRes.availableBalanceEtb ?? 0).toFixed(2)} ETB (DEMO)*.`
              : currentLang === 'am'
                ? '⚠️ ዝቅተኛው የሙከራ ወጪ መጠን *20.00 ETB (DEMO)* ነው።'
                : '⚠️ Minimum Demo withdrawal amount is *20.00 ETB (DEMO)*.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer.phoneVerified),
            customButtons,
            'withdraw'
          ),
          registrationStatus: existingPlayer.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: wdrRes.reason || 'invalid_withdraw_amount',
          profile: existingPlayer,
        };
      }
    }

    // 5. cb:play_bingo callback / Play Bingo button
    if (
      cleanCallback === 'cb:play_bingo' ||
      cleanCallback === 'menu:play_bingo' ||
      trimmed === '🎱 ቢንጎ ይጫወቱ' ||
      trimmed === '🎱 Play Bingo' ||
      trimmed === '🎮 Play Bingo' ||
      trimmed === '🎮 Start Playing' ||
      trimmed === '🎮 ቢንጎ ይጫወቱ' ||
      (customButtons?.playBingoAm && trimmed === customButtons.playBingoAm) ||
      (customButtons?.playBingoEn && trimmed === customButtons.playBingoEn)
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '🎱 *ADEYBINGO ሚኒ አፕ ለመክፈት ዝግጁ ነው!*',
                '',
                `• የሚኒ አፕ አድራሻ፦ \`${effectiveMiniAppUrl}\``,
                '• ከታች ያለውን *🎱 ቢንጎ ይጫወቱ* ቁልፍ በመጫን ወደ ጨዋታ ክፍሎች ይግቡ።',
              ].join('\n')
            : [
                '🎱 *ADEYBINGO Mini App Ready!*',
                '',
                `• Mini App URL: \`${effectiveMiniAppUrl}\``,
                '• Tap the *🎱 Play Bingo* button below to enter the live Bingo rooms.',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'play'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_play_bingo',
        profile: existingPlayer ?? undefined,
      };
    }

    // Fetch real Firestore stats & history for wallet, profile, referrals, and game history callbacks
    const statsAndHistory: PlayerBotStatsAndHistory = this.store.getPlayerStatsAndHistory
      ? await this.store.getPlayerStatsAndHistory(senderTelegramId)
      : {
          balanceEtb: activePlayer?.demoBalanceEtb ?? 0,
          demoWinningsEtb: 0,
          gamesPlayed: 0,
          totalWins: 0,
          referralCount: 0,
          recentHistory: [],
          recentGames: [],
        };

    // 6. My Wallet (`cb:my_wallet`, `cb:wallet_refresh`, `cb:wallet_history`, `💰 የእኔ ቦርሳ`, `💰 My Wallet`, `/wallet`)
    if (
      cleanCallback === 'cb:my_wallet' ||
      cleanCallback === 'cb:wallet_refresh' ||
      cleanCallback === 'cb:wallet_history' ||
      cleanCallback === 'menu:my_balance' ||
      trimmed === '/wallet' ||
      trimmed === '💰 My Wallet' ||
      trimmed === '💰 My Balance' ||
      trimmed === '💰 የእኔ ቦርሳ' ||
      (customButtons?.myWalletAm && trimmed === customButtons.myWalletAm) ||
      (customButtons?.myWalletEn && trimmed === customButtons.myWalletEn)
    ) {
      if (cleanCallback === 'cb:wallet_history') {
        const txLines =
          statsAndHistory.recentHistory.length > 0
            ? statsAndHistory.recentHistory.map((item, idx) => {
                const sign = item.amountEtb >= 0 ? '+' : '';
                return `${idx + 1}. \`${item.reference}\` — *${sign}${item.amountEtb.toFixed(2)} ETB* (${item.description})`;
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
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'wallet'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_wallet_history',
          callbackAnswerText:
            currentLang === 'am' ? '📋 የግብይት ታሪክ ተከፍቷል' : '📋 Transaction history loaded',
          profile: existingPlayer ?? undefined,
        };
      }

      const bal = statsAndHistory.balanceEtb;
      const recentTxSummary =
        statsAndHistory.recentHistory.length > 0
          ? statsAndHistory.recentHistory.slice(0, 3).map((tx) => {
              const sign = tx.amountEtb >= 0 ? '+' : '';
              return `  • \`${tx.reference}\`: *${sign}${tx.amountEtb.toFixed(2)} ETB*`;
            })
          : [
              currentLang === 'am'
                ? '  • ምንም የቅርብ ጊዜ ግብይት የለም'
                : '  • No recent transactions recorded',
            ];

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '💰 *የADEYBINGO የሙከራ ቦርሳ (My Wallet)*',
                '',
                `• የሚገኝ የሙከራ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (DEMO)*`,
                `• ጠቅላላ የቢንጎ ሽልማቶች፦ *${statsAndHistory.demoWinningsEtb.toFixed(2)} ETB (DEMO)*`,
                `• የተሳተፉባቸው ዙሮች፦ *${statsAndHistory.gamesPlayed}* · ድሎች፦ *${statsAndHistory.totalWins}*`,
                '• የቅርብ ጊዜ ግብይቶች፦',
                ...recentTxSummary,
                '',
                'ℹ️ _ሁኔታ፦ Demo Sandbox (እውነተኛ የገንዘብ ክፍያ ዝግ ነው)_',
              ].join('\n')
            : [
                '💰 *ADEYBINGO Demo Wallet (My Wallet)*',
                '',
                `• Available Demo Balance: *${bal.toFixed(2)} ETB (DEMO)*`,
                `• Demo Winnings Balance: *${statsAndHistory.demoWinningsEtb.toFixed(2)} ETB (DEMO)*`,
                `• Rounds Played: *${statsAndHistory.gamesPlayed}* · Verified Wins: *${statsAndHistory.totalWins}*`,
                '• Recent Transactions:',
                ...recentTxSummary,
                '',
                'ℹ️ _Mode: Demo Sandbox (Real-money payments disabled)_',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'wallet'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode:
          cleanCallback === 'cb:wallet_refresh' ? 'callback_wallet_refresh' : 'callback_my_wallet',
        callbackAnswerText:
          cleanCallback === 'cb:wallet_refresh'
            ? currentLang === 'am'
              ? '🔄 ቦርሳዎ ታድሷል'
              : '🔄 Wallet refreshed'
            : undefined,
        profile: existingPlayer ?? undefined,
      };
    }

    // 7. Demo Deposit (`➕ ገንዘብ ያስገቡ`, `➕ Deposit`, `/deposit`, `cb:deposit*`)
    if (
      trimmed === '➕ ገንዘብ ያስገቡ' ||
      trimmed === '➕ Deposit' ||
      trimmed === '/deposit' ||
      (customButtons?.depositAm && trimmed === customButtons.depositAm) ||
      (customButtons?.depositEn && trimmed === customButtons.depositEn) ||
      cleanCallback === 'cb:deposit' ||
      cleanCallback === 'cb:deposit_status' ||
      cleanCallback.startsWith('cb:deposit_method:') ||
      cleanCallback.startsWith('cb:deposit_amount:')
    ) {
      if (cleanCallback === 'cb:deposit_status') {
        const deposits = this.store.listPlayerDepositRequests
          ? await this.store.listPlayerDepositRequests(senderTelegramId)
          : [];
        const lines =
          deposits.length > 0
            ? deposits.map(
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
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'deposit'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_deposit_status',
          profile: existingPlayer ?? undefined,
        };
      }

      if (cleanCallback.startsWith('cb:deposit_method:')) {
        const slug = cleanCallback.slice('cb:deposit_method:'.length);
        const method =
          slug === 'cbe_birr'
            ? 'CBE Birr (Demo)'
            : slug === 'chapa'
              ? 'Chapa Sandbox (Demo)'
              : 'Telebirr (Demo)';
        if (this.store.setPendingFlow) {
          await this.store.setPendingFlow(senderTelegramId, 'deposit_amount', method);
        }
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
                  'Select a preset amount below or type a Demo amount between 10 and 10,000 ETB.',
                  'ℹ️ _Demo Sandbox: Requests are tracked as Pending for admin review._',
                ].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'deposit'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_deposit_method',
          callbackAnswerText: method,
          profile: existingPlayer ?? undefined,
        };
      }

      if (cleanCallback.startsWith('cb:deposit_amount:')) {
        const amount = Number(cleanCallback.slice('cb:deposit_amount:'.length));
        const method = existingPlayer?.pendingMethod || 'Telebirr (Demo)';
        if (this.store.createDemoDepositRequest) {
          const depRes = await this.store.createDemoDepositRequest({
            telegramUserId: senderTelegramId,
            method,
            amountEtb: amount,
          });
          if (depRes.ok && depRes.deposit) {
            return {
              ok: true,
              chatId: senderTelegramId,
              language: currentLang,
              text:
                currentLang === 'am'
                  ? [
                      '✅ *የሙከራ ገንዘብ ማስገቢያ ጥያቄ ተመዝግቧል!*',
                      '',
                      `• የጥያቄ መለያ፦ \`${depRes.deposit.depositId}\``,
                      `• የማጣቀሻ ኮድ፦ \`${depRes.deposit.referenceCode}\``,
                      `• መንገድ፦ *${depRes.deposit.provider}*`,
                      `• መጠን፦ *${depRes.deposit.amountEtb.toFixed(2)} ETB (DEMO)*`,
                      '• ሁኔታ፦ *Pending (በመጠባበቅ ላይ)*',
                    ].join('\n')
                  : [
                      '✅ *Demo Deposit Request Submitted!*',
                      '',
                      `• Request ID: \`${depRes.deposit.depositId}\``,
                      `• Reference: \`${depRes.deposit.referenceCode}\``,
                      `• Method: *${depRes.deposit.provider}*`,
                      `• Amount: *${depRes.deposit.amountEtb.toFixed(2)} ETB (DEMO)*`,
                      '• Status: *Pending Review*',
                    ].join('\n'),
              parseMode: 'Markdown',
              replyMarkup: buildBotMainMenuMarkup(
                currentLang,
                effectiveMiniAppUrl,
                Boolean(existingPlayer?.phoneVerified),
                customButtons,
                'deposit'
              ),
              registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
              securityCode: 'deposit_request_created',
              callbackAnswerText: currentLang === 'am' ? '✅ ጥያቄው ተልኳል' : '✅ Request submitted',
              profile: activePlayer ?? undefined,
            };
          }
          return {
            ok: false,
            chatId: senderTelegramId,
            language: currentLang,
            text:
              currentLang === 'am'
                ? '⚠️ የሙከራ ገንዘብ ማስገቢያ መጠኑ ትክክል አይደለም (ከ10 እስከ 10,000 ETB ይምረጡ)።'
                : '⚠️ Invalid Demo deposit amount (please select between 10 and 10,000 ETB).',
            parseMode: 'Markdown',
            replyMarkup: buildBotMainMenuMarkup(
              currentLang,
              effectiveMiniAppUrl,
              Boolean(activePlayer?.phoneVerified),
              customButtons,
              'deposit'
            ),
            registrationStatus: activePlayer?.phoneVerified ? 'verified' : 'pending_contact',
            securityCode: depRes.reason || 'invalid_deposit_amount',
            profile: activePlayer ?? undefined,
          };
        }
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
                '• ከታች የክፍያ መንገድ ወይም መጠን ይምረጡ።',
                '',
                'ℹ️ _ማሳሰቢያ፦ እውነተኛ ክፍያዎች አልተከፈቱም፤ ሁሉም ጥያቄዎች በሙከራ (Demo Sandbox) ደረጃ ብቻ ናቸው።_',
              ].join('\n')
            : [
                '➕ *Demo Deposit Sandbox*',
                '',
                '• Configured Demo Methods: `Telebirr (Demo)` · `CBE Birr (Demo)` · `Chapa Sandbox (Demo)`',
                '• Select a Demo method or preset amount below to submit a tracked request.',
                '',
                'ℹ️ _Notice: Real-money deposits are disabled; all requests are Demo Sandbox only._',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'deposit'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_deposit',
        profile: existingPlayer ?? undefined,
      };
    }

    // 8. Demo Withdrawal (`💸 ገንዘብ ያውጡ`, `💸 Withdraw`, `/withdraw`, `cb:withdraw*`)
    if (
      trimmed === '💸 ገንዘብ ያውጡ' ||
      trimmed === '💸 Withdraw' ||
      trimmed === '/withdraw' ||
      (customButtons?.withdrawAm && trimmed === customButtons.withdrawAm) ||
      (customButtons?.withdrawEn && trimmed === customButtons.withdrawEn) ||
      cleanCallback === 'cb:withdraw' ||
      cleanCallback === 'cb:withdraw_status' ||
      cleanCallback.startsWith('cb:withdraw_method:') ||
      cleanCallback.startsWith('cb:withdraw_amount:')
    ) {
      if (cleanCallback === 'cb:withdraw_status') {
        const withdrawals = this.store.listPlayerWithdrawalRequests
          ? await this.store.listPlayerWithdrawalRequests(senderTelegramId)
          : [];
        const lines =
          withdrawals.length > 0
            ? withdrawals.map(
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
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'withdraw'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_withdraw_status',
          profile: existingPlayer ?? undefined,
        };
      }

      if (cleanCallback.startsWith('cb:withdraw_method:')) {
        const slug = cleanCallback.slice('cb:withdraw_method:'.length);
        const method = slug === 'cbe_birr' ? 'CBE Birr (Demo)' : 'Telebirr (Demo)';
        if (this.store.setPendingFlow) {
          await this.store.setPendingFlow(senderTelegramId, 'withdraw_amount', method);
        }
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? [
                  `💸 *የተመረጠው የወጪ መንገድ፦ ${method}*`,
                  `• የሚገኝ ቀሪ ሂሳብ፦ *${statsAndHistory.balanceEtb.toFixed(2)} ETB (DEMO)*`,
                  '• ከታች መጠን ይምረጡ ወይም ከ20 ETB ጀምሮ የሙከራ መጠን ይላኩ።',
                ].join('\n')
              : [
                  `💸 *Selected Withdrawal Method: ${method}*`,
                  `• Available Demo Balance: *${statsAndHistory.balanceEtb.toFixed(2)} ETB (DEMO)*`,
                  '• Choose a preset amount below or type an amount (min 20 ETB Demo).',
                ].join('\n'),
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'withdraw'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_withdraw_method',
          callbackAnswerText: method,
          profile: existingPlayer ?? undefined,
        };
      }

      if (cleanCallback.startsWith('cb:withdraw_amount:') && this.store.createDemoWithdrawalRequest) {
        const amount = Number(cleanCallback.slice('cb:withdraw_amount:'.length));
        const method = existingPlayer?.pendingMethod || 'Telebirr (Demo)';
        const wdrRes = await this.store.createDemoWithdrawalRequest({
          telegramUserId: senderTelegramId,
          method,
          amountEtb: amount,
        });
        if (wdrRes.ok && wdrRes.withdrawal) {
          return {
            ok: true,
            chatId: senderTelegramId,
            language: currentLang,
            text:
              currentLang === 'am'
                ? [
                    '✅ *የሙከራ ገንዘብ ማውጫ ጥያቄ ተመዝግቧል!*',
                    '',
                    `• የጥያቄ መለያ፦ \`${wdrRes.withdrawal.requestId}\``,
                    `• መንገድ፦ *${wdrRes.withdrawal.paymentMethod}*`,
                    `• መጠን፦ *${wdrRes.withdrawal.requestedAmountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• ሁኔታ፦ *Pending (በግምገማ ላይ)*',
                  ].join('\n')
                : [
                    '✅ *Demo Withdrawal Request Submitted!*',
                    '',
                    `• Request ID: \`${wdrRes.withdrawal.requestId}\``,
                    `• Method: *${wdrRes.withdrawal.paymentMethod}*`,
                    `• Amount: *${wdrRes.withdrawal.requestedAmountEtb.toFixed(2)} ETB (DEMO)*`,
                    '• Status: *Pending Review*',
                  ].join('\n'),
            parseMode: 'Markdown',
            replyMarkup: buildBotMainMenuMarkup(
              currentLang,
              effectiveMiniAppUrl,
              Boolean(existingPlayer?.phoneVerified),
              customButtons,
              'withdraw'
            ),
            registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
            securityCode: 'withdraw_request_created',
            callbackAnswerText: currentLang === 'am' ? '✅ የወጪ ጥያቄ ተልኳል' : '✅ Withdrawal submitted',
            profile: existingPlayer ?? undefined,
          };
        }
        return {
          ok: false,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            wdrRes.reason === 'insufficient_demo_balance'
              ? currentLang === 'am'
                ? `⚠️ በቂ የሙከራ ቀሪ ሂሳብ የለም። የሚገኝ ቀሪ ሂሳብ፦ *${Number(wdrRes.availableBalanceEtb ?? 0).toFixed(2)} ETB (DEMO)*።`
                : `⚠️ Insufficient Demo balance. Available Demo balance: *${Number(wdrRes.availableBalanceEtb ?? 0).toFixed(2)} ETB (DEMO)*.`
              : currentLang === 'am'
                ? '⚠️ ዝቅተኛው የሙከራ ወጪ መጠን *20.00 ETB (DEMO)* ነው።'
                : '⚠️ Minimum Demo withdrawal amount is *20.00 ETB (DEMO)*.',
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'withdraw'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: wdrRes.reason || 'insufficient_demo_balance',
          profile: existingPlayer ?? undefined,
        };
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
                `• የሚገኝ የሙከራ ቀሪ ሂሳብ፦ *${statsAndHistory.balanceEtb.toFixed(2)} ETB (DEMO)*`,
                '• የወጪ መንገድ እና መጠን ከታች ይምረጡ (ዝቅተኛው 20 ETB)።',
                '',
                'ℹ️ _ማሳሰቢያ፦ ይህ ጥያቄ በሙከራ (Demo Sandbox) ደረጃ ብቻ የሚመዘገብ ነው።_',
              ].join('\n')
            : [
                '💸 *Demo Withdrawal Sandbox*',
                '',
                `• Available Demo Balance: *${statsAndHistory.balanceEtb.toFixed(2)} ETB (DEMO)*`,
                '• Select a Demo payout method and amount below (minimum 20 ETB Demo).',
                '',
                'ℹ️ _Notice: Requests are logged strictly for Demo Sandbox review._',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'withdraw'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_withdraw',
        profile: existingPlayer ?? undefined,
      };
    }

    // 9. Invite Friends (`cb:invite_friends`, `cb:referral_copy`, `🎁 ጓደኞችን ይጋብዙ`, `🎁 Invite Friends`, `/invite`)
    if (
      cleanCallback === 'cb:invite_friends' ||
      cleanCallback === 'cb:referral_copy' ||
      cleanCallback === 'menu:invite_friends' ||
      trimmed === '/invite' ||
      trimmed === '🎁 ጓደኞችን ይጋብዙ' ||
      trimmed === '🎁 Invite Friends' ||
      trimmed === '👥 Invite Friends' ||
      trimmed === '👥 ጓደኞችን ይጋብዙ' ||
      (customButtons?.inviteFriendsAm && trimmed === customButtons.inviteFriendsAm) ||
      (customButtons?.inviteFriendsEn && trimmed === customButtons.inviteFriendsEn)
    ) {
      const refCode = activePlayer?.referralCode || buildTelegramReferralCode(senderTelegramId);
      const refLink = buildTelegramInviteLink(refCode);

      if (cleanCallback === 'cb:referral_copy') {
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? `📋 *የግብዣ ሊንክዎን ይቅዱ እና ለጓደኞችዎ ይላኩ፦*\n\`${refLink}\``
              : `📋 *Copy and share your personal referral link:*\n\`${refLink}\``,
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'referral',
            { referralLink: refLink }
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_referral_copy',
          callbackAnswerText:
            currentLang === 'am' ? '📋 የግብዣ ሊንክ ተዘጋጅቷል' : '📋 Referral link ready to copy',
          profile: existingPlayer ?? undefined,
        };
      }

      const earnedBonus = statsAndHistory.referralCount * 20;
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '🎁 *ጓደኞችን ይጋብዙ እና ቦነስ ያግኙ!*',
                '',
                `• የእርስዎ መጋበዣ ኮድ፦ \`${refCode}\``,
                `• የእርስዎ መጋበዣ ሊንክ፦ \`${refLink}\``,
                `• የተመዘገቡ ግብዣዎች፦ *${statsAndHistory.referralCount}* (*+${earnedBonus.toFixed(2)} ETB Demo*)`,
                '• ሽልማት፦ ለእርስዎ *+20.00 ETB* ለእያንዳንዱ አዲስ ተጫዋች · አዲስ ተጫዋች *15.00 ETB* መነሻ ሂሳብ',
              ].join('\n')
            : [
                '🎁 *Invite Friends to ADEYBINGO!*',
                '',
                `• Your Referral Code: \`${refCode}\``,
                `• Your Referral Link: \`${refLink}\``,
                `• Qualified Referrals: *${statsAndHistory.referralCount}* (*+${earnedBonus.toFixed(2)} ETB*)`,
                '• Reward: *+20.00 ETB* for you per new player · *15.00 ETB* initial credit for your friend',
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'referral',
          { referralLink: refLink }
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_invite_friends',
        profile: existingPlayer ?? undefined,
      };
    }

    // 10. Leaderboard (`🏆 የደረጃ ሰንጠረዥ`, `🏆 Leaderboard`, `/leaderboard`, `cb:leaderboard`)
    if (
      trimmed === '🏆 የደረጃ ሰንጠረዥ' ||
      trimmed === '🏆 Leaderboard' ||
      trimmed === '/leaderboard' ||
      (customButtons?.leaderboardAm && trimmed === customButtons.leaderboardAm) ||
      (customButtons?.leaderboardEn && trimmed === customButtons.leaderboardEn) ||
      cleanCallback === 'cb:leaderboard'
    ) {
      const leaders = this.store.getLeaderboard ? await this.store.getLeaderboard(10) : [];
      const lines =
        leaders.length > 0
          ? leaders.map((row, idx) => {
              const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
              return `${medal} *${row.displayName}* — *${row.wins}* ${
                currentLang === 'am' ? 'ድሎች' : 'wins'
              } (*${row.winningsEtb.toFixed(2)} ETB Demo*)`;
            })
          : [
              currentLang === 'am'
                ? '• እስካሁን የተመዘገቡ የጨዋታ አሸናፊዎች የሉም። በሚኒ አፑ ውስጥ የመጀመሪያ አሸናፊ ይሁኑ!'
                : '• No verified Bingo winners recorded yet. Join a live round in the Mini App to rank #1!',
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
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'leaderboard'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_leaderboard',
        profile: existingPlayer ?? undefined,
      };
    }

    // 11. My Profile (`cb:my_profile`, `cb:copy_telegram_id`, `👤 የእኔ መገለጫ`, `👤 My Profile`, `/profile`)
    if (
      cleanCallback === 'cb:my_profile' ||
      cleanCallback === 'cb:copy_telegram_id' ||
      cleanCallback === 'menu:my_profile' ||
      trimmed === '/profile' ||
      trimmed === '👤 የእኔ መገለጫ' ||
      trimmed === '👤 My Profile' ||
      trimmed === '👤 መገለጫዬ' ||
      (customButtons?.myProfileAm && trimmed === customButtons.myProfileAm) ||
      (customButtons?.myProfileEn && trimmed === customButtons.myProfileEn)
    ) {
      if (cleanCallback === 'cb:copy_telegram_id') {
        return {
          ok: true,
          chatId: senderTelegramId,
          language: currentLang,
          text:
            currentLang === 'am'
              ? `🪪 *የእርስዎ የቴሌግራም መለያ ቁጥር (Telegram ID)፦*\n\`${senderTelegramId}\``
              : `🪪 *Your Verified Telegram ID:*\n\`${senderTelegramId}\``,
          parseMode: 'Markdown',
          replyMarkup: buildBotMainMenuMarkup(
            currentLang,
            effectiveMiniAppUrl,
            Boolean(existingPlayer?.phoneVerified),
            customButtons,
            'profile'
          ),
          registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
          securityCode: 'callback_copy_telegram_id',
          callbackAnswerText: `ID: ${senderTelegramId}`,
          profile: existingPlayer ?? undefined,
        };
      }

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
                '👤 *የእኔ መገለጫ (My Profile)*',
                '',
                `• ስም፦ *${pName}* (@${pUser})`,
                `• የቴሌግራም መለያ፦ \`TG #${senderTelegramId}\``,
                `• የስልክ ማረጋገጫ፦ ${phoneLabel}`,
                `• ቋንቋ፦ *🇪🇹 አማርኛ*`,
                `• የሙከራ ቀሪ ሂሳብ፦ *${bal.toFixed(2)} ETB (Demo)*`,
                `• የተሳተፉባቸው ዙሮች፦ *${statsAndHistory.gamesPlayed}* · ድሎች፦ *${statsAndHistory.totalWins}*`,
              ].join('\n')
            : [
                '👤 *Player Profile (My Profile)*',
                '',
                `• Name: *${pName}* (@${pUser})`,
                `• Telegram ID: \`TG #${senderTelegramId}\``,
                `• Phone Status: ${phoneLabel}`,
                `• Language: *🇬🇧 English*`,
                `• Demo Balance: *${bal.toFixed(2)} ETB (Demo)*`,
                `• Games Played: *${statsAndHistory.gamesPlayed}* · Wins: *${statsAndHistory.totalWins}*`,
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'profile'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_my_profile',
        profile: existingPlayer ?? undefined,
      };
    }

    // 12. Game History (`cb:game_history`, `📜 የጨዋታ ታሪክ`, `📜 Game History`, `/history`)
    if (
      cleanCallback === 'cb:game_history' ||
      cleanCallback === 'menu:game_history' ||
      trimmed === '/history' ||
      trimmed === '📜 የጨዋታ ታሪክ' ||
      trimmed === '📜 Game History' ||
      (customButtons?.gameHistoryAm && trimmed === customButtons.gameHistoryAm) ||
      (customButtons?.gameHistoryEn && trimmed === customButtons.gameHistoryEn)
    ) {
      const gameLines = statsAndHistory.recentGames.map((g, idx) => {
        return `${idx + 1}. \`${g.gameId}\` (${g.roomId}) — ካርድ *#${g.cardId}* · *${g.pattern}*`;
      });
      const txLines = statsAndHistory.recentHistory.map((item, idx) => {
        const sign = item.amountEtb >= 0 ? '+' : '';
        return `${idx + 1}. \`${item.reference}\` — *${sign}${item.amountEtb.toFixed(2)} ETB* (${item.description})`;
      });
      const combinedLines =
        gameLines.length > 0
          ? [...gameLines, ...(txLines.length > 0 ? ['', ...txLines] : [])]
          : txLines.length > 0
            ? txLines
            : [
                currentLang === 'am'
                  ? '• እስካሁን የተመዘገበ የጨዋታ ወይም የካርድ ግብይት ታሪክ የለም። የመጀመሪያ ዙርዎን ለመጀመር *🎱 ቢንጎ ይጫወቱ* የሚለውን ይጫኑ!'
                  : '• No recorded game rounds or card transactions yet. Tap *🎱 Play Bingo* below to join your first live round!',
              ];

      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? [
                '📜 *የእርስዎ የADEYBINGO የጨዋታ ታሪክ (Game History)*',
                '',
                `• ጠቅላላ የተጫወቱት፦ *${statsAndHistory.gamesPlayed}* · ድሎች፦ *${statsAndHistory.totalWins}*`,
                '',
                ...combinedLines,
              ].join('\n')
            : [
                '📜 *Recent Game & Ledger History (Game History)*',
                '',
                `• Total Rounds Played: *${statsAndHistory.gamesPlayed}* · Verified Wins: *${statsAndHistory.totalWins}*`,
                '',
                ...combinedLines,
              ].join('\n'),
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'history'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_game_history',
        profile: existingPlayer ?? undefined,
      };
    }

    // 13. Support, Help, and Terms (`🆘 እገዛ`, `🆘 Support`, `/support`, `/help`, `/terms`, `cb:support`)
    if (trimmed === '/help') {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '🆘 *የADEYBINGO መመሪያ (/help)*\n\n• `/start` — ዋና ሜኑ\n• `/wallet` · `/deposit` · `/withdraw` — የሙከራ ቦርሳ\n• `/invite` · `/leaderboard` · `/history` — ግብዣ እና ውጤቶች\n• `/language` — ቋንቋ ለመቀየር\n• `/support` · `/terms` — ድጋፍ እና ህጎች'
            : '🆘 *ADEYBINGO Command Guide (/help)*\n\n• `/start` — Main menu\n• `/wallet` · `/deposit` · `/withdraw` — Demo wallet\n• `/invite` · `/leaderboard` · `/history` — Referrals & results\n• `/language` — Switch Amharic / English\n• `/support` · `/terms` — Support & Demo Sandbox rules',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'support'
        ),
        registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
        securityCode: 'callback_support',
        profile: existingPlayer ?? undefined,
      };
    }

    if (
      trimmed === '/support' ||
      trimmed === '🆘 እገዛ' ||
      trimmed === '🆘 Support' ||
      trimmed === '📞 Contact Support' ||
      trimmed === '💬 Support' ||
      trimmed === '💬 ድጋፍ' ||
      (customButtons?.supportAm && trimmed === customButtons.supportAm) ||
      (customButtons?.supportEn && trimmed === customButtons.supportEn) ||
      cleanCallback === 'cb:support' ||
      cleanCallback === 'menu:contact_support'
    ) {
      return {
        ok: true,
        chatId: senderTelegramId,
        language: currentLang,
        text:
          currentLang === 'am'
            ? '🆘 *የADEYBINGO የተጫዋቾች እገዛ እና ድጋፍ (/support)*\n• የቴሌግራም ድጋፍ፦ `@AdeyBingoSupport`\n• በሚኒ አፑ ውስጥ *ድጋፍ (Support)* የሚለውን ትር በመክፈት ጥያቄ መላክ ይችላሉ።\n• ሁሉም ሂሳቦች በሙከራ (Demo Sandbox) ሁኔታ ይሰራሉ።'
            : '🆘 *ADEYBINGO Player Support (/support)*\n• Telegram Support Desk: `@AdeyBingoSupport`\n• Or open the *Support* tab inside the Mini App to submit a ticket.\n• All balances operate in Demo Sandbox mode.',
        parseMode: 'Markdown',
        replyMarkup: buildBotMainMenuMarkup(
          currentLang,
          effectiveMiniAppUrl,
          Boolean(existingPlayer?.phoneVerified),
          customButtons,
          'support'
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
          customButtons,
          'support'
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
          ? '🎱 የADEYBINGO ዋና ሜኑ ከታች ይገኛል። *🎱 ቢንጎ ይጫወቱ* በመጫን ጨዋታውን ይጀምሩ!'
          : '🎱 Use the ADEYBINGO menu below or tap *🎱 Play Bingo* to launch the Mini App!',
      parseMode: 'Markdown',
      replyMarkup: buildBotMainMenuMarkup(
        currentLang,
        effectiveMiniAppUrl,
        Boolean(existingPlayer?.phoneVerified),
        customButtons,
        'welcome'
      ),
      registrationStatus: existingPlayer?.phoneVerified ? 'verified' : 'pending_contact',
      profile: existingPlayer ?? undefined,
    };
  }
}
