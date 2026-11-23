import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import {
  mintServerSessionToken,
  type PayoutOrderStatus,
  type DepositRequestStatus,
  type AdminRoomConfigRecord,
  type VerifiedSessionActor,
} from '../../src/utils/adminAuthority.ts';
import type { BotButtonLabelsConfig } from '../../src/utils/telegramBot.ts';
import { PersistentAdminService } from './adminPersistence.ts';
import {
  type AuthBackendDeps,
  type AuthenticatedCaller,
  authenticateRequest,
  extractBearerToken,
  isServerAllowlistedAdmin,
  resolveAdminSessionSecret,
} from './auth.ts';
import { getAdminDb, getTelegramFirebaseUid } from './firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractSubRoute,
  isConfiguredBotToken,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from './gamePersistence.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';
import { verifyTelegramInitDataPersistent } from './telegramPersistence.ts';

export interface AdminHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  getBotToken?: () => string | undefined;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

function callerToVerifiedActor(caller: AuthenticatedCaller): VerifiedSessionActor {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    uid: caller.uid,
    telegramUserId: caller.telegramId || 8842109,
    displayName: caller.displayName || 'Verified Admin',
    username: caller.uid.replace(/^tg_/, ''),
    email: caller.email,
    role: caller.isAdmin ? 'admin' : 'player',
    authMethod: 'firebase_id_token',
    issuedAt: nowSec,
    expiresAt: nowSec + 3600,
  };
}

function resolveDbOrSend503(
  res: VercelResponse,
  deps: AdminHandlerDeps
): Firestore | null {
  try {
    return deps.getDb ? deps.getDb() : getAdminDb();
  } catch {
    sendError(
      res,
      503,
      'firebase_admin_unavailable',
      'Server persistence service is unavailable.'
    );
    return null;
  }
}

async function requireVerifiedAdminActor(
  req: VercelRequest,
  res: VercelResponse,
  deps: AdminHandlerDeps
): Promise<VerifiedSessionActor | null> {
  const effectiveAuthDeps: AuthBackendDeps = {
    ...deps.authDeps,
    getDb: deps.authDeps?.getDb ?? deps.getDb,
    nowUnixSeconds: deps.authDeps?.nowUnixSeconds ?? deps.nowUnixSeconds,
  };
  const caller = await authenticateRequest(req, res, effectiveAuthDeps, {
    requireAdmin: true,
  });
  if (!caller) return null;
  return callerToVerifiedActor(caller);
}

function extractPathParam(
  req: VercelRequest,
  queryKey: string,
  regex: RegExp
): string {
  const qVal = req.query?.[queryKey];
  if (typeof qVal === 'string' && qVal.trim() !== '') {
    return decodeURIComponent(qVal.trim());
  }
  const paramsObj = (req as unknown as { params?: Record<string, string> }).params;
  if (paramsObj && typeof paramsObj[queryKey] === 'string' && paramsObj[queryKey].trim() !== '') {
    return decodeURIComponent(paramsObj[queryKey].trim());
  }
  const urlStr = req.url || '';
  const match = urlStr.match(regex);
  if (match && match[1]) {
    return decodeURIComponent(match[1]);
  }
  const subRoute = extractSubRoute(req, '/api/admin');
  if (subRoute) {
    const syntheticUrl = `/api/admin/${subRoute}`;
    const subMatch = syntheticUrl.match(regex);
    if (subMatch && subMatch[1]) {
      return decodeURIComponent(subMatch[1]);
    }
  }
  return '';
}

/**
 * GET /api/admin/session
 * Verifies the caller's cryptographic identity and server-side admin role.
 * Never auto-issues an admin session without verified credentials.
 */
