import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import type { NotificationEventType } from '../../src/utils/telegramBot.ts';
import {
  AuthBackendDeps,
  authenticateRequest,
  requireValidWebhookSecret,
} from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  getHeaderValue,
  getPublicMiniAppUrl,
  isConfiguredWebhookSecret,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import {
  createFirestoreReplayAdapter,
  PersistentReplayGuard,
} from '../_lib/replayGuard.ts';
import {
  assertValidTelegramUserId,
  createFirestoreTelegramStore,
  PersistentTelegramBotService,
} from '../_lib/telegramPersistence.ts';

const ALLOWED_EVENTS: readonly NotificationEventType[] = [
  'registration_success',
  'game_starting',
  'new_bingo_number',
  'game_completion',
  'winner_announcement',
  'referral_confirmation',
  'support_response',
];

export interface NotifyHandlerDeps {
  getDb?: () => Firestore;
  getWebhookSecret?: () => string | undefined;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createNotifyHandler(deps: NotifyHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const secretHeader = getHeaderValue(req, 'x-telegram-bot-api-secret-token');
    const configuredSecret = deps.getWebhookSecret
      ? deps.getWebhookSecret()
      : process.env.TELEGRAM_WEBHOOK_SECRET;

    if (secretHeader !== undefined) {
      if (!requireValidWebhookSecret(req, res, configuredSecret)) {
        return;
      }
    } else {
      const caller = await authenticateRequest(req, res, deps.authDeps, {
        requireAdmin: true,
      });
      if (!caller) return;
      if (isConfiguredWebhookSecret(configuredSecret) === false && !caller.isAdmin) {
        sendError(res, 403, 'admin_required', 'Administrator authorization is required.');
        return;
      }
    }

    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_notify',
        limit: 30,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const event = body.event as NotificationEventType;
    if (!ALLOWED_EVENTS.includes(event)) {
      sendError(res, 400, 'invalid_notification_event', 'Unsupported notification event type.');
      return;
    }

    const telegramUserId = Number(body.telegramUserId);
    try {
      assertValidTelegramUserId(telegramUserId);
    } catch {
      sendError(
        res,
        400,
        'invalid_telegram_user_id',
        'telegramUserId must be a positive integer.'
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
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 86400);
    const botService = new PersistentTelegramBotService(
      store,
      replayGuard,
      getPublicMiniAppUrl()
    );

    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    const notification = await botService.queueNotification(
      event,
      telegramUserId,
      payload,
      false
    );
    const outbox = await store.listNotifications(12);

    sendJson(res, 200, {
      ok: true,
      notification,
      outbox,
    });
  };
}

export default createNotifyHandler();
