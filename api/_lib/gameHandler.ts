import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { AuthBackendDeps, authenticateRequest } from './auth.ts';
import { getAdminDb } from './firebaseAdmin.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from './gamePersistence.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractIdempotencyKey,
  extractSubRoute,
  findForbiddenOverrideFields,
  isValidGameId,
  isValidRoomId,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from './replayGuard.ts';

const FORBIDDEN_START_FIELDS = [
  'hostUid',
  'callerUid',
  'playerUid',
  'winnerUid',
  'calledNumbers',
  'demoPrizeEtb',
  'demoBalanceEtb',
  'isAdmin',
] as const;

const FORBIDDEN_DRAW_FIELDS = [
  'hostUid',
  'callerUid',
  'playerUid',
  'winnerUid',
  'demoPrizeEtb',
  'demoBalanceEtb',
  'isAdmin',
] as const;

const FORBIDDEN_RESET_FIELDS = [
  'hostUid',
  'callerUid',
  'playerUid',
  'winnerUid',
  'calledNumbers',
  'roundNumber',
  'isAdmin',
] as const;

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

export interface GameHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export type StartGameHandlerDeps = GameHandlerDeps;
export type DrawBallHandlerDeps = GameHandlerDeps;
export type ResetRoundHandlerDeps = GameHandlerDeps;
export type VerifyWinnerHandlerDeps = GameHandlerDeps;

/**
 * POST /api/game/start
 */
export function createStartGameHandler(deps: StartGameHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'game_start',
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

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_START_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Client-supplied host UID, called numbers, or prize fields are forbidden.'
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

    const result = await service.startGame({
      roomId,
      gameId,
      callerUid: caller.uid,
      isAdmin: caller.isAdmin,
      idempotencyKey,
    });

    if (!result.ok || !result.game) {
      const reason = result.reason || 'start_game_failed';
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
          ? 'Only the authorized room host or administrator may start this game.'
          : reason === 'eligibility_not_met'
            ? 'Room eligibility conditions (minimum players and reserved cards) are not met.'
            : `Cannot start game (${reason}).`
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      game: result.game,
    });
  };
}

/**
 * POST /api/game/draw-ball
 */
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

/**
 * POST /api/game/reset-round
 */
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

/**
 * POST /api/game/verify-winner
 */
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

/**
 * Consolidated router for all 4 `/api/game/*` endpoints.
 */
export function createGameRouterHandler(deps: GameHandlerDeps = {}) {
  const startHandler = createStartGameHandler(deps);
  const drawBallHandler = createDrawBallHandler(deps);
  const resetRoundHandler = createResetRoundHandler(deps);
  const verifyWinnerHandler = createVerifyWinnerHandler(deps);

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const subRoute = extractSubRoute(req, '/api/game');

    switch (subRoute) {
      case 'start':
        return await startHandler(req, res);
      case 'draw-ball':
        return await drawBallHandler(req, res);
      case 'reset-round':
        return await resetRoundHandler(req, res);
      case 'verify-winner':
        return await verifyWinnerHandler(req, res);
      default:
        sendError(
          res,
          404,
          'game_endpoint_not_found',
          `Unknown game endpoint: /api/game/${subRoute}`
        );
    }
  };
}