export function createAdminSessionHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;

    const effectiveAuthDeps: AuthBackendDeps = {
      ...deps.authDeps,
      getDb: deps.authDeps?.getDb ?? deps.getDb,
      nowUnixSeconds: deps.authDeps?.nowUnixSeconds ?? deps.nowUnixSeconds,
    };

    const caller = await authenticateRequest(req, res, effectiveAuthDeps, {
      requireAdmin: false,
    });
    if (!caller) {
      return;
    }

    const actor = callerToVerifiedActor(caller);
    if (!caller.isAdmin) {
      sendJson(res, 403, {
        ok: false,
        authorized: false,
        reason: 'forbidden_not_admin',
        actor,
        error: 'admin_privileges_required',
        message: 'Access denied (HTTP 403). Your verified account does not have administrator privileges.',
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      authorized: true,
      reason: 'authorized_admin',
      actor,
    });
  };
}

/**
 * POST /api/admin/session/exchange
 * Exchanges a cryptographically verified Firebase ID token OR HMAC-verified Telegram initData
 * for a signed, expiring server session token.
 * Explicitly rejects `identityMode: "admin"`, `identityMode: "player"`, or client-supplied role overrides.
 */
export function createAdminSessionExchangeHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'admin_session_exchange',
        limit: 30,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: false });
    if (body === null) return;

    // Priority 1: Strictly reject preset identityMode ("admin" / "player") and client role overrides
    if (
      body.identityMode !== undefined ||
      body.role !== undefined ||
      body.isAdmin !== undefined
    ) {
      sendError(
        res,
        403,
        'preset_identity_bypass_removed',
        'Preset identity modes (identityMode: "admin" / "player") and client-supplied roles are strictly forbidden. Provide a cryptographically verified Firebase ID token or Telegram initData.'
      );
      return;
    }

    const secret = resolveAdminSessionSecret(deps.authDeps);
    if (!secret) {
      sendError(
        res,
        503,
        'session_secret_unavailable',
        'Server session signing secret is not configured.'
      );
      return;
    }

    const nowSec = deps.nowUnixSeconds
      ? deps.nowUnixSeconds()
      : Math.floor(Date.now() / 1000);

    // Path A: Cryptographically verified Telegram Mini App initData
    const rawInitData =
      typeof body.initData === 'string' && body.initData.trim() !== ''
        ? body.initData.trim()
        : undefined;

    if (rawInitData) {
      const botToken = deps.getBotToken
        ? deps.getBotToken()
        : process.env.TELEGRAM_BOT_TOKEN;
      if (!isConfiguredBotToken(botToken)) {
        sendError(
          res,
          503,
          'bot_token_unavailable',
          'TELEGRAM_BOT_TOKEN is required to verify Telegram initData.'
        );
        return;
      }

      const db = resolveDbOrSend503(res, deps);
      if (!db) return;

      const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
      const verified = await verifyTelegramInitDataPersistent({
        rawInitData,
        botToken,
        replayGuard,
        maxAgeSeconds: 3600,
        nowUnixSeconds: nowSec,
      });

      if (!verified.valid || !verified.telegramUser) {
        const status = verified.reason === 'replay_detected' ? 409 : 401;
        sendError(
          res,
          status,
          verified.reason || 'invalid_init_data',
          `Telegram initData verification failed (${verified.reason || 'invalid'}).`
        );
        return;
      }

      const tgUser = verified.telegramUser;
      const uid = getTelegramFirebaseUid(tgUser.id);
      let isAdmin = isServerAllowlistedAdmin({
        uid,
        telegramId: tgUser.id,
      });
      if (!isAdmin && deps.authDeps?.isAdminUid) {
        try {
          isAdmin = await deps.authDeps.isAdminUid(uid);
        } catch {
          isAdmin = false;
        }
      }

      const minted = mintServerSessionToken(
        {
          uid,
          telegramUserId: tgUser.id,
          displayName: `${tgUser.first_name} ${tgUser.last_name || ''}`.trim() || 'Telegram User',
          username: tgUser.username || `tg_${tgUser.id}`,
          isAdminOverride: isAdmin,
          nowUnixSeconds: nowSec,
          expiresInSeconds: 3600,
        },
        secret
      );

      sendJson(res, isAdmin ? 200 : 403, {
        ok: isAdmin,
        authorized: isAdmin,
        token: minted.token,
        actor: minted.actor,
        reason: isAdmin ? 'authorized_admin' : 'forbidden_not_admin',
        ...(isAdmin
          ? {}
          : {
              error: 'admin_privileges_required',
              message:
                'Your Telegram identity was verified, but this account is not on the administrator allowlist.',
            }),
      });
      return;
    }

    // Path B: Cryptographically verified Firebase Bearer ID token (or body.idToken)
    const bodyIdToken =
      typeof body.idToken === 'string' && body.idToken.trim() !== ''
        ? body.idToken.trim()
        : undefined;
    if (bodyIdToken && !extractBearerToken(req)) {
      req.headers = {
        ...req.headers,
        authorization: `Bearer ${bodyIdToken}`,
      };
    }

    const effectiveAuthDeps: AuthBackendDeps = {
      ...deps.authDeps,
      getDb: deps.authDeps?.getDb ?? deps.getDb,
      nowUnixSeconds: deps.authDeps?.nowUnixSeconds ?? deps.nowUnixSeconds,
    };

    const caller = await authenticateRequest(req, res, effectiveAuthDeps, {
      requireAdmin: false,
    });
    if (!caller) return;

    const minted = mintServerSessionToken(
      {
        uid: caller.uid,
        telegramUserId: caller.telegramId || (caller.isAdmin ? 8842109 : 0),
        displayName: caller.displayName || 'Verified User',
        username: caller.uid.replace(/^tg_/, ''),
        email: caller.email,
        isAdminOverride: caller.isAdmin,
        nowUnixSeconds: nowSec,
        expiresInSeconds: 3600,
      },
      secret
    );

    sendJson(res, caller.isAdmin ? 200 : 403, {
      ok: caller.isAdmin,
      authorized: caller.isAdmin,
      token: minted.token,
      actor: minted.actor,
      reason: caller.isAdmin ? 'authorized_admin' : 'forbidden_not_admin',
      ...(caller.isAdmin
        ? {}
        : {
            error: 'admin_privileges_required',
            message:
              'Your identity token was verified, but this account is not authorized as an administrator.',
          }),
    });
  };
}

