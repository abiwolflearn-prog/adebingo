import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { requireValidWebhookSecret } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  getPublicMiniAppUrl,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import {
  assertValidTelegramUserId,
  createFirestoreTelegramStore,
} from '../_lib/telegramPersistence.ts';

export interface BotStateHandlerDeps {
  getDb?: () => Firestore;
  getWebhookSecret?: () => string | undefined;
  limiter?: BoundedRateLimiter;
}

export function createBotStateHandler(deps: BotStateHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;

    const expectedSecret = deps.getWebhookSecret
      ? deps.getWebhookSecret()
      : process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!requireValidWebhookSecret(req, res, expectedSecret)) {
      return;
    }

    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_bot_state',
        limit: 30,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const rawId = Array.isArray(req.query?.telegramUserId)
      ? req.query.telegramUserId[0]
      : req.query?.telegramUserId;
    const telegramUserId = Number(rawId);
    try {
      assertValidTelegramUserId(telegramUserId);
    } catch {
      sendError(
        res,
        400,
        'invalid_telegram_user_id',
        'telegramUserId query parameter must be a positive integer.'
      );
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

    const store = createFirestoreTelegramStore(db);
    const [player, outbox] = await Promise.all([
      store.getPlayer(telegramUserId),
      store.listNotifications(12),
    ]);

    sendJson(res, 200, {
      ok: true,
      miniAppUrl: getPublicMiniAppUrl(),
      language: player?.language || 'am',
      player: player
        ? {
            uid: player.uid,
            telegramUserId: player.telegramUserId,
            firstName: player.firstName,
            lastName: player.lastName || '',
            username: player.username,
            language: player.language,
            phoneVerified: player.phoneVerified,
            demoBalanceEtb: player.demoBalanceEtb,
          }
        : null,
      outbox,
    });
  };
}

export default createBotStateHandler();
