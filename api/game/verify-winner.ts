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

const FORBIDDEN_VERIFY_FIELDS = [
  'uid',
  'playerUid',
  'claimantUid',
  'hostUid',
  'winnerUid',
  'demoPrizeEtb',
  'demoBalanceEtb',
  'prize',
  'isAdmin',
] as const;

export interface VerifyWinnerHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createVerifyWinnerHandler(deps: VerifyWinnerHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'game_verify_winner',
        subject: caller.uid,
        limit: 20,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_VERIFY_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Caller-supplied winner, claimant UID, or prize fields are forbidden.'
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

    const cardId = Number(body.cardId);
    if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
      sendError(
        res,
        400,
        'invalid_card_id',
        'cardId must be an integer between 1 and 600.'
      );
      return;
    }

    if (!Array.isArray(body.markedNumbers) || body.markedNumbers.length > 75) {
      sendError(
        res,
        400,
        'invalid_marked_numbers',
        'markedNumbers must be an array of at most 75 Bingo integers.'
      );
      return;
    }

    const markedNumbers: number[] = body.markedNumbers
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 75);

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
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    // Note: any client-supplied `calledNumbers` is deliberately ignored;
    // verification always uses authoritative `games/{gameId}.calledNumbers` in Firestore.
    const verifyRes = await service.verifyWinner({
      roomId,
      gameId,
      claimantUid: caller.uid,
      playerName: caller.displayName,
      cardId,
      markedNumbers,
      idempotencyKey,
    });

    if (!verifyRes.verified) {
      const reason = verifyRes.reason || 'pattern_not_satisfied';
      const statusCode =
        reason === 'invalid_card_id' || reason === 'pattern_not_satisfied'
          ? 400
          : reason === 'card_not_owned_by_claimant'
            ? 403
            : reason === 'room_not_found' ||
                reason === 'game_not_found' ||
                reason === 'winner_profile_not_found'
              ? 404
              : 409;
      sendError(
        res,
        statusCode,
        reason,
        reason === 'card_not_owned_by_claimant'
          ? 'You do not own the claimed Bingo card in this room.'
          : reason === 'pattern_not_satisfied'
            ? 'Claimed card does not satisfy a valid Bingo pattern against authoritative called numbers.'
            : reason === 'winner_profile_not_found'
              ? 'Winner user profile does not exist; game completion aborted safely.'
              : `Winner claim rejected (${reason}).`,
        {
          verified: false,
          cardId: verifyRes.cardId,
          winResult: verifyRes.winResult,
          serverVerifiedAt: verifyRes.serverVerifiedAt,
        }
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      verified: true,
      cardId: verifyRes.cardId,
      winResult: verifyRes.winResult,
      demoPrizeEtb: verifyRes.demoPrizeEtb,
      demoMode: true,
      serverVerifiedAt: verifyRes.serverVerifiedAt,
    });
  };
}

export default createVerifyWinnerHandler();