/**
 * GET /api/admin/overview
 */
export function createAdminOverviewHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const overview = await service.getOverviewMetrics();
    sendJson(res, 200, { ok: true, overview });
  };
}

/**
 * GET /api/admin/users
 */
export function createAdminUsersHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const q = typeof req.query?.q === 'string' ? req.query.q : '';
    const service = new PersistentAdminService(db);
    const users = await service.searchUsers(q);
    sendJson(res, 200, { ok: true, users });
  };
}

/**
 * POST /api/admin/users/:uid/status
 */
export function createAdminUserStatusHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const targetUid =
      extractPathParam(req, 'uid', /\/api\/admin\/users\/([^/?#]+)\/status/) ||
      (typeof body.uid === 'string' ? body.uid.trim() : '');

    if (!targetUid) {
      sendError(res, 400, 'missing_uid', 'Target user uid is required.');
      return;
    }

    const service = new PersistentAdminService(db);

    if (body.role !== undefined || body.isAdmin !== undefined) {
      const blocked = await service.blockRoleEscalationAttempt({
        actor,
        targetUid,
        requestedRole: String(body.role ?? (body.isAdmin ? 'admin' : 'player')),
      });
      sendJson(res, blocked.statusCode, blocked);
      return;
    }

    const accountStatus = body.accountStatus === 'suspended' ? 'suspended' : 'active';
    const reason = typeof body.reason === 'string' ? body.reason : '';

    const result = await service.updateUserStatus({
      uid: targetUid,
      accountStatus,
      reason,
      adminActor: actor,
    });

    if (!result.ok) {
      const status =
        result.reason === 'self_suspension_forbidden'
          ? 403
          : result.reason === 'user_not_found'
            ? 404
            : 400;
      sendError(
        res,
        status,
        result.reason || 'update_user_status_failed',
        result.reason === 'self_suspension_forbidden'
          ? 'Administrators cannot suspend their own active account.'
          : `Failed to update user status (${result.reason}).`
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * POST /api/admin/users/:uid/wallet
 */
export function createAdminUserWalletHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const targetUid =
      extractPathParam(req, 'uid', /\/api\/admin\/users\/([^/?#]+)\/wallet/) ||
      (typeof body.uid === 'string' ? body.uid.trim() : '');
    if (!targetUid) {
      sendError(res, 400, 'missing_uid', 'Target user uid is required.');
      return;
    }

    const rawDelta = body.deltaEtb !== undefined ? Number(body.deltaEtb) : undefined;
    const operation: 'credit' | 'debit' =
      rawDelta !== undefined && Number.isFinite(rawDelta)
        ? rawDelta < 0
          ? 'debit'
          : 'credit'
        : body.operation === 'debit'
          ? 'debit'
          : 'credit';
    const amountEtb =
      rawDelta !== undefined && Number.isFinite(rawDelta)
        ? Math.abs(rawDelta)
        : Number(body.amountEtb);
    const reason = typeof body.reason === 'string' ? body.reason : '';

    const service = new PersistentAdminService(db);
    const result = await service.adjustUserWallet({
      uid: targetUid,
      operation,
      amountEtb,
      reason,
      adminActor: actor,
    });

    if (!result.ok) {
      const status = result.reason === 'user_not_found' ? 404 : 400;
      sendError(
        res,
        status,
        result.reason || 'wallet_adjust_failed',
        `Cannot adjust wallet (${result.reason}).`
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * POST /api/admin/rooms/:roomId/round-action
 */
export function createAdminRoomRoundActionHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const roomId =
      extractPathParam(req, 'roomId', /\/api\/admin\/rooms\/([^/?#]+)\/round-action/) ||
      (typeof body.roomId === 'string' ? body.roomId.trim() : '');
    const rawAction = typeof body.action === 'string' ? body.action.trim() : '';
    const action = rawAction === 'force_start' ? 'start' : rawAction;

    if (!roomId || !['start', 'draw', 'reset'].includes(action)) {
      sendError(res, 400, 'invalid_round_action', 'roomId and action (start | force_start | draw | reset) are required.');
      return;
    }

    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const gameService = new PersistentGameAuthorityService(gameStore, replayGuard);

    if (action === 'start') {
      const started = await gameService.startGame({
        roomId,
        callerUid: actor.uid,
        isAdmin: true,
      });
      if (!started.ok) {
        sendError(res, 409, started.reason || 'start_failed', `Cannot start round (${started.reason}).`);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        action,
        roundNumber: Number(started.game?.roundNumber ?? 1),
        game: started.game,
      });
      return;
    }

    if (action === 'draw') {
      const drawn = await gameService.drawNextBall({
        roomId,
        callerUid: actor.uid,
        isAdmin: true,
        requireExplicitHostOrAdmin: true,
      });
      if (!drawn.ok) {
        sendError(res, 409, drawn.reason || 'draw_failed', `Cannot draw ball (${drawn.reason}).`);
        return;
      }
      sendJson(res, 200, { ok: true, action, draw: drawn });
      return;
    }

    const reset = await gameService.resetRound({
      roomId,
      callerUid: actor.uid,
      isAdmin: true,
      requireExplicitHostOrAdmin: true,
    });
    if (!reset.ok) {
      sendError(res, 409, reset.reason || 'reset_failed', `Cannot reset round (${reset.reason}).`);
      return;
    }
    const updatedRoomSnap = await db.collection('rooms').doc(roomId).get();
    const nextRoundNumber = updatedRoomSnap.exists
      ? Number(updatedRoomSnap.get('roundNumber') ?? 1)
      : 1;
    sendJson(res, 200, {
      ok: true,
      action,
      roomId,
      roundNumber: nextRoundNumber,
      status: 'countdown',
    });
  };
}

/**
 * GET /api/admin/payouts
 */
export function createAdminPayoutsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const status = typeof req.query?.status === 'string' ? req.query.status : 'ALL';
    const service = new PersistentAdminService(db);
    const payouts = await service.getPayoutOrders(status);
    sendJson(res, 200, { ok: true, payouts });
  };
}

/**
 * POST /api/admin/payouts/:requestId/review
 */
export function createAdminPayoutReviewHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const requestId =
      extractPathParam(req, 'requestId', /\/api\/admin\/payouts\/([^/?#]+)\/review/) ||
      (typeof body.requestId === 'string' ? body.requestId.trim() : '');

    if (!requestId) {
      sendError(res, 400, 'missing_request_id', 'Payout requestId is required.');
      return;
    }

    const service = new PersistentAdminService(db);
    const result = await service.reviewPayoutOrder({
      requestId,
      nextStatus: body.nextStatus as PayoutOrderStatus,
      reviewNotes: typeof body.reviewNotes === 'string' ? body.reviewNotes : '',
      adminActor: actor,
    });

    if (!result.ok) {
      const status =
        result.reason === 'payout_not_found'
          ? 404
          : result.reason === 'already_finalized' || result.reason === 'invalid_transition'
            ? 409
            : 400;
      sendError(
        res,
        status,
        result.reason || 'review_payout_failed',
        `Cannot review payout request (${result.reason}).`
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * GET /api/admin/deposits
 */
export function createAdminDepositsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const deposits = await service.getDepositRequests();
    sendJson(res, 200, { ok: true, deposits });
  };
}

/**
 * POST /api/admin/deposits/:depositId/review
 */
export function createAdminDepositReviewHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const depositId =
      extractPathParam(req, 'depositId', /\/api\/admin\/deposits\/([^/?#]+)\/review/) ||
      (typeof body.depositId === 'string' ? body.depositId.trim() : '');

    if (!depositId) {
      sendError(res, 400, 'missing_deposit_id', 'Deposit depositId is required.');
      return;
    }

    const service = new PersistentAdminService(db);
    const result = await service.reviewDepositRequest({
      depositId,
      nextStatus: body.nextStatus as DepositRequestStatus,
      reviewNotes: typeof body.reviewNotes === 'string' ? body.reviewNotes : '',
      adminActor: actor,
    });

    if (!result.ok) {
      const status =
        result.reason === 'deposit_not_found'
          ? 404
          : result.reason === 'already_finalized' || result.reason === 'invalid_transition'
            ? 409
            : 400;
      sendError(
        res,
        status,
        result.reason || 'review_deposit_failed',
        `Cannot review deposit request (${result.reason}).`
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * GET /api/admin/rooms
 */
export function createAdminRoomsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const rooms = await service.getRooms();
    sendJson(res, 200, { ok: true, rooms });
  };
}

/**
 * POST /api/admin/rooms/:roomId
 */
export function createAdminRoomUpdateHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const roomId =
      extractPathParam(req, 'roomId', /\/api\/admin\/rooms\/([^/?#]+)/) ||
      (typeof body.roomId === 'string' ? body.roomId.trim() : '');

    if (!roomId) {
      sendError(res, 400, 'missing_room_id', 'Room roomId is required.');
      return;
    }

    const service = new PersistentAdminService(db);
    const result = await service.updateRoomConfig({
      roomId,
      cardPriceEtb:
        body.cardPriceEtb !== undefined ? Number(body.cardPriceEtb) : undefined,
      lobbyCountdownSeconds:
        body.lobbyCountdownSeconds !== undefined
          ? Number(body.lobbyCountdownSeconds)
          : undefined,
      minPlayers: body.minPlayers !== undefined ? Number(body.minPlayers) : undefined,
      status: body.status as AdminRoomConfigRecord['status'] | undefined,
      adminActor: actor,
    });

    if (!result.ok) {
      const status = result.reason === 'room_not_found' ? 404 : 400;
      sendError(
        res,
        status,
        result.reason || 'update_room_failed',
        `Cannot update room configuration (${result.reason}).`
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * GET /api/admin/referrals
 */
export function createAdminReferralsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const referrals = await service.getReferrals();
    sendJson(res, 200, { ok: true, referrals });
  };
}

/**
 * GET & POST /api/admin/bot/config
 */
export function createAdminBotConfigHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET', 'POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);

    if ((req.method || 'GET').toUpperCase() === 'GET') {
      const config = await service.getBotManagementState();
      sendJson(res, 200, { ok: true, config, botConfig: config });
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const result = await service.updateBotManagementConfig({
      miniAppUrl: typeof body.miniAppUrl === 'string' ? body.miniAppUrl : undefined,
      customWelcomeAm:
        body.customWelcomeAm !== undefined
          ? (body.customWelcomeAm as string | null)
          : undefined,
      customWelcomeEn:
        body.customWelcomeEn !== undefined
          ? (body.customWelcomeEn as string | null)
          : undefined,
      buttonLabels:
        body.buttonLabels && typeof body.buttonLabels === 'object'
          ? (body.buttonLabels as Partial<BotButtonLabelsConfig>)
          : undefined,
      adminActor: actor,
    });

    sendJson(res, 200, { ...result, botConfig: result.config });
  };
}

/**
 * POST /api/admin/bot/announce
 */
export function createAdminBotAnnounceHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const service = new PersistentAdminService(db);
    const result = await service.sendBotAnnouncement({
      titleAm: typeof body.titleAm === 'string' ? body.titleAm : '',
      titleEn: typeof body.titleEn === 'string' ? body.titleEn : '',
      bodyAm: typeof body.bodyAm === 'string' ? body.bodyAm : '',
      bodyEn: typeof body.bodyEn === 'string' ? body.bodyEn : '',
      targetAudience:
        body.targetAudience === 'verified_players'
          ? 'verified_players'
          : 'all_players',
      adminActor: actor,
    });

    if (!result.ok) {
      sendError(
        res,
        400,
        result.reason || 'empty_announcement',
        'Announcement body cannot be empty.'
      );
      return;
    }

    sendJson(res, 200, result);
  };
}

/**
 * GET /api/admin/notifications
 */
export function createAdminNotificationsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const limit = Number(req.query?.limit ?? 25);
    const service = new PersistentAdminService(db);
    const notifications = await service.listNotifications(
      Number.isFinite(limit) ? limit : 25
    );
    sendJson(res, 200, { ok: true, notifications, outbox: notifications });
  };
}

/**
 * POST /api/admin/notifications/send
 */
export function createAdminNotificationsSendHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const service = new PersistentAdminService(db);
    const payloadObj =
      body.payload && typeof body.payload === 'object'
        ? (body.payload as { title?: string; customMessage?: string; responseMessage?: string })
        : undefined;
    const payloadTitle =
      typeof body.title === 'string' && body.title.trim()
        ? body.title
        : typeof payloadObj?.title === 'string'
          ? payloadObj.title
          : '🌼 ADEYBINGO Notification';
    const payloadBody =
      typeof body.body === 'string' && body.body.trim()
        ? body.body
        : typeof payloadObj?.customMessage === 'string' && payloadObj.customMessage.trim()
          ? payloadObj.customMessage
          : typeof payloadObj?.responseMessage === 'string' && payloadObj.responseMessage.trim()
            ? payloadObj.responseMessage
            : typeof body.event === 'string'
              ? `Notification event: ${body.event}`
              : '';

    const result = await service.sendNotification({
      telegramUserId: Number(body.telegramUserId),
      title: payloadTitle,
      body: payloadBody,
      language: body.language === 'en' ? 'en' : 'am',
      adminActor: actor,
    });

    if (!result.ok) {
      sendError(
        res,
        400,
        result.reason || 'invalid_notification',
        'A valid positive integer telegramUserId and non-empty body are required.'
      );
      return;
    }

    const notifications = await service.listNotifications(20);
    sendJson(res, 200, { ...result, notifications, outbox: notifications });
  };
}

/**
 * GET /api/admin/settings
 */
export function createAdminSettingsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const settings = await service.getAdminSettings();
    sendJson(res, 200, { ok: true, settings });
  };
}

/**
 * GET /api/admin/audit/initial-credits
 */
export function createAdminAuditInitialCreditsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const service = new PersistentAdminService(db);
    const accounts = await service.auditLegacyInitialCredits();
    const reconciledCount = accounts.filter((a) => a.alreadyReconciled).length;
    sendJson(res, 200, {
      ok: true,
      expectedInitialCreditEtb: 15,
      legacyInitialCreditEtb: 250,
      flaggedCount: accounts.length,
      reconciledCount,
      pendingReconciliationCount: accounts.length - reconciledCount,
      accounts,
    });
  };
}

/**
 * POST /api/admin/audit/initial-credits/reconcile
 */
export function createAdminReconcileInitialCreditHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;
    const targetUid = typeof body.uid === 'string' ? body.uid.trim() : '';
    if (!targetUid) {
      sendError(res, 400, 'missing_uid', 'Target user uid is required.');
      return;
    }

    const service = new PersistentAdminService(db);
    const result = await service.reconcileLegacyInitialCredit({
      uid: targetUid,
      adminActor: actor,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
    });
    if (!result.ok) {
      const status =
        result.reason === 'user_not_found'
          ? 404
          : result.reason === 'already_reconciled'
            ? 409
            : 400;
      sendError(
        res,
        status,
        result.reason || 'reconcile_failed',
        `Cannot reconcile initial credit (${result.reason}).`
      );
      return;
    }
    sendJson(res, 200, result);
  };
}

/**
 * GET /api/admin/audit/rooms
 * Non-destructive validation of room counts, reserved cards, cardPrice, and financials against subcollections.
 */
export function createAdminAuditRoomsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const rawRoomId = typeof req.query?.roomId === 'string' ? req.query.roomId.trim() : '';
    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const gameService = new PersistentGameAuthorityService(gameStore, replayGuard);

    const reports = rawRoomId
      ? [await gameService.validateRoomIntegrity(rawRoomId)]
      : await gameService.validateAllRoomsIntegrity();
    const invalidCount = reports.filter((r) => !r.valid).length;
    sendJson(res, 200, {
      ok: true,
      valid: invalidCount === 0,
      checkedCount: reports.length,
      invalidCount,
      reports,
    });
  };
}

/**
 * POST /api/admin/audit/rooms/reconcile
 * Safe, non-destructive reconciliation of room counts, deadlines, and financials from subcollections.
 */
export function createAdminReconcileRoomsHandler(deps: AdminHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    const actor = await requireVerifiedAdminActor(req, res, deps);
    if (!actor) return;
    const db = resolveDbOrSend503(res, deps);
    if (!db) return;

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: false });
    if (!body) return;
    const targetRoomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const gameService = new PersistentGameAuthorityService(gameStore, replayGuard);

    const results = targetRoomId
      ? [await gameService.reconcileRoomState(targetRoomId)]
      : await gameService.reconcileAllRooms();
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0 && results.length === 1) {
      sendError(
        res,
        failed[0].reason === 'room_not_found' ? 404 : 400,
        failed[0].reason || 'reconcile_failed',
        `Cannot reconcile room (${failed[0].reason}).`
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      reconciledCount: results.filter((r) => r.reconciled).length,
      results,
    });
  };
}

