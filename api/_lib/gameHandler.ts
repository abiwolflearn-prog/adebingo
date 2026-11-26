import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Modality } from '@google/genai';
import { getBingoVoiceCallScript } from '../../src/utils/amharicNumbers.ts';
import {
  type AuthBackendDeps,
  authenticateRequest,
  extractBearerToken,
  requirePhoneVerifiedPlayer,
} from './auth.ts';
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
  getCronSecret?: () => string | undefined;
  getGeminiApiKey?: () => string | undefined;
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

    if (!(await requirePhoneVerifiedPlayer(db, caller, res))) {
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

    if (!(await requirePhoneVerifiedPlayer(db, caller, res))) {
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

    if (!(await requirePhoneVerifiedPlayer(db, caller, res))) {
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
      winners: verifyRes.winners ?? [],
      winnersPrizePoolEtb: verifyRes.winnersPrizePoolEtb,
      demoMode: true,
      serverVerifiedAt: verifyRes.serverVerifiedAt,
    });
  };
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractHeaderString(req: VercelRequest, headerName: string): string | null {
  const raw = req.headers?.[headerName];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim() !== '') {
    return raw[0].trim();
  }
  return null;
}

async function authorizeSchedulerOrAdmin(
  req: VercelRequest,
  res: VercelResponse,
  deps: GameHandlerDeps
): Promise<'cron_secret' | 'admin_token' | null> {
  const configuredCronSecret = (
    deps.getCronSecret ? deps.getCronSecret() : process.env.CRON_SECRET
  )?.trim();
  const bearerToken = extractBearerToken(req);
  const cronHeaderToken = extractHeaderString(req, 'x-cron-secret');
  const providedCronToken = cronHeaderToken || bearerToken;

  const looksLikeSignedToken = Boolean(
    bearerToken &&
      (bearerToken.split('.').length === 2 || bearerToken.split('.').length === 3)
  );

  if (
    configuredCronSecret &&
    configuredCronSecret.length >= 16 &&
    providedCronToken &&
    timingSafeEqualStrings(providedCronToken, configuredCronSecret)
  ) {
    return 'cron_secret';
  }

  if (!cronHeaderToken && looksLikeSignedToken) {
    const caller = await authenticateRequest(req, res, deps.authDeps, {
      requireAdmin: true,
    });
    if (!caller) return null;
    return 'admin_token';
  }

  if (!configuredCronSecret || configuredCronSecret.length < 16) {
    sendError(
      res,
      503,
      'cron_secret_not_configured',
      'Scheduler CRON_SECRET is not configured on the server.'
    );
    return null;
  }

  sendError(
    res,
    401,
    'invalid_cron_secret',
    'Valid CRON_SECRET or Administrator authorization is required.'
  );
  return null;
}

/**
 * GET / POST /api/game/tick
 * Persistent idempotent 24/7 scheduler tick endpoint (compatible with external 3-5s
 * schedulers and admin POST invocations).
 * Requires either a valid CRON_SECRET (`Authorization: Bearer <CRON_SECRET>` or `x-cron-secret`)
 * OR a cryptographically verified Administrator token. Fails closed if unauthorized.
 */
export function createSchedulerTickHandler(deps: GameHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET', 'POST'])) return;

    const authorizedVia = await authorizeSchedulerOrAdmin(req, res, deps);
    if (!authorizedVia) return;

    const isPost = (req.method || 'GET').toUpperCase() === 'POST';
    let body: Record<string, unknown> = {};
    if (isPost) {
      const parsed = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: false });
      if (!parsed) return;
      body = parsed;
    }

    const rawRoomIdQuery = Array.isArray(req.query?.roomId)
      ? req.query.roomId[0]
      : req.query?.roomId;
    const rawRoomId =
      typeof body.roomId === 'string'
        ? body.roomId
        : typeof rawRoomIdQuery === 'string'
          ? rawRoomIdQuery
          : undefined;
    if (rawRoomId !== undefined && rawRoomId !== '' && !isValidRoomId(rawRoomId)) {
      sendError(res, 400, 'invalid_room_id', 'Invalid roomId parameter.');
      return;
    }
    const roomId = rawRoomId && rawRoomId !== '' ? rawRoomId : undefined;

    const rawWorkerQuery = Array.isArray(req.query?.workerId)
      ? req.query.workerId[0]
      : req.query?.workerId;
    const workerId =
      typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim().slice(0, 64)
        : typeof rawWorkerQuery === 'string' && rawWorkerQuery.trim()
          ? rawWorkerQuery.trim().slice(0, 64)
          : authorizedVia === 'cron_secret'
            ? 'vercel_cron_worker'
            : 'admin_manual_worker';

    const rawMaxSteps =
      body.maxSteps !== undefined
        ? Number(body.maxSteps)
        : req.query?.maxSteps !== undefined
          ? Number(Array.isArray(req.query.maxSteps) ? req.query.maxSteps[0] : req.query.maxSteps)
          : 6;
    const maxSteps = Number.isFinite(rawMaxSteps)
      ? Math.max(1, Math.min(20, Math.floor(rawMaxSteps)))
      : 6;

    const rawCatchUp =
      body.catchUp !== undefined
        ? Boolean(body.catchUp)
        : req.query?.catchUp !== undefined
          ? String(Array.isArray(req.query.catchUp) ? req.query.catchUp[0] : req.query.catchUp) !== 'false'
          : true;

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

    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    if (roomId) {
      const results = await service.tickRoomSchedulerCatchUp({
        roomId,
        workerId,
        maxSteps,
        catchUpMissedIntervals: rawCatchUp,
      });
      sendJson(res, 200, {
        ok: true,
        authorizedVia,
        serverNowMs: Date.now(),
        results,
      });
      return;
    }

    const results = await service.tickAllRoomsCatchUp({
      workerId,
      maxStepsPerRoom: maxSteps,
      catchUpMissedIntervals: rawCatchUp,
    });
    sendJson(res, 200, {
      ok: true,
      authorizedVia,
      serverNowMs: Date.now(),
      results,
    });
  };
}

