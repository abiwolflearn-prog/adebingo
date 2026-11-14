import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { AuthBackendDeps, authenticateRequest } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import { createFirestoreTelegramStore } from '../_lib/telegramPersistence.ts';

export interface PlayerStateHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
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
        : '') || (resolvedTgId > 0 ? `ADEY-${resolvedTgId}` : `ADEY-${caller.uid.slice(0, 8).toUpperCase()}`);

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

export default createPlayerStateHandler();
