import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import {
  mintServerSessionToken,
  PayoutOrderStatus,
  DepositRequestStatus,
  AdminRoomConfigRecord,
  VerifiedSessionActor,
} from '../../src/utils/adminAuthority.ts';
import type { BotButtonLabelsConfig } from '../../src/utils/telegramBot.ts';
import { PersistentAdminService } from './adminPersistence.ts';
import {
  AuthBackendDeps,
  AuthenticatedCaller,
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
  isConfiguredBotToken,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
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
  return match && match[1] ? decodeURIComponent(match[1]) : '';
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
          : result.reason === 'already_finalized'
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
          : result.reason === 'already_finalized'
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
    const payloadTitle =
      typeof body.title === 'string' && body.title.trim()
        ? body.title
        : typeof (body.payload as { title?: string })?.title === 'string'
          ? String((body.payload as { title?: string }).title)
          : '🌼 ADEYBINGO Notification';
    const payloadBody =
      typeof body.body === 'string' && body.body.trim()
        ? body.body
        : typeof (body.payload as { customMessage?: string })?.customMessage === 'string'
          ? String((body.payload as { customMessage?: string }).customMessage)
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