/**
 * GET /api/game/scheduler-status
 * Protected by CRON_SECRET or verified Administrator Bearer token.
 */
export function createSchedulerStatusHandler(deps: GameHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;

    const authorizedVia = await authorizeSchedulerOrAdmin(req, res, deps);
    if (!authorizedVia) return;

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

    const rawRoomId = typeof req.query?.roomId === 'string' ? req.query.roomId.trim() : undefined;
    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    const [rooms, auditLogs] = await Promise.all([
      service.listAvailableRooms(),
      service.listSchedulerAuditLogs(rawRoomId || undefined, 25),
    ]);

    sendJson(res, 200, {
      ok: true,
      authorizedVia,
      serverNowMs: Date.now(),
      mode: '24_7_autonomous',
      cronSecretConfigured: Boolean(
        ((deps.getCronSecret ? deps.getCronSecret() : process.env.CRON_SECRET) || '').trim()
          .length >= 16
      ),
      minPlayersDefault: 3,
      maxCapacityPlayers: 600,
      rooms,
      auditLogs,
    });
  };
}

function pcm16ToWavBase64(pcmBase64: string, sampleRate = 24000, numChannels = 1): string {
  const pcmBuf = Buffer.from(pcmBase64, 'base64');
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]).toString('base64');
}

const ttsAudioCache = new Map<string, { audioBase64: string; mimeType: string }>();

/**
 * GET /api/tts/bingo-call?number=1..75&lang=am|en
 * Server-side Gemini TTS voice caller for Vercel production (rewritten via /api/game?route=tts/bingo-call).
 * Returns 503 with reason `gemini_api_key_not_configured` when GEMINI_API_KEY is absent so clients fall back cleanly to Web Speech.
 */
export function createBingoCallTtsHandler(deps: GameHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'tts_bingo_call',
        limit: 120,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const rawNum = Array.isArray(req.query?.number) ? req.query.number[0] : req.query?.number;
    const rawLang = Array.isArray(req.query?.lang) ? req.query.lang[0] : req.query?.lang;
    const ballNumber = Number(rawNum);
    const lang: 'am' | 'en' = rawLang === 'en' ? 'en' : 'am';

    if (!Number.isInteger(ballNumber) || ballNumber < 1 || ballNumber > 75) {
      sendError(res, 400, 'invalid_ball_number', 'number must be an integer between 1 and 75.');
      return;
    }

    const script = getBingoVoiceCallScript(ballNumber, lang);
    const cacheKey = `${lang}:${ballNumber}`;
    const cached = ttsAudioCache.get(cacheKey);
    if (cached) {
      sendJson(res, 200, {
        ok: true,
        audioBase64: cached.audioBase64,
        mimeType: cached.mimeType,
        script,
      });
      return;
    }

    const apiKey = (
      deps.getGeminiApiKey ? deps.getGeminiApiKey() : process.env.GEMINI_API_KEY
    )?.trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      sendJson(res, 503, {
        ok: false,
        audioBase64: null,
        reason: 'gemini_api_key_not_configured',
        script,
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt =
        lang === 'am'
          ? `Speak this Ethiopian Bingo ball call clearly in natural Amharic with a warm female host voice: "${script.amharicText}"`
          : `Speak this Bingo ball call clearly in English with a warm female host voice: "${script.englishText}"`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        sendJson(res, 503, {
          ok: false,
          audioBase64: null,
          reason: 'tts_generation_empty',
          script,
        });
        return;
      }

      const rawMime = inlineData.mimeType || 'audio/pcm';
      const isPcm = /pcm|L16/i.test(rawMime);
      const audioBase64 = isPcm ? pcm16ToWavBase64(inlineData.data) : inlineData.data;
      const mimeType = isPcm ? 'audio/wav' : rawMime;

      if (ttsAudioCache.size < 200) {
        ttsAudioCache.set(cacheKey, { audioBase64, mimeType });
      }

      sendJson(res, 200, {
        ok: true,
        audioBase64,
        mimeType,
        script,
      });
    } catch {
      sendJson(res, 503, {
        ok: false,
        audioBase64: null,
        reason: 'tts_generation_failed',
        script,
      });
    }
  };
}

/**
 * Consolidated router for `/api/game/*` and `/api/tts/*` endpoints.
 */
export function createGameRouterHandler(deps: GameHandlerDeps = {}) {
  const startHandler = createStartGameHandler(deps);
  const drawBallHandler = createDrawBallHandler(deps);
  const resetRoundHandler = createResetRoundHandler(deps);
  const verifyWinnerHandler = createVerifyWinnerHandler(deps);
  const tickHandler = createSchedulerTickHandler(deps);
  const schedulerStatusHandler = createSchedulerStatusHandler(deps);
  const ttsHandler = createBingoCallTtsHandler(deps);

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
      case 'tick':
        return await tickHandler(req, res);
      case 'scheduler-status':
        return await schedulerStatusHandler(req, res);
      case 'tts/bingo-call':
      case 'bingo-call':
        return await ttsHandler(req, res);
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
