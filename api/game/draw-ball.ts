import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { AuthBackendDeps, authenticateRequest } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from '../_lib/gamePersistence.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractIdempotencyKey,
  findForbiddenOverrideFields,
  isValidGameId,
  isValidRoomId,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from '../_lib/replayGuard.ts';

const FORBIDDEN_DRAW_FIELDS = [
  'hostUid',
  'callerUid',
  'playerUid',
  'winnerUid',
  'demoPrizeEtb',
  'demoBalanceEtb',
  'isAdmin',
] as const;

export interface DrawBallHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createDrawBallHandler(deps: DrawBallHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'game_draw_ball',
        subject: caller.uid,
        limit: 120,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_DRAW_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Client-supplied host, caller, or prize fields are forbidden.'
      );
      return;
    }

    const roomId = body.roomId === undefined ? 'adey-main' : body.roomId;
    if (!isValidRoomId(roomId)) {
      sendError(res, 400, 'invalid_room_id', 'Invalid roomId parameter.');
      return;
    }

    const gameId = body.gameId === undefined ? undefined : body.gameId;
    if (gameId !== undefined && !isValidGameId(gameId)) {
      sendError(res, 400, 'invalid_game_id', 'Invalid gameId parameter.');
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

    const requestNonce = extractIdempotencyKey(req, body);
    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    // Note: client-supplied `calledNumbers` is deliberately ignored; Firestore is authoritative.
    const drawResult = await service.drawNextBall({
      roomId,
      gameId,
      callerUid: caller.uid,
      requestNonce,
      isAdmin: caller.isAdmin,
      requireExplicitHostOrAdmin: true,
    });

    if (!drawResult.ok || !drawResult.ball) {
      const reason = drawResult.reason || 'draw_ball_failed';
      const statusCode =
        reason === 'unauthorized_caller'
          ? 403
          : reason === 'room_not_found'
            ? 404
            : 409;
      sendError(
        res,
        statusCode,
        reason,
        reason === 'unauthorized_caller'
          ? 'Only the authorized room host or administrator may draw balls.'
          : reason === 'replay_detected'
            ? 'Duplicate ball draw request blocked.'
            : `Cannot draw next ball (${reason}).`
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ball: drawResult.ball,
      letter: drawResult.letter,
      formatted: drawResult.formatted,
      calledNumbers: drawResult.calledNumbers,
      totalCalled: drawResult.totalCalled,
      serverTimestamp: drawResult.serverTimestamp,
    });
  };
}

export default createDrawBallHandler();
