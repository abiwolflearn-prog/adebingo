import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  type AuthBackendDeps,
  authenticateRequest,
  requirePhoneVerifiedPlayer,
} from './auth.ts';
import { getAdminDb } from './firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractIdempotencyKey,
  extractSubRoute,
  findForbiddenOverrideFields,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { createFirestoreTelegramStore } from './telegramPersistence.ts';

export interface PlayerHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export type PlayerStateHandlerDeps = PlayerHandlerDeps;
export type PlayerWalletHandlerDeps = PlayerHandlerDeps;

const FORBIDDEN_WALLET_OVERRIDE_FIELDS = [
  'uid',
  'firebaseUid',
  'telegramUserId',
  'telegramId',
  'isAdmin',
  'demoBalanceEtb',
  'winningsBalanceEtb',
  'balance',
  'status',
  'approved',
  'role',
] as const;

type DemoMethod =
  | 'Telebirr (Manual)'
  | 'CBE Birr (Manual)'
  | 'Bank Transfer (Manual)'
  | 'Telebirr (Demo)'
  | 'CBE Birr (Demo)';

function resolveDemoMethod(raw: unknown): DemoMethod {
  if (raw === 'CBE Birr (Manual)' || raw === 'cbe_birr_manual') return 'CBE Birr (Manual)';
  if (raw === 'CBE Birr (Demo)' || raw === 'cbe_birr') return 'CBE Birr (Demo)';
  if (raw === 'Bank Transfer (Manual)' || raw === 'bank_transfer') return 'Bank Transfer (Manual)';
  if (raw === 'Telebirr (Demo)' || raw === 'telebirr') return 'Telebirr (Demo)';
  return 'Telebirr (Manual)';
}

function toIsoString(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof (raw as { toDate?: () => Date }).toDate === 'function') {
    return (raw as { toDate: () => Date }).toDate().toISOString();
  }
  if (raw instanceof Date) return raw.toISOString();
  return new Date().toISOString();
}

function resolveTxLabels(type: string, description: string): { labelAm: string; labelEn: string } {
  switch (type) {
    case 'bingo_win':
      return {
        labelAm: description ? `የቢንጎ ድል · ${description}` : 'የቢንጎ ድል ሽልማት (Demo)',
        labelEn: description || 'Bingo Win Prize (Demo)',
      };
    case 'card_entry':
      return {
        labelAm: description ? `የካርድ መግቢያ · ${description}` : 'የቢንጎ ካርድ መግቢያ (Demo)',
        labelEn: description || 'Bingo Card Entry (Demo)',
      };
    case 'referral_bonus':
      return {
        labelAm: description ? `የግብዣ / ፕሮሞ ቦነስ · ${description}` : 'የግብዣ / ፕሮሞ ቦነስ (Demo)',
        labelEn: description || 'Referral / Promo Bonus (Demo)',
      };
    case 'withdraw_demo':
      return {
        labelAm: description ? `የሙከራ ወጪ · ${description}` : 'የሙከራ ገንዘብ ወጪ (Demo)',
        labelEn: description || 'Demo Withdrawal',
      };
    default:
      return {
        labelAm: description ? `የሙከራ ተቀማጭ · ${description}` : 'የሙከራ ተቀማጭ ሂሳብ (Demo)',
        labelEn: description || 'Demo Deposit Credit',
      };
  }
}

/**
 * GET /api/player/state
 */
