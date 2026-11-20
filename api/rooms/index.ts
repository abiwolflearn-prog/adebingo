import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { type AuthBackendDeps, authenticateRequest } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import { createFirestoreGameStore, PersistentGameAuthorityService } from '../_lib/gamePersistence.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  isValidRoomId,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import { createFirestoreReplayAdapter, PersistentReplayGuard } from '../_lib/replayGuard.ts';

export interface RoomsHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createRoomsHandler(deps: RoomsHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET', 'POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps);
    if (!caller) return;

    if (
      !enforceRateLimit(req, res, {
        scope: req.method === 'POST' ? 'rooms_write' : 'rooms_read',
        subject: caller.uid,
        limit: req.method === 'POST' ? 15 : 60,
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

    const gameStore = createFirestoreGameStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 300);
    const service = new PersistentGameAuthorityService(gameStore, replayGuard);

    if (req.method === 'GET') {
      const rawRoomId = Array.isArray(req.query?.roomId)
        ? req.query.roomId[0]
        : req.query?.roomId;

      if (rawRoomId !== undefined && rawRoomId !== '') {
        if (!isValidRoomId(rawRoomId)) {
          sendError(res, 400, 'invalid_room_id', 'Invalid roomId query parameter.');
          return;
        }
        const detail = await service.getRoomDetail(rawRoomId, caller.uid);
        if (!detail.ok || !detail.room) {
          sendError(res, 404, 'room_not_found', 'Requested room does not exist.');
          return;
        }
        sendJson(res, 200, {
          ok: true,
          serverNowMs: Date.now(),
          room: detail.room,
          myCardIds: detail.myCardIds ?? [],
          takenCardIds: detail.takenCardIds ?? [],
          game: detail.game ?? null,
        });
        return;
      }

      const rooms = await service.listAvailableRooms();
      sendJson(res, 200, {
        ok: true,
        serverNowMs: Date.now(),
        rooms,
      });
      return;
    }

    // POST /api/rooms — Admin-only room creation or default-room initialization
    if (!caller.isAdmin) {
      sendError(
        res,
        403,
        'admin_required',
        'Only administrators may create or initialize game rooms.'
      );
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: true });
    if (!body) return;

    if (body.action === 'initialize_defaults') {
      const rooms = await service.initializeDefaultRooms();
      sendJson(res, 200, {
        ok: true,
        initialized: true,
        rooms,
      });
      return;
    }

    const roomId = body.roomId;
    if (!isValidRoomId(roomId)) {
      sendError(
        res,
        400,
        'invalid_room_input',
        'roomId must be 1–64 alphanumeric, underscore, or hyphen characters.'
      );
      return;
    }

    const nameAm = typeof body.nameAm === 'string' ? body.nameAm.trim() : '';
    const nameEn = typeof body.nameEn === 'string' ? body.nameEn.trim() : '';
    const cardPrice = Number(body.cardPrice);
    const countdownSeconds =
      body.countdownSeconds === undefined ? 60 : Number(body.countdownSeconds);

    const requestedHostUid =
      typeof body.hostUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.hostUid.trim())
        ? body.hostUid.trim()
        : caller.uid;

    const created = await service.createRoom({
      roomId,
      nameAm,
      nameEn,
      cardPrice,
      countdownSeconds,
      hostUid: requestedHostUid,
    });

    if (!created.ok || !created.room) {
      const statusCode = created.reason === 'room_already_exists' ? 409 : 400;
      sendError(
        res,
        statusCode,
        created.reason || 'invalid_room_input',
        created.reason === 'room_already_exists'
          ? 'A room with this roomId already exists.'
          : 'Invalid room configuration parameters.'
      );
      return;
    }

    sendJson(res, 201, {
      ok: true,
      room: created.room,
    });
  };
}

export default createRoomsHandler();