/**
 * Consolidated router for all `/api/admin/*` endpoints.
 * Preserves every route, method, authentication, RBAC, and dynamic parameter contract.
 */
export function createAdminRouterHandler(deps: AdminHandlerDeps = {}) {
  const sessionHandler = createAdminSessionHandler(deps);
  const sessionExchangeHandler = createAdminSessionExchangeHandler(deps);
  const overviewHandler = createAdminOverviewHandler(deps);
  const usersHandler = createAdminUsersHandler(deps);
  const userStatusHandler = createAdminUserStatusHandler(deps);
  const userWalletHandler = createAdminUserWalletHandler(deps);
  const payoutsHandler = createAdminPayoutsHandler(deps);
  const payoutReviewHandler = createAdminPayoutReviewHandler(deps);
  const depositsHandler = createAdminDepositsHandler(deps);
  const depositReviewHandler = createAdminDepositReviewHandler(deps);
  const roomsHandler = createAdminRoomsHandler(deps);
  const roomUpdateHandler = createAdminRoomUpdateHandler(deps);
  const roomRoundActionHandler = createAdminRoomRoundActionHandler(deps);
  const referralsHandler = createAdminReferralsHandler(deps);
  const botConfigHandler = createAdminBotConfigHandler(deps);
  const botAnnounceHandler = createAdminBotAnnounceHandler(deps);
  const notificationsHandler = createAdminNotificationsHandler(deps);
  const notificationsSendHandler = createAdminNotificationsSendHandler(deps);
  const settingsHandler = createAdminSettingsHandler(deps);
  const auditInitialCreditsHandler = createAdminAuditInitialCreditsHandler(deps);
  const reconcileInitialCreditHandler = createAdminReconcileInitialCreditHandler(deps);
  const auditRoomsHandler = createAdminAuditRoomsHandler(deps);
  const reconcileRoomsHandler = createAdminReconcileRoomsHandler(deps);

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const subRoute = extractSubRoute(req, '/api/admin');

    switch (subRoute) {
      case 'session':
        return await sessionHandler(req, res);
      case 'session/exchange':
        return await sessionExchangeHandler(req, res);
      case 'overview':
        return await overviewHandler(req, res);
      case 'users':
        return await usersHandler(req, res);
      case 'payouts':
        return await payoutsHandler(req, res);
      case 'deposits':
        return await depositsHandler(req, res);
      case 'rooms':
        return await roomsHandler(req, res);
      case 'referrals':
        return await referralsHandler(req, res);
      case 'bot/config':
        return await botConfigHandler(req, res);
      case 'bot/announce':
        return await botAnnounceHandler(req, res);
      case 'notifications':
        return await notificationsHandler(req, res);
      case 'notifications/send':
        return await notificationsSendHandler(req, res);
      case 'settings':
        return await settingsHandler(req, res);
      case 'audit/initial-credits':
        return await auditInitialCreditsHandler(req, res);
      case 'audit/initial-credits/reconcile':
        return await reconcileInitialCreditHandler(req, res);
      case 'audit/rooms':
        return await auditRoomsHandler(req, res);
      case 'audit/rooms/reconcile':
        return await reconcileRoomsHandler(req, res);
      default:
        break;
    }

    const userStatusMatch = /^users\/([^/]+)\/status$/.exec(subRoute);
    if (userStatusMatch) {
      req.query = { ...req.query, uid: decodeURIComponent(userStatusMatch[1]) };
      return await userStatusHandler(req, res);
    }

    const userWalletMatch = /^users\/([^/]+)\/wallet$/.exec(subRoute);
    if (userWalletMatch) {
      req.query = { ...req.query, uid: decodeURIComponent(userWalletMatch[1]) };
      return await userWalletHandler(req, res);
    }

    const payoutReviewMatch = /^payouts\/([^/]+)\/review$/.exec(subRoute);
    if (payoutReviewMatch) {
      req.query = { ...req.query, requestId: decodeURIComponent(payoutReviewMatch[1]) };
      return await payoutReviewHandler(req, res);
    }

    const depositReviewMatch = /^deposits\/([^/]+)\/review$/.exec(subRoute);
    if (depositReviewMatch) {
      req.query = { ...req.query, depositId: decodeURIComponent(depositReviewMatch[1]) };
      return await depositReviewHandler(req, res);
    }

    const roomRoundActionMatch = /^rooms\/([^/]+)\/round-action$/.exec(subRoute);
    if (roomRoundActionMatch) {
      req.query = { ...req.query, roomId: decodeURIComponent(roomRoundActionMatch[1]) };
      return await roomRoundActionHandler(req, res);
    }

    const roomUpdateMatch = /^rooms\/([^/]+)$/.exec(subRoute);
    if (roomUpdateMatch) {
      req.query = { ...req.query, roomId: decodeURIComponent(roomUpdateMatch[1]) };
      return await roomUpdateHandler(req, res);
    }

    sendError(
      res,
      404,
      'admin_endpoint_not_found',
      `Unknown admin endpoint: /api/admin/${subRoute}`
    );
  };
}

