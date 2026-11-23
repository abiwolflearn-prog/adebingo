import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { type AuthBackendDeps, authenticateRequest } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from '../_lib/gamePersistence.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractIdempotencyKey,
  findForbiddenOverrideFields,
  isValidRoomId,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from '../_lib/replayGuard.ts';

const FORBIDDEN_RESERVE_FIELDS = [
  'uid',
  'playerUid',
  'claimantUid',
  'hostUid',
  'telegramUserId',
  'demoBalanceEtb',
  'cardPrice',
  'isAdmin',
] as const;

export interface ReserveCardHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createReserveCardHandler(deps: ReserveCardHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'cards_reserve',
        subject: caller.uid,
        limit: 60,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_RESERVE_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_override_rejected',
        'Caller-supplied player ID, balance, or price fields are forbidden.'
      );
      return;
    }

    const roomId = body.roomId;
    if (!isValidRoomId(roomId)) {
      sendError(res, 400, 'invalid_room_id', 'A valid roomId is required.');
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

    const rawAction = body.action;
    if (
      rawAction !== undefined &&
      rawAction !== 'reserve' &&
      rawAction !== 'release' &&
      rawAction !== 'toggle'
    ) {
      sendError(
        res,
        400,
        'invalid_action',
        'action must be one of reserve, release, or toggle.'
      );
      return;
    }
    const expectedAction: 'reserve' | 'release' | 'toggle' = rawAction ?? 'toggle';

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

    const result = await service.reserveOrReleaseCard({
      roomId,
      cardId,
      uid: caller.uid,
      displayName: caller.displayName,
      telegramUserId: caller.telegramId ? `tg_${caller.telegramId}` : caller.uid,
      expectedAction,
      idempotencyKey,
    });

    if (!result.ok) {
      const reason = result.reason || 'reservation_failed';
      const statusCode =
        reason === 'invalid_card_id' || reason === 'insufficient_balance'
          ? 400
          : reason === 'account_suspended'
            ? 403
            : reason === 'room_not_found' || reason === 'user_not_found'
              ? 404
              : 409;
      sendError(
        res,
        statusCode,
        reason,
        reason === 'insufficient_balance'
          ? 'Insufficient demo balance (ETB) for this card entry.'
          : reason === 'max_4_cards_reached'
            ? 'Maximum 4 cards per player reached in this room.'
            : reason === 'room_already_live'
              ? 'Card reservations and releases are locked while a game is live.'
              : reason === 'duplicate_request'
                ? 'Duplicate card reservation request blocked.'
                : `Card operation rejected (${reason}).`
      );
      return;
    }

    sendJson(res, 200, {
      ok: true,
      action: result.action,
      roomId,
      cardId,
      cardIds: result.cardIds ?? [],
      updatedBalanceEtb: result.updatedBalanceEtb,
      demoMode: true,
    });
  };
}

export default createReserveCardHandler();