export function createPlayerStateHandler(deps: PlayerStateHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'player_state',
        subject: caller.uid,
        limit: 60,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    let db: Firestore;
    try {
      db = deps.getDb ? deps.getDb() : getAdminDb();
    } catch {
      sendError(
        res,
        503,
        'firebase_admin_unavailable',
        'Server persistence service is unavailable.'
      );
      return;
    }

    const tgMatch = /^tg_([1-9]\d*)$/.exec(caller.uid);
    const resolvedTgId = caller.telegramId || (tgMatch ? Number(tgMatch[1]) : 0);
    const store = createFirestoreTelegramStore(db);

    const [
      userSnap,
      botPlayerSnap,
      txSnap,
      refSnap,
      depositSnap,
      payoutSnap,
      wonGamesSnap,
      completedGamesSnap,
      supportSnap,
      leaderboard,
    ] = await Promise.all([
      db.collection('users').doc(caller.uid).get(),
      resolvedTgId > 0
        ? db.collection('botPlayers').doc(String(resolvedTgId)).get()
        : Promise.resolve(null),
      db.collection('transactions').where('userId', '==', caller.uid).get(),
      db.collection('referrals').where('inviterUid', '==', caller.uid).get(),
      db.collection('depositRequests').where('uid', '==', caller.uid).get(),
      db.collection('payoutRequests').where('uid', '==', caller.uid).get(),
      db.collection('games').where('winnerUid', '==', caller.uid).get(),
      db.collection('games').where('status', '==', 'completed').get(),
      db.collection('supportTickets').where('uid', '==', caller.uid).get(),
      store.getLeaderboard ? store.getLeaderboard(15) : Promise.resolve([]),
    ]);

    // Strictly use stored values; missing documents resolve to 0 ETB (never fabricated).
    const availableBalanceEtb = userSnap.exists
      ? Math.max(0, Number(userSnap.get('demoBalanceEtb') ?? 0))
      : botPlayerSnap?.exists
        ? Math.max(0, Number(botPlayerSnap.get('demoBalanceEtb') ?? 0))
        : 0;

    const transactions = txSnap.docs
      .map((d) => {
        const data = d.data() || {};
        const type = String(data.type || 'deposit_demo') as
          | 'deposit_demo'
          | 'withdraw_demo'
          | 'card_entry'
          | 'bingo_win'
          | 'referral_bonus';
        const description = String(data.description || '');
        const labels = resolveTxLabels(type, description);
        return {
          id: String(data.transactionId || d.id),
          type,
          amount: Number(data.amountEtb ?? 0),
          provider: typeof data.provider === 'string' ? data.provider : undefined,
          status:
            data.status === 'demo_pending'
              ? ('demo_pending' as const)
              : ('demo_completed' as const),
          labelAm: labels.labelAm,
          labelEn: labels.labelEn,
          timestamp: toIsoString(data.createdAt),
          reference: String(data.reference || d.id),
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const winningsBalanceEtb = transactions
      .filter((tx) => tx.type === 'bingo_win' && tx.amount > 0)
      .reduce((sum, tx) => sum + tx.amount, 0);

    const depositRequests = depositSnap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          depositId: String(data.depositId || d.id),
          amountEtb: Number(data.amountEtb ?? 0),
          provider: String(data.provider || 'Telebirr (Demo)'),
          referenceCode: String(data.referenceCode || d.id),
          status:
            data.status === 'Approved' || data.status === 'Rejected'
              ? (data.status as 'Approved' | 'Rejected')
              : ('Pending' as const),
          requestDate: String(data.requestDate || toIsoString(data.createdAt)),
        };
      })
      .sort((a, b) => b.requestDate.localeCompare(a.requestDate))
      .slice(0, 10);

    const payoutRequests = payoutSnap.docs
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
          status: validStatus as
            | 'Pending'
            | 'Under Review'
            | 'Approved'
            | 'Rejected'
            | 'Completed',
          requestDate: String(data.requestDate || toIsoString(data.createdAt)),
          reviewNotes: String(data.reviewNotes || ''),
        };
      })
      .sort((a, b) => b.requestDate.localeCompare(a.requestDate))
      .slice(0, 10);

    const referrals = refSnap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: String(data.referralId || data.id || d.id),
          friendName: String(data.inviteeName || data.friendName || 'Player'),
          handle: String(data.inviteeHandle || data.friendHandle || '@player'),
          joinedAt: String(data.joinedAt || toIsoString(data.createdAt)),
          status:
            data.status === 'qualified' ? ('qualified' as const) : ('pending' as const),
          inviterBonus: Number(data.inviterBonusEtb ?? 20),
          inviteeBonus: Number(data.inviteeBonusEtb ?? 0),
        };
      })
      .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));

    const matchedWonDocsMap = new Map<string, (typeof wonGamesSnap.docs)[number]>();
    for (const d of wonGamesSnap.docs) {
      matchedWonDocsMap.set(d.id, d);
    }
    for (const d of completedGamesSnap.docs) {
      if (matchedWonDocsMap.has(d.id)) continue;
      const data = d.data() || {};
      const winnersArr = Array.isArray(data.winners)
        ? (data.winners as Array<Record<string, unknown>>)
        : [];
      if (
        String(data.winnerUid || '') === caller.uid ||
        winnersArr.some((w) => String(w.uid || '') === caller.uid)
      ) {
        matchedWonDocsMap.set(d.id, d);
      }
    }

    const gameHistory = Array.from(matchedWonDocsMap.values())
      .map((d) => {
        const data = d.data() || {};
        const winningCardId = Number(data.winningCardId ?? 0);
        const winnersArr = Array.isArray(data.winners)
          ? (data.winners as Array<Record<string, unknown>>)
          : [];
        const myWinnerEntries = winnersArr.filter(
          (w) => String(w.uid || '') === caller.uid
        );
        const myCardIds =
          myWinnerEntries.length > 0
            ? myWinnerEntries
                .map((w) => Number(w.cardId ?? 0))
                .filter((id) => Number.isInteger(id) && id > 0)
            : winningCardId > 0
              ? [winningCardId]
              : [];
        const myPrizeFromSplit =
          myWinnerEntries.length > 0
            ? Number(
                myWinnerEntries
                  .reduce((sum, w) => sum + Number(w.prizeEtb ?? 0), 0)
                  .toFixed(2)
              )
            : undefined;
        const resolvedEntryFee = Number(
          data.entryFeeDemo ?? data.cardPrice ?? data.cardPriceEtb ?? 10
        );
        const resolvedPrize =
          myPrizeFromSplit !== undefined
            ? myPrizeFromSplit
            : Number(data.demoPrizeEtb ?? data.winnersPrizePoolEtb ?? 0);

        return {
          id: String(data.gameId || d.id),
          roomNameAm: String(data.roomNameAm || data.roomId || 'አደይ ዋና አዳራሽ'),
          roomNameEn: String(data.roomNameEn || data.roomId || 'Adey Main Hall'),
          playedAt: String(data.completedAt || toIsoString(data.updatedAt)),
          cardIds: myCardIds,
          entryFeeDemo: resolvedEntryFee,
          outcome: 'won' as const,
          prizeDemo: resolvedPrize,
          callsCount: Array.isArray(data.calledNumbers) ? data.calledNumbers.length : 0,
          patternEn: typeof data.winningPattern === 'string' ? data.winningPattern : undefined,
          patternAm: typeof data.winningPattern === 'string' ? data.winningPattern : undefined,
        };
      })
      .sort((a, b) => b.playedAt.localeCompare(a.playedAt));

    const referralCode =
      (botPlayerSnap?.exists && typeof botPlayerSnap.get('referralCode') === 'string'
        ? String(botPlayerSnap.get('referralCode'))
        : '') ||
      (resolvedTgId > 0 ? `ADEY-${resolvedTgId}` : `ADEY-${caller.uid.slice(0, 8).toUpperCase()}`);

    const referredByCode =
      botPlayerSnap?.exists && typeof botPlayerSnap.get('referredByCode') === 'string'
        ? String(botPlayerSnap.get('referredByCode'))
        : userSnap.exists && typeof userSnap.get('referredByCode') === 'string'
          ? String(userSnap.get('referredByCode'))
          : undefined;

    const savedLang =
      (botPlayerSnap?.exists ? botPlayerSnap.get('language') : undefined) ||
      (userSnap.exists ? userSnap.get('language') : undefined);

    const supportTickets = supportSnap.docs
      .map((d) => {
        const data = d.data() || {};
        return {
          id: String(data.id || d.id),
          subject: String(data.subject || ''),
          category: (data.category === 'wallet' ||
          data.category === 'game' ||
          data.category === 'account' ||
          data.category === 'referral'
            ? data.category
            : 'game') as 'wallet' | 'game' | 'account' | 'referral',
          message: String(data.message || ''),
          status:
            data.status === 'resolved'
              ? ('resolved' as const)
              : data.status === 'in_review'
                ? ('in_review' as const)
                : ('open' as const),
          createdAt: String(data.createdAt || toIsoString(data.updatedAt)),
          reply: typeof data.reply === 'string' ? data.reply : undefined,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    sendJson(res, 200, {
      ok: true,
      serverNowMs: Date.now(),
      profile: {
        uid: caller.uid,
        telegramUserId: resolvedTgId,
        displayName:
          (userSnap.exists ? String(userSnap.get('displayName') || '') : '') ||
          caller.displayName,
        username:
          (userSnap.exists ? String(userSnap.get('username') || '') : '') ||
          (botPlayerSnap?.exists ? `@${String(botPlayerSnap.get('username') || '')}` : ''),
        language: savedLang === 'en' ? 'en' : 'am',
        phoneVerified: Boolean(
          (userSnap.exists && userSnap.get('phoneVerified')) ||
            (botPlayerSnap?.exists && botPlayerSnap.get('phoneVerified'))
        ),
        referralCode,
        ...(referredByCode ? { referredByCode } : {}),
      },
      wallet: {
        availableBalanceEtb,
        winningsBalanceEtb,
        demoSandboxOnly: true,
      },
      transactions,
      depositRequests,
      payoutRequests,
      referrals,
      gameHistory,
      supportTickets,
      leaderboard,
    });
  };
}

/**
 * POST /api/player/wallet
 */
export function createPlayerWalletHandler(deps: PlayerWalletHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'player_wallet',
        subject: caller.uid,
        limit: 20,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_WALLET_OVERRIDE_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Caller-supplied identity, role, or balance override fields are forbidden.'
      );
      return;
    }

    const action = body.action;
    if (
      action !== 'apply_promo' &&
      action !== 'deposit_request' &&
      action !== 'withdraw_request' &&
      action !== 'support_ticket'
    ) {
      sendError(
        res,
        400,
        'invalid_wallet_action',
        'action must be apply_promo, deposit_request, withdraw_request, or support_ticket.'
      );
      return;
    }

    let db: Firestore;
    try {
      db = deps.getDb ? deps.getDb() : getAdminDb();
    } catch {
      sendError(
        res,
        503,
        'firebase_admin_unavailable',
        'Server persistence service is unavailable.'
      );
      return;
    }

    if (action !== 'support_ticket') {
      const callerUserSnap = await db.collection('users').doc(caller.uid).get();
      if (callerUserSnap.exists && String(callerUserSnap.get('accountStatus') || 'active') === 'suspended') {
        sendError(
          res,
          403,
          'account_suspended',
          'Your account is currently suspended. Contact support for assistance.'
        );
        return;
      }
    }

    if (action === 'deposit_request' || action === 'withdraw_request') {
      if (!(await requirePhoneVerifiedPlayer(db, caller, res))) {
        return;
      }
    }

    const idempotencyKey = extractIdempotencyKey(req, body);
    if (idempotencyKey) {
      const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
      const fresh = await replayGuard.consumeOnce(
        'card_tx',
        `wallet:${caller.uid}:${action}:${idempotencyKey}`,
        { ttlSeconds: 3600 }
      );
      if (!fresh.fresh) {
        sendError(
          res,
          409,
          'duplicate_request',
          'This wallet request has already been processed.'
        );
        return;
      }
    }

    const tgMatch = /^tg_([1-9]\d*)$/.exec(caller.uid);
    const resolvedTgId = caller.telegramId || (tgMatch ? Number(tgMatch[1]) : 0);
    const store = createFirestoreTelegramStore(db);

    if (action === 'support_ticket') {
      const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 120) : '';
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1200) : '';
      const rawCat = typeof body.category === 'string' ? body.category.trim() : 'game';
      const category =
        rawCat === 'wallet' || rawCat === 'game' || rawCat === 'account' || rawCat === 'referral'
          ? rawCat
          : 'game';
      if (!subject || !message) {
        sendError(res, 400, 'invalid_support_ticket', 'Subject and message are required.');
        return;
      }
      const nowIso = new Date().toISOString();
      const ticketId = `SUP-${Date.now().toString(36).toUpperCase()}`;
      const ticket = {
        id: ticketId,
        uid: caller.uid,
        telegramUserId: resolvedTgId,
        subject,
        category,
        message,
        status: 'open' as const,
        createdAt: nowIso,
      };
      await db.collection('supportTickets').doc(ticketId).set(ticket);
      sendJson(res, 201, {
        ok: true,
        action: 'support_ticket',
        ticket,
      });
      return;
    }

    if (action === 'apply_promo') {
      const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!rawCode || rawCode.length < 3 || rawCode.length > 32 || !/^[A-Z0-9_-]+$/.test(rawCode)) {
        sendError(
          res,
          400,
          'invalid_promo_code',
          'Please enter a valid promo or referral code (e.g. ADEY-123456).'
        );
        return;
      }

      // 1. Referral code format: ADEY-<telegramUserId>
      if (/^ADEY-[1-9]\d*$/.test(rawCode) && resolvedTgId > 0 && store.processReferralDeepLink) {
        const targetInviterId = Number(rawCode.slice('ADEY-'.length));
        if (targetInviterId === resolvedTgId) {
          sendError(
            res,
            400,
            'self_referral_forbidden',
            'You cannot apply your own referral code.'
          );
          return;
        }

        const [existingUserSnap, existingBotSnap, existingRefSnap] = await Promise.all([
          db.collection('users').doc(caller.uid).get(),
          db.collection('botPlayers').doc(String(resolvedTgId)).get(),
          db.collection('referrals').doc(`ref_tg_${resolvedTgId}`).get(),
        ]);

        if (
          existingRefSnap.exists ||
          (existingUserSnap.exists && Boolean(existingUserSnap.get('referredByUid'))) ||
          (existingBotSnap.exists && Boolean(existingBotSnap.get('referredByUid')))
        ) {
          sendError(
            res,
            409,
            'promo_already_applied',
            'A referral or promo code has already been applied to your account.'
          );
          return;
        }

        if (existingUserSnap.exists || existingBotSnap.exists) {
          sendError(
            res,
            409,
            'existing_account_not_eligible',
            'Referral rewards apply only once during initial new-player registration.'
          );
          return;
        }

        const refRes = await store.processReferralDeepLink({
          inviteeTelegramId: resolvedTgId,
          inviteeName: caller.displayName,
          inviteeUsername: caller.uid,
          referralCode: rawCode,
        });
        if (!refRes.applied) {
          const reason = refRes.reason || 'invalid_code';
          const status =
            reason === 'already_referred'
              ? 409
              : reason === 'inviter_not_found'
                ? 404
                : 400;
          sendError(
            res,
            status,
            reason === 'self_referral'
              ? 'self_referral_forbidden'
              : reason === 'already_referred'
                ? 'promo_already_applied'
                : reason,
            reason === 'self_referral'
              ? 'You cannot apply your own referral code.'
              : reason === 'already_referred'
                ? 'A referral or promo code has already been applied to your account.'
                : reason === 'inviter_not_found'
                  ? 'No player matches this referral code.'
                  : 'Invalid referral code.'
          );
          return;
        }
        sendJson(res, 200, {
          ok: true,
          action: 'apply_promo',
          code: rawCode,
          bonusEtb: refRes.inviteeBonusEtb ?? 0,
          inviterBonusEtb: refRes.inviterBonusEtb ?? 20,
          ...(typeof refRes.inviteeBalanceEtb === 'number'
            ? { updatedBalanceEtb: refRes.inviteeBalanceEtb }
            : {}),
          demoSandboxOnly: true,
        });
        return;
      }

      // 2. Named promo code in Firestore `promoCodes/{code}`
      const promoRef = db.collection('promoCodes').doc(rawCode);
      const claimRef = db.collection('promoClaims').doc(`${rawCode}_${caller.uid}`);
      const userRef = db.collection('users').doc(caller.uid);
      const botPlayerRef =
        resolvedTgId > 0 ? db.collection('botPlayers').doc(String(resolvedTgId)) : null;
      const txId = `tx_promo_${rawCode}_${caller.uid}`;
      const txRef = db.collection('transactions').doc(txId);

      const promoTx = await db.runTransaction(async (tx) => {
        const [promoSnap, claimSnap, userSnap, botPlayerSnap] = await Promise.all([
          tx.get(promoRef),
          tx.get(claimRef),
          tx.get(userRef),
          botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
        ]);

        if (!promoSnap.exists || promoSnap.get('active') === false) {
          return { ok: false as const, status: 404, code: 'promo_code_not_found' };
        }
        if (claimSnap.exists) {
          return { ok: false as const, status: 409, code: 'promo_already_applied' };
        }

        const bonusEtb = Number(promoSnap.get('bonusEtb') ?? 0);
        const maxUses = Number(promoSnap.get('maxUses') ?? 0);
        const usedCount = Number(promoSnap.get('usedCount') ?? 0);
        if (!Number.isFinite(bonusEtb) || bonusEtb <= 0 || bonusEtb > 500) {
          return { ok: false as const, status: 400, code: 'invalid_promo_code' };
        }
        if (maxUses > 0 && usedCount >= maxUses) {
          return { ok: false as const, status: 409, code: 'promo_code_exhausted' };
        }

        const currentBal = userSnap.exists
          ? Number(userSnap.get('demoBalanceEtb') ?? 0)
          : botPlayerSnap?.exists
            ? Number(botPlayerSnap.get('demoBalanceEtb') ?? 0)
            : 0;
        const nextBal = Number((currentBal + bonusEtb).toFixed(2));
        const nowIso = new Date().toISOString();

        if (!userSnap.exists) {
          tx.set(userRef, {
            uid: caller.uid,
            telegramUserId: resolvedTgId > 0 ? `tg_${resolvedTgId}` : caller.uid,
            displayName: caller.displayName,
            username: caller.uid,
            language: 'am',
            phoneVerified: false,
            demoBalanceEtb: nextBal,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
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

        tx.set(claimRef, {
          code: rawCode,
          uid: caller.uid,
          bonusEtb,
          claimedAt: nowIso,
        });
        tx.update(promoRef, {
          usedCount: usedCount + 1,
          updatedAt: nowIso,
        });
        tx.set(txRef, {
          transactionId: txId,
          userId: caller.uid,
          type: 'referral_bonus',
          amountEtb: bonusEtb,
          balanceBeforeEtb: currentBal,
          balanceAfterEtb: nextBal,
          status: 'demo_completed',
          description: `Promo Code (${rawCode})`,
          reference: `PROMO-${rawCode}`,
          relatedId: rawCode,
          idempotencyKey: txId,
          createdAt: nowIso,
        });

        return { ok: true as const, bonusEtb, updatedBalanceEtb: nextBal };
      });

      if (!promoTx.ok) {
        sendError(
          res,
          promoTx.status,
          promoTx.code,
          promoTx.code === 'promo_already_applied'
            ? 'This promo code has already been redeemed on your account.'
            : promoTx.code === 'promo_code_exhausted'
              ? 'This promo code has reached its redemption limit.'
              : 'Promo or referral code not found.'
        );
        return;
      }

      sendJson(res, 200, {
        ok: true,
        action: 'apply_promo',
        code: rawCode,
        bonusEtb: promoTx.bonusEtb,
        updatedBalanceEtb: promoTx.updatedBalanceEtb,
        demoSandboxOnly: true,
      });
      return;
    }

    if (action === 'deposit_request') {
      const amountEtb = Number(body.amountEtb);
      if (!Number.isFinite(amountEtb) || amountEtb < 10 || amountEtb > 10000) {
        sendError(
          res,
          400,
          'invalid_deposit_amount',
          'Deposit request amount must be between 10 and 10,000 ETB.'
        );
        return;
      }
      const method = resolveDemoMethod(body.provider ?? body.method);
      const rawReceiptRef =
        typeof body.receiptReference === 'string'
          ? body.receiptReference.trim()
          : typeof body.referenceCode === 'string'
            ? body.referenceCode.trim()
            : '';
      const rawReceiptProof =
        typeof body.receiptProof === 'string'
          ? body.receiptProof.trim().slice(0, 300)
          : typeof body.proofNote === 'string'
            ? body.proofNote.trim().slice(0, 300)
            : '';
      if (rawReceiptRef && (rawReceiptRef.length < 4 || rawReceiptRef.length > 64)) {
        sendError(
          res,
          400,
          'invalid_receipt_reference',
          'Payment receipt reference must be between 4 and 64 characters.'
        );
        return;
      }

      if (resolvedTgId > 0 && store.createDemoDepositRequest) {
        const result = await store.createDemoDepositRequest({
          telegramUserId: resolvedTgId,
          method,
          amountEtb,
          receiptReference: rawReceiptRef || undefined,
          receiptProof: rawReceiptProof || undefined,
        });
        if (!result.ok || !result.deposit) {
          const statusCode = result.reason === 'duplicate_receipt' ? 409 : 400;
          sendError(
            res,
            statusCode,
            result.reason || 'deposit_request_failed',
            result.reason === 'duplicate_receipt'
              ? 'This payment receipt reference has already been submitted.'
              : 'Unable to submit deposit request.'
          );
          return;
        }
        sendJson(res, 201, {
          ok: true,
          action: 'deposit_request',
          deposit: result.deposit,
          demoSandboxOnly: true,
        });
        return;
      }

      const nowIso = new Date().toISOString();
      const depositId = `DEP-WEB-${Date.now().toString(36).toUpperCase()}`;
      const referenceCode = rawReceiptRef
        ? rawReceiptRef.toUpperCase()
        : `REF-${Math.floor(100000 + Math.random() * 899999)}`;
      const lockKey = referenceCode.replace(/[^A-Z0-9_-]/g, '_').slice(0, 64);
      const lockRef = db.collection('depositReceiptLocks').doc(lockKey);
      const depRef = db.collection('depositRequests').doc(depositId);

      const depTx = await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(lockRef);
        if (lockSnap.exists) {
          return { ok: false as const, reason: 'duplicate_receipt' };
        }
        const deposit = {
          depositId,
          amountEtb,
          provider: method,
          referenceCode,
          ...(rawReceiptProof ? { receiptProof: rawReceiptProof } : {}),
          status: 'Pending' as const,
          requestDate: nowIso,
          reviewNotes: 'Manual payment receipt submitted — awaiting admin verification',
        };
        tx.set(lockRef, {
          referenceCode,
          depositId,
          uid: caller.uid,
          createdAt: nowIso,
        });
        tx.set(depRef, {
          ...deposit,
          uid: caller.uid,
          userDisplayName: caller.displayName,
          telegramUserId: resolvedTgId,
          demoSandboxOnly: true,
        });
        return { ok: true as const, deposit };
      });

      if (!depTx.ok) {
        sendError(
          res,
          409,
          'duplicate_receipt',
          'This payment receipt reference has already been submitted.'
        );
        return;
      }

      sendJson(res, 201, {
        ok: true,
        action: 'deposit_request',
        deposit: depTx.deposit,
        demoSandboxOnly: true,
      });
      return;
    }

    // action === 'withdraw_request'
    const amountEtb = Number(body.amountEtb);
    if (!Number.isFinite(amountEtb) || amountEtb < 20 || amountEtb > 50000) {
      sendError(
        res,
        400,
        'invalid_withdraw_amount',
        'Demo withdrawal request amount must be at least 20 ETB.'
      );
      return;
    }
    const method = resolveDemoMethod(body.method ?? body.provider);
    const userRef = db.collection('users').doc(caller.uid);
    const botPlayerRef =
      resolvedTgId > 0 ? db.collection('botPlayers').doc(String(resolvedTgId)) : null;
    const requestId = `PO-WEB-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const payoutRef = db.collection('payoutRequests').doc(requestId);
    const txId = `tx_wdr_${requestId}`;
    const txRef = db.collection('transactions').doc(txId);

    const wdrTx = await db.runTransaction(async (tx) => {
      const [userSnap, botPlayerSnap] = await Promise.all([
        tx.get(userRef),
        botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
      ]);
      // Strictly read stored balance; missing accounts have 0 balance.
      const availableBalanceEtb = userSnap.exists
        ? Math.max(0, Number(userSnap.get('demoBalanceEtb') ?? 0))
        : botPlayerSnap?.exists
          ? Math.max(0, Number(botPlayerSnap.get('demoBalanceEtb') ?? 0))
          : 0;

      if (amountEtb > availableBalanceEtb) {
        return {
          ok: false as const,
          reason: 'insufficient_demo_balance',
          availableBalanceEtb,
        };
      }

      const nextBalanceEtb = Number(Math.max(0, availableBalanceEtb - amountEtb).toFixed(2));
      const nowIso = new Date().toISOString();
      const withdrawal = {
        requestId,
        requestedAmountEtb: amountEtb,
        paymentMethod: method,
        status: 'Pending' as const,
        requestDate: nowIso,
        reviewNotes: 'Submitted via ADEYBINGO Mini App (Demo Sandbox)',
      };

      // Atomically hold/deduct withdrawal amount from BOTH users and botPlayers
      if (userSnap.exists) {
        tx.update(userRef, {
          demoBalanceEtb: nextBalanceEtb,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else if (botPlayerSnap?.exists) {
        tx.set(userRef, {
          uid: caller.uid,
          telegramUserId: resolvedTgId > 0 ? `tg_${resolvedTgId}` : caller.uid,
          displayName: caller.displayName,
          username: String(botPlayerSnap.get('username') || caller.uid),
          language: botPlayerSnap.get('language') === 'en' ? 'en' : 'am',
          phoneVerified: Boolean(botPlayerSnap.get('phoneVerified')),
          demoBalanceEtb: nextBalanceEtb,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (botPlayerRef && botPlayerSnap?.exists) {
        tx.update(botPlayerRef, {
          demoBalanceEtb: nextBalanceEtb,
          updatedAt: nowIso,
        });
      }

      tx.set(txRef, {
        transactionId: txId,
        userId: caller.uid,
        type: 'withdraw_demo',
        amountEtb: -amountEtb,
        balanceBeforeEtb: availableBalanceEtb,
        balanceAfterEtb: nextBalanceEtb,
        status: 'demo_pending',
        description: `Demo Withdrawal Hold (${method})`,
        reference: requestId,
        relatedId: requestId,
        idempotencyKey: idempotencyKey || txId,
        createdAt: nowIso,
      });

      tx.set(payoutRef, {
        ...withdrawal,
        uid: caller.uid,
        userDisplayName: caller.displayName,
        telegramUserId: resolvedTgId,
        destinationMasked: resolvedTgId > 0 ? `TG #${resolvedTgId}` : caller.uid,
        demoSandboxOnly: true,
        fundsHeldAtSubmission: true,
        auditTrail: [
          {
            timestamp: nowIso,
            fromStatus: 'Created',
            toStatus: 'Pending',
            reviewedBy: `player:${caller.uid}`,
            notes: 'Demo withdrawal requested in Mini App wallet (funds held atomically)',
          },
        ],
      });

      return { ok: true as const, withdrawal, updatedBalanceEtb: nextBalanceEtb };
    });

    if (!wdrTx.ok) {
      sendError(
        res,
        400,
        wdrTx.reason,
        `Insufficient verified Demo balance (${wdrTx.availableBalanceEtb.toFixed(2)} ETB available).`,
        { availableBalanceEtb: wdrTx.availableBalanceEtb }
      );
      return;
    }

    sendJson(res, 201, {
      ok: true,
      action: 'withdraw_request',
      withdrawal: wdrTx.withdrawal,
      updatedBalanceEtb: wdrTx.updatedBalanceEtb,
      demoSandboxOnly: true,
    });
  };
}

/**
 * Consolidated router for `/api/player/state` and `/api/player/wallet`.
 */
export function createPlayerRouterHandler(deps: PlayerHandlerDeps = {}) {
  const stateHandler = createPlayerStateHandler(deps);
  const walletHandler = createPlayerWalletHandler(deps);

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const subRoute = extractSubRoute(req, '/api/player');

    switch (subRoute) {
      case 'state':
        return await stateHandler(req, res);
      case 'wallet':
        return await walletHandler(req, res);
      default:
        sendError(
          res,
          404,
          'player_endpoint_not_found',
          `Unknown player endpoint: /api/player/${subRoute}`
        );
    }
  };
}
