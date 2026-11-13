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

const FORBIDDEN_RESET_FIELDS = [
  'hostUid',
  'callerUid',
  'playerUid',
  'winnerUid',
  'calledNumbers',
  'roundNumber',
  'isAdmin',
] as const;

export interface ResetRoundHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createResetRoundHandler(deps: ResetRoundHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'game_reset_round',
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

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_RESET_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Client-supplied host, roundNumber, or calledNumbers fields are forbidden.'
      );
      return;
    }

    const roomId = body.roomId;
    if (!isValidRoomId(roomId)) {
      sendError(res, 400, 'invalid_room_id', 'A valid roomId is required.');
      return;
    }

    const gameId = body.gameId === undefined ? undefined : body.gameId;
    if (gameId !== undefined && !isValidGameId(gameId)) {
      sendError(res, 400, 'invalid_game_id', 'Invalid gameId format.');
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

    const idempotencyKey = extractIdempotencyKey(req, body);
    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    const resetRes = await service.resetRound({
      roomId,
      gameId,
      callerUid: caller.uid,
      isAdmin: caller.isAdmin,
      requireExplicitHostOrAdmin: true,
      idempotencyKey,
    });

    if (!resetRes.ok) {
      const reason = resetRes.reason || 'reset_round_failed';
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
          ? 'Only the authorized room host or administrator may reset this round.'
          : `Cannot reset round (${reason}).`
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      roomId,
      gameId: gameId || `game_${roomId}_live`,
      status: 'countdown',
    });
  };
}

export default createResetRoundHandler();
