import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthBackendDeps, authenticateRequest } from './auth.ts';
import { getAdminDb } from './firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractSubRoute,
  findForbiddenOverrideFields,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
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

type DemoMethod = 'Telebirr (Demo)' | 'CBE Birr (Demo)' | 'Chapa Sandbox (Demo)';

function resolveDemoMethod(raw: unknown): DemoMethod {
  if (raw === 'CBE Birr (Demo)' || raw === 'cbe_birr') return 'CBE Birr (Demo)';
  if (raw === 'Chapa Sandbox (Demo)' || raw === 'chapa') return 'Chapa Sandbox (Demo)';
  return 'Telebirr (Demo)';
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
          inviteeBonus: Number(data.inviteeBonusEtb ?? 15),
        };
      })
      .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));

    const gameHistory = wonGamesSnap.docs
      .map((d) => {
        const data = d.data() || {};
        const winningCardId = Number(data.winningCardId ?? 0);
        return {
          id: String(data.gameId || d.id),
          roomNameAm: String(data.roomNameAm || data.roomId || 'አደይ ዋና አዳራሽ'),
          roomNameEn: String(data.roomNameEn || data.roomId || 'Adey Main Hall'),
          playedAt: String(data.completedAt || toIsoString(data.updatedAt)),
          cardIds: winningCardId > 0 ? [winningCardId] : [],
          entryFeeDemo: Number(data.entryFeeDemo ?? 10),
          outcome: 'won' as const,
          prizeDemo: Number(data.demoPrizeEtb ?? 0),
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

    sendJson(res, 200, {
      ok: true,
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
      action !== 'withdraw_request'
    ) {
      sendError(
        res,
        400,
        'invalid_wallet_action',
        'action must be apply_promo, deposit_request, or withdraw_request.'
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

    const tgMatch = /^tg_([1-9]\d*)$/.exec(caller.uid);
    const resolvedTgId = caller.telegramId || (tgMatch ? Number(tgMatch[1]) : 0);
    const store = createFirestoreTelegramStore(db);

    if (action === 'apply_promo') {
      const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!rawCode || rawCode.length < 3 || rawCode.length > 32 || !/^[A-Z0-9_-]+$/.test(rawCode)) {
        sendError(
          res,
          400,
          'invalid_promo_code',
          'Please enter a valid promo or referral code (e.g. ADEY-8842109).'
        );
        return;
      }

      // 1. Referral code format: ADEY-<telegramUserId>
      if (/^ADEY-[1-9]\d*$/.test(rawCode) && resolvedTgId > 0 && store.processReferralDeepLink) {
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
          bonusEtb: refRes.inviteeBonusEtb ?? 15,
          demoSandboxOnly: true,
        });
        return;
      }

      // 2. Named promo code in Firestore `promoCodes/{code}`
      const promoRef = db.collection('promoCodes').doc(rawCode);
      const claimRef = db.collection('promoClaims').doc(`${rawCode}_${caller.uid}`);
      const userRef = db.collection('users').doc(caller.uid);
      const txId = `tx_promo_${rawCode}_${caller.uid}_${Date.now()}`;
      const txRef = db.collection('transactions').doc(txId);

      const promoTx = await db.runTransaction(async (tx) => {
        const [promoSnap, claimSnap, userSnap] = await Promise.all([
          tx.get(promoRef),
          tx.get(claimRef),
          tx.get(userRef),
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

        const currentBal = userSnap.exists ? Number(userSnap.get('demoBalanceEtb') ?? 0) : 0;
        const nextBal = currentBal + bonusEtb;
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
          status: 'demo_completed',
          description: `Promo Code (${rawCode})`,
          reference: `PROMO-${rawCode}`,
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
          'Demo deposit request amount must be between 10 and 10,000 ETB.'
        );
        return;
      }
      const method = resolveDemoMethod(body.provider ?? body.method);

      if (resolvedTgId > 0 && store.createDemoDepositRequest) {
        const result = await store.createDemoDepositRequest({
          telegramUserId: resolvedTgId,
          method,
          amountEtb,
        });
        if (!result.ok || !result.deposit) {
          sendError(res, 400, result.reason || 'deposit_request_failed', 'Unable to submit deposit request.');
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
      const referenceCode = `REF-${Math.floor(100000 + Math.random() * 899999)}`;
      const deposit = {
        depositId,
        amountEtb,
        provider: method,
        referenceCode,
        status: 'Pending' as const,
        requestDate: nowIso,
      };
      await db.collection('depositRequests').doc(depositId).set({
        ...deposit,
        uid: caller.uid,
        userDisplayName: caller.displayName,
        telegramUserId: resolvedTgId,
        reviewNotes: 'Submitted via ADEYBINGO Mini App (Demo Sandbox)',
        demoSandboxOnly: true,
      });
      sendJson(res, 201, {
        ok: true,
        action: 'deposit_request',
        deposit,
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
    const requestId = `PO-WEB-${Date.now().toString(36).toUpperCase()}`;
    const payoutRef = db.collection('payoutRequests').doc(requestId);

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

      const nowIso = new Date().toISOString();
      const withdrawal = {
        requestId,
        requestedAmountEtb: amountEtb,
        paymentMethod: method,
        status: 'Pending' as const,
        requestDate: nowIso,
        reviewNotes: 'Submitted via ADEYBINGO Mini App (Demo Sandbox)',
      };

      tx.set(payoutRef, {
        ...withdrawal,
        uid: caller.uid,
        userDisplayName: caller.displayName,
        telegramUserId: resolvedTgId,
        destinationMasked: resolvedTgId > 0 ? `TG #${resolvedTgId}` : caller.uid,
        demoSandboxOnly: true,
        auditTrail: [
          {
            timestamp: nowIso,
            fromStatus: 'Created',
            toStatus: 'Pending',
            reviewedBy: `player:${caller.uid}`,
            notes: 'Demo withdrawal requested in Mini App wallet',
          },
        ],
      });

      return { ok: true as const, withdrawal };
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
