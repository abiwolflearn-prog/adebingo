import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { requireValidWebhookSecret } from '../_lib/auth.ts';
import { getAdminDb, isFirebaseAdminConfigured } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  findForbiddenOverrideFields,
  getPublicMiniAppUrl,
  isConfiguredBotToken,
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

const FORBIDDEN_WEBHOOK_FIELDS = ['firebaseUid', 'uid', 'isAdmin'] as const;

export interface WebhookHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  isAdminReady?: () => boolean;
  fetchImpl?: typeof fetch;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

export function createTelegramWebhookHandler(deps: WebhookHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const expectedSecret = deps.getWebhookSecret
      ? deps.getWebhookSecret()
      : process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!requireValidWebhookSecret(req, res, expectedSecret)) {
      return;
    }

    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_webhook',
        limit: 120,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 64 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_WEBHOOK_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        400,
        'client_identity_override_rejected',
        'Arbitrary Firebase UID or privilege fields are not permitted in webhook payloads.'
      );
      return;
    }

    const rawUpdateId = body.update_id;
    if (
      typeof rawUpdateId !== 'number' ||
      !Number.isInteger(rawUpdateId) ||
      rawUpdateId <= 0
    ) {
      sendError(
        res,
        400,
        'invalid_update_id',
        'Telegram webhook update_id must be a positive integer.'
      );
      return;
    }

    const messageObj =
      body.message && typeof body.message === 'object'
        ? (body.message as Record<string, unknown>)
        : undefined;
    const callbackObj =
      body.callback_query && typeof body.callback_query === 'object'
        ? (body.callback_query as Record<string, unknown>)
        : undefined;
    const callbackMsg =
      callbackObj?.message && typeof callbackObj.message === 'object'
        ? (callbackObj.message as Record<string, unknown>)
        : undefined;

    const fromObj =
      (messageObj?.from && typeof messageObj.from === 'object'
        ? (messageObj.from as Record<string, unknown>)
        : undefined) ??
      (callbackObj?.from && typeof callbackObj.from === 'object'
        ? (callbackObj.from as Record<string, unknown>)
        : undefined);

    const senderTelegramId = fromObj?.id;
    if (
      typeof senderTelegramId !== 'number' ||
      !Number.isInteger(senderTelegramId) ||
      senderTelegramId <= 0
    ) {
      sendError(
        res,
        400,
        'invalid_telegram_user_id',
        'Telegram webhook payload is missing a valid positive integer sender from.id.'
      );
      return;
    }

    const chatObj =
      (messageObj?.chat && typeof messageObj.chat === 'object'
        ? (messageObj.chat as Record<string, unknown>)
        : undefined) ??
      (callbackMsg?.chat && typeof callbackMsg.chat === 'object'
        ? (callbackMsg.chat as Record<string, unknown>)
        : undefined);

    const rawChatId = chatObj?.id;
    const chatId =
      typeof rawChatId === 'number' && Number.isInteger(rawChatId)
        ? rawChatId
        : undefined;

    const rawChatType = chatObj?.type;
    const chatType: 'private' | 'group' | 'supergroup' | 'channel' | undefined =
      rawChatType === 'private' ||
      rawChatType === 'group' ||
      rawChatType === 'supergroup' ||
      rawChatType === 'channel'
        ? rawChatType
        : undefined;

    const adminReady = deps.isAdminReady ? deps.isAdminReady() : isFirebaseAdminConfigured();
    if (!adminReady && !deps.getDb) {
      sendError(
        res,
        503,
        'firebase_admin_unavailable',
        'Server persistence service is not configured.'
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

    const contactObj =
      messageObj?.contact && typeof messageObj.contact === 'object'
        ? (messageObj.contact as {
            phone_number?: string;
            first_name?: string;
            last_name?: string;
            user_id?: number;
          })
        : null;

    const nowUnixSeconds = deps.nowUnixSeconds ? deps.nowUnixSeconds() : Math.floor(Date.now() / 1000);

    const botResponse = await botService.handleIncomingUpdate({
      updateId: rawUpdateId,
      senderTelegramId,
      chatId,
      chatType,
      firstName: typeof fromObj?.first_name === 'string' ? fromObj.first_name : 'Player',
      lastName: typeof fromObj?.last_name === 'string' ? fromObj.last_name : '',
      username:
        typeof fromObj?.username === 'string'
          ? fromObj.username
          : `tg_${senderTelegramId}`,
      text: typeof messageObj?.text === 'string' ? messageObj.text : '',
      callbackData: typeof callbackObj?.data === 'string' ? callbackObj.data : '',
      contact: contactObj,
      nowUnixSeconds,
    });

    if (botResponse.securityCode === 'replay_detected') {
      sendError(
        res,
        409,
        'replay_detected',
        'Duplicate Telegram webhook update blocked.',
        { duplicate: true, securityCode: 'replay_detected' }
      );
      return;
    }

    if (botResponse.securityCode === 'private_chat_required') {
      sendError(
        res,
        403,
        'private_chat_required',
        'Registration and contact verification are only allowed in a private 1-on-1 Telegram chat.',
        { securityCode: 'private_chat_required' }
      );
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    const fetchFn = deps.fetchImpl ?? fetch;
    let deliveredToTelegramApi = false;
    let telegramDeliveryNote: string | undefined;

    if (isConfiguredBotToken(botToken) && botResponse.chatId > 0) {
      try {
        if (typeof callbackObj?.id === 'string' && callbackObj.id) {
          await fetchFn(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackObj.id }),
          });
        }

        const tgResp = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: botResponse.chatId,
            text: botResponse.text,
            parse_mode: botResponse.parseMode,
            reply_markup: botResponse.replyMarkup,
          }),
        });
        const tgData = (await tgResp.json().catch(() => ({}))) as {
          ok?: boolean;
          description?: string;
        };
        deliveredToTelegramApi = Boolean(tgResp.ok && tgData.ok);
        telegramDeliveryNote = deliveredToTelegramApi ? 'delivered' : 'send_failed';
      } catch {
        deliveredToTelegramApi = false;
        telegramDeliveryNote = 'network_error';
      }
    }

    sendJson(res, 200, {
      ok: botResponse.ok,
      chatId: botResponse.chatId,
      language: botResponse.language,
      registrationStatus: botResponse.registrationStatus,
      securityCode: botResponse.securityCode,
      deliveredToTelegramApi,
      telegramDeliveryNote,
    });
  };
}

export default createTelegramWebhookHandler();
