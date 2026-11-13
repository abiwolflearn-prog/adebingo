import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { AuthBackendDeps, authenticateRequest } from '../_lib/auth.ts';
import { getAdminDb } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  findForbiddenOverrideFields,
  getPublicMiniAppUrl,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import {
  createFirestoreReplayAdapter,
  PersistentReplayGuard,
} from '../_lib/replayGuard.ts';
import {
  createFirestoreTelegramStore,
  PersistentTelegramBotService,
} from '../_lib/telegramPersistence.ts';

const FORBIDDEN_BOT_COMMAND_FIELDS = [
  'senderTelegramId',
  'telegramUserId',
  'firebaseUid',
  'uid',
  'chatId',
  'chatType',
] as const;

export interface BotCommandHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export function createBotCommandHandler(deps: BotCommandHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const caller = await authenticateRequest(req, res, deps.authDeps, {
      requireTelegramVerified: true,
    });
    if (!caller || !caller.telegramId) return;

    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_bot_command',
        subject: caller.uid,
        limit: 30,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_BOT_COMMAND_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        403,
        'client_identity_override_rejected',
        'Caller-supplied Telegram or Firebase IDs are forbidden on this endpoint.'
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

    const text = typeof body.text === 'string' ? body.text.slice(0, 256) : '';
    const callbackData =
      typeof body.callbackData === 'string' ? body.callbackData.slice(0, 128) : '';
    const updateId =
      typeof body.updateId === 'number' && Number.isInteger(body.updateId) && body.updateId > 0
        ? body.updateId
        : undefined;

    const store = createFirestoreTelegramStore(db);
    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 86400);
    const botService = new PersistentTelegramBotService(
      store,
      replayGuard,
      getPublicMiniAppUrl()
    );

    const botResponse = await botService.handleIncomingUpdate({
      updateId,
      senderTelegramId: caller.telegramId,
      chatId: caller.telegramId,
      chatType: 'private',
      firstName: caller.displayName,
      username: caller.uid,
      text,
      callbackData,
    });

    if (botResponse.securityCode === 'replay_detected') {
      sendError(res, 409, 'replay_detected', 'Duplicate command update blocked.');
      return;
    }

    const allOutbox = await store.listNotifications(25);
    const myOutbox = allOutbox.filter((m) => m.telegramUserId === caller.telegramId).slice(0, 12);

    sendJson(res, botResponse.ok ? 200 : 400, {
      ok: botResponse.ok,
      chatId: botResponse.chatId,
      language: botResponse.language,
      text: botResponse.text,
      parseMode: botResponse.parseMode,
      replyMarkup: botResponse.replyMarkup,
      registrationStatus: botResponse.registrationStatus,
      securityCode: botResponse.securityCode,
      outbox: myOutbox,
    });
  };
}

export default createBotCommandHandler();
