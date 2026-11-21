import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { mintServerSessionToken } from '../../src/utils/adminAuthority.ts';
import {
  normalizeWebhookSecretForTelegram,
  type NotificationEventType,
} from '../../src/utils/telegramBot.ts';
import {
  defaultMenuButtonConfigurator,
  fetchCurrentChatMenuButton,
  TelegramMenuButtonConfigurator,
} from '../../src/utils/telegramMenuButton.ts';
import {
  type AuthBackendDeps,
  authenticateRequest,
  requireValidWebhookSecret,
  resolveAdminSessionSecret,
} from './auth.ts';
import {
  createTelegramCustomToken,
  getAdminDb,
  getTelegramFirebaseUid,
  isFirebaseAdminConfigured,
} from './firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  extractSubRoute,
  findForbiddenOverrideFields,
  getHeaderValue,
  getPublicMiniAppUrl,
  isConfiguredBotToken,
  isConfiguredWebhookSecret,
  parseJsonBody,
  sendError,
  sendJson,
} from './http.ts';
import {
  createFirestoreReplayAdapter,
  PersistentReplayGuard,
} from './replayGuard.ts';
import {
  assertValidTelegramUserId,
  createFirestoreTelegramStore,
  PersistentTelegramBotService,
  verifyTelegramInitDataPersistent,
} from './telegramPersistence.ts';

const FORBIDDEN_AUTH_OVERRIDE_FIELDS = [
  'uid',
  'firebaseUid',
  'telegramUserId',
  'telegramId',
  'isAdmin',
  'demoBalanceEtb',
  'customToken',
  'initDataUnsafe',
  'user',
] as const;

const FORBIDDEN_VALIDATE_FIELDS = [
  'uid',
  'firebaseUid',
  'telegramUserId',
  'telegramId',
  'expectedTelegramUserId',
  'actionNonce',
  'initDataUnsafe',
  'user',
] as const;

const FORBIDDEN_WEBHOOK_FIELDS = ['firebaseUid', 'uid', 'isAdmin'] as const;

const FORBIDDEN_BOT_COMMAND_FIELDS = [
  'senderTelegramId',
  'telegramUserId',
  'firebaseUid',
  'uid',
  'chatId',
  'chatType',
] as const;

const ALLOWED_EVENTS: readonly NotificationEventType[] = [
  'registration_success',
  'game_starting',
  'new_bingo_number',
  'game_completion',
  'winner_announcement',
  'referral_confirmation',
  'support_response',
];

export interface TelegramAuthHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  isAdminReady?: () => boolean;
  mintCustomToken?: typeof createTelegramCustomToken;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

export interface ValidateInitDataHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  isAdminReady?: () => boolean;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

export interface WebhookHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  isAdminReady?: () => boolean;
  fetchImpl?: typeof fetch;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

export interface RegisterWebhookHandlerDeps {
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  fetchImpl?: typeof fetch;
  limiter?: BoundedRateLimiter;
}

export interface WebhookInfoHandlerDeps {
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  fetchImpl?: typeof fetch;
  limiter?: BoundedRateLimiter;
}

export interface BotCommandHandlerDeps {
  getDb?: () => Firestore;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export interface NotifyHandlerDeps {
  getDb?: () => Firestore;
  getWebhookSecret?: () => string | undefined;
  authDeps?: AuthBackendDeps;
  limiter?: BoundedRateLimiter;
}

export interface BotStateHandlerDeps {
  getDb?: () => Firestore;
  getWebhookSecret?: () => string | undefined;
  limiter?: BoundedRateLimiter;
}

export interface ConfigureMenuButtonHandlerDeps {
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  authDeps?: AuthBackendDeps;
  fetchImpl?: typeof fetch;
  configurator?: TelegramMenuButtonConfigurator;
  limiter?: BoundedRateLimiter;
}

export type TelegramRouterDeps = TelegramAuthHandlerDeps &
  WebhookHandlerDeps &
  BotCommandHandlerDeps &
  NotifyHandlerDeps &
  ConfigureMenuButtonHandlerDeps & {
    autoConfigureMenuButton?: boolean;
  };

/**
 * POST /api/telegram/auth
 */
export function createTelegramAuthHandler(deps: TelegramAuthHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_auth',
        limit: 20,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_AUTH_OVERRIDE_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        400,
        'client_identity_override_rejected',
        'Caller-supplied identity or privilege fields are not accepted on this endpoint.'
      );
      return;
    }

    if (body.initData !== undefined && typeof body.initData !== 'string') {
      console.warn('[api/telegram/auth] rejected non-string initData payload', {
        receivedType: typeof body.initData,
      });
      sendError(
        res,
        400,
        'malformed_init_data',
        'Telegram initData must be sent as the raw query string from window.Telegram.WebApp.initData.',
        {
          diagnostics: {
            failureCategory: 'frontend_request_formatting',
            botTokenConfigured: isConfiguredBotToken(
              deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN
            ),
            initDataPresent: true,
          },
        }
      );
      return;
    }

    const rawInitData = typeof body.initData === 'string' ? body.initData.trim() : '';
    if (!rawInitData) {
      sendError(res, 400, 'missing_init_data', 'Telegram Mini App initData is required.', {
        diagnostics: {
          failureCategory: 'missing_init_data',
          initDataPresent: false,
        },
      });
      return;
    }
    if (rawInitData.length > 4096) {
      sendError(res, 400, 'malformed_init_data', 'Telegram initData exceeds allowed length.', {
        diagnostics: {
          failureCategory: 'malformed_init_data',
          initDataPresent: true,
          initDataLength: rawInitData.length,
        },
      });
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      console.warn('[api/telegram/auth] missing or placeholder TELEGRAM_BOT_TOKEN');
      sendError(
        res,
        503,
        'missing_bot_token',
        'Telegram authentication is not configured on the server (missing or invalid TELEGRAM_BOT_TOKEN).',
        {
          diagnostics: {
            failureCategory: 'backend_environment_configuration',
            botTokenConfigured: false,
          },
        }
      );
      return;
    }

    const adminReady = deps.isAdminReady ? deps.isAdminReady() : isFirebaseAdminConfigured();
    if (!adminReady && !deps.getDb) {
      sendError(
        res,
        503,
        'firebase_admin_unavailable',
        'Firebase Admin service is not configured on the server.'
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

    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
    const nowUnixSeconds = deps.nowUnixSeconds ? deps.nowUnixSeconds() : Math.floor(Date.now() / 1000);

    const validation = await verifyTelegramInitDataPersistent({
      rawInitData,
      botToken,
      replayGuard,
      maxAgeSeconds: 3600,
      nowUnixSeconds,
    });

    if (!validation.valid || !validation.telegramUser) {
      console.warn('[api/telegram/auth] initData validation failed', {
        reason: validation.reason,
        diagnostics: validation.diagnostics,
      });
      if (validation.reason === 'replay_detected') {
        sendError(
          res,
          409,
          'replay_detected',
          'This Telegram initData payload has already been used.',
          { diagnostics: validation.diagnostics }
        );
        return;
      }
      if (validation.reason === 'missing_bot_token') {
        sendError(
          res,
          503,
          'missing_bot_token',
          'Telegram authentication is not configured on the server.',
          { diagnostics: validation.diagnostics }
        );
        return;
      }
      if (validation.reason === 'malformed_init_data' || validation.reason === 'missing_hash') {
        sendError(
          res,
          400,
          validation.reason,
          validation.reason === 'missing_hash'
            ? 'Telegram initData is missing its cryptographic hash parameter.'
            : 'Telegram initData query string is malformed.',
          { diagnostics: validation.diagnostics }
        );
        return;
      }
      const message =
        validation.reason === 'expired_auth_date' || validation.reason === 'future_auth_date'
          ? 'Telegram initData auth_date is expired or invalid.'
          : 'Telegram initData verification failed.';
      sendError(res, 401, validation.reason || 'signature_mismatch', message, {
        diagnostics: validation.diagnostics,
      });
      return;
    }

    const tgUser = validation.telegramUser;
    const canonicalUid = getTelegramFirebaseUid(tgUser.id);
    const store = createFirestoreTelegramStore(db);
    const persisted = await store.savePlayerAndBinding({
      telegramUserId: tgUser.id,
      uid: canonicalUid,
      firstName: tgUser.first_name || 'Adey Player',
      lastName: tgUser.last_name || '',
      username: tgUser.username || canonicalUid,
      language: 'am',
    });

    if (!persisted.ok || !persisted.player) {
      sendError(
        res,
        409,
        persisted.reason || 'duplicate_telegram_account',
        'This Telegram account is already bound to another Firebase identity.'
      );
      return;
    }

    // Process invitation / referral deep link atomically during Telegram Mini App authentication
    const candidateStartParam =
      validation.startParam ||
      (typeof body.startParam === 'string' && /^ADEY-[1-9]\d*$/i.test(body.startParam.trim())
        ? body.startParam.trim().toUpperCase()
        : undefined);
    let referralApplied:
      | {
          applied: boolean;
          reason?: string;
          code: string;
          inviterTelegramId?: number;
          inviterBonusEtb?: number;
          inviteeBonusEtb?: number;
        }
      | undefined;
    let finalBalanceEtb = persisted.player.demoBalanceEtb;

    if (
      candidateStartParam &&
      /^ADEY-[1-9]\d*$/i.test(candidateStartParam) &&
      store.processReferralDeepLink
    ) {
      const normalizedRefCode = candidateStartParam.toUpperCase();
      const refRes = await store.processReferralDeepLink({
        inviteeTelegramId: tgUser.id,
        inviteeName: `${persisted.player.firstName} ${persisted.player.lastName || ''}`.trim(),
        inviteeUsername: persisted.player.username,
        referralCode: normalizedRefCode,
      });
      referralApplied = {
        applied: refRes.applied,
        reason: refRes.reason,
        code: normalizedRefCode,
        inviterTelegramId: refRes.inviterTelegramId,
        inviterBonusEtb: refRes.inviterBonusEtb,
        inviteeBonusEtb: refRes.inviteeBonusEtb,
      };
      if (refRes.applied && typeof refRes.inviteeBalanceEtb === 'number') {
        finalBalanceEtb = refRes.inviteeBalanceEtb;
      }
    }

    const mintFn = deps.mintCustomToken ?? createTelegramCustomToken;
    let minted: { uid: string; customToken: string };
    try {
      minted = await mintFn({
        telegramUserId: tgUser.id,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name,
        username: tgUser.username,
        languageCode: tgUser.language_code,
      });
    } catch {
      sendError(
        res,
        503,
        'token_mint_failed',
        'Unable to issue authentication token at this time.'
      );
      return;
    }

    const sessionSecret =
      resolveAdminSessionSecret({
        getSessionSecret: () => undefined,
      }) || (botToken ? resolveAdminSessionSecret({ sessionSecret: botToken }) : null);
    const mintedSession = sessionSecret
      ? mintServerSessionToken(
          {
            uid: minted.uid,
            telegramUserId: tgUser.id,
            displayName: `${persisted.player.firstName} ${persisted.player.lastName || ''}`.trim(),
            username: persisted.player.username,
            nowUnixSeconds,
            expiresInSeconds: 3600,
          },
          sessionSecret
        )
      : undefined;
    const sessionToken = mintedSession?.token;
    const verifiedRole = mintedSession?.actor.role ?? 'player';
    const isAdmin = verifiedRole === 'admin';

    sendJson(res, 200, {
      ok: true,
      uid: minted.uid,
      verifiedTelegramId: tgUser.id,
      role: verifiedRole,
      isAdmin,
      customToken: minted.customToken,
      ...(sessionToken ? { sessionToken } : {}),
      ...(referralApplied ? { referralApplied } : {}),
      profile: {
        uid: minted.uid,
        telegramUserId: tgUser.id,
        role: verifiedRole,
        firstName: persisted.player.firstName,
        lastName: persisted.player.lastName || '',
        username: persisted.player.username,
        language: persisted.player.language,
        phoneVerified: persisted.player.phoneVerified,
        verifiedPhoneMasked: persisted.player.verifiedPhoneMasked,
        demoBalanceEtb: finalBalanceEtb,
        referralCode: persisted.player.referralCode,
      },
    });
  };
}

/**
 * POST /api/telegram/validate-init-data
 */
export function createValidateInitDataHandler(deps: ValidateInitDataHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;
    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_validate_init_data',
        limit: 20,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 16 * 1024, required: true });
    if (!body) return;

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_VALIDATE_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        400,
        'client_identity_override_rejected',
        'Caller-supplied Telegram IDs, Firebase UIDs, or replay nonces are not accepted.'
      );
      return;
    }

    if (body.initData !== undefined && typeof body.initData !== 'string') {
      console.warn('[api/telegram/validate-init-data] rejected non-string initData payload', {
        receivedType: typeof body.initData,
      });
      sendError(
        res,
        400,
        'malformed_init_data',
        'Telegram initData must be sent as the raw query string from window.Telegram.WebApp.initData.',
        {
          verified: false,
          statusCode: 400,
          diagnostics: {
            failureCategory: 'frontend_request_formatting',
            initDataPresent: true,
          },
        }
      );
      return;
    }

    const rawInitData = typeof body.initData === 'string' ? body.initData.trim() : '';
    if (!rawInitData) {
      sendError(
        res,
        400,
        'missing_init_data',
        'No Telegram WebApp initData was provided by the client.',
        {
          verified: false,
          statusCode: 400,
          diagnostics: {
            failureCategory: 'missing_init_data',
            initDataPresent: false,
          },
        }
      );
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      console.warn('[api/telegram/validate-init-data] missing or placeholder TELEGRAM_BOT_TOKEN');
      sendError(
        res,
        503,
        'missing_bot_token',
        'TELEGRAM_BOT_TOKEN is not configured on the server environment.',
        {
          verified: false,
          statusCode: 503,
          diagnostics: {
            failureCategory: 'backend_environment_configuration',
            botTokenConfigured: false,
          },
        }
      );
      return;
    }

    const adminReady = deps.isAdminReady ? deps.isAdminReady() : isFirebaseAdminConfigured();
    if (!adminReady && !deps.getDb) {
      sendError(
        res,
        503,
        'firebase_admin_unavailable',
        'Server replay persistence service is not configured.',
        { verified: false, statusCode: 503 }
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
        'Server persistence service is unavailable.',
        { verified: false, statusCode: 503 }
      );
      return;
    }

    const replayGuard = new PersistentReplayGuard(createFirestoreReplayAdapter(db), 3600);
    const nowUnixSeconds = deps.nowUnixSeconds ? deps.nowUnixSeconds() : Math.floor(Date.now() / 1000);

    const result = await verifyTelegramInitDataPersistent({
      rawInitData,
      botToken,
      replayGuard,
      maxAgeSeconds: 3600,
      nowUnixSeconds,
    });

    if (!result.valid || !result.telegramUser) {
      console.warn('[api/telegram/validate-init-data] validation failed', {
        reason: result.reason,
        diagnostics: result.diagnostics,
      });
      const code =
        result.reason === 'missing_bot_token'
          ? 503
          : result.reason === 'replay_detected'
            ? 409
            : result.reason === 'malformed_init_data' || result.reason === 'missing_hash'
              ? 400
              : 401;
      const message =
        result.reason === 'replay_detected'
          ? 'Duplicate/replayed Telegram initData request blocked.'
          : result.reason === 'future_auth_date' || result.reason === 'expired_auth_date'
            ? 'Telegram initData auth_date is expired or invalid.'
            : result.reason === 'missing_hash'
              ? 'Telegram initData is missing its cryptographic hash parameter.'
              : result.reason === 'malformed_init_data'
                ? 'Telegram initData query string is malformed.'
                : 'Telegram initData cryptographic signature validation failed.';
      sendError(res, code, result.reason || 'signature_mismatch', message, {
        verified: false,
        statusCode: code,
        diagnostics: result.diagnostics,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      verified: true,
      statusCode: 200,
      verifiedTelegramId: result.telegramUser.id,
      telegramUser: result.telegramUser,
      authDate: result.authDate,
      dataCheckHash: result.dataCheckHash,
    });
  };
}

/**
 * POST /api/telegram/webhook
 */
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

    const callbackQueryId =
      typeof callbackObj?.id === 'string' && callbackObj.id.trim() !== ''
        ? callbackObj.id.trim()
        : undefined;

    const botResponse = await botService.handleIncomingUpdate({
      updateId: rawUpdateId,
      callbackQueryId,
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

    if (
      botResponse.securityCode === 'replay_detected' ||
      botResponse.securityCode === 'duplicate_callback_query'
    ) {
      sendError(
        res,
        409,
        botResponse.securityCode,
        botResponse.securityCode === 'duplicate_callback_query'
          ? 'Duplicate Telegram callback_query blocked.'
          : 'Duplicate Telegram webhook update blocked.',
        { duplicate: true, securityCode: botResponse.securityCode }
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
    let callbackAnswered = false;
    let telegramDeliveryNote: string | undefined;

    if (isConfiguredBotToken(botToken) && botResponse.chatId > 0) {
      try {
        if (callbackQueryId) {
          const cbResp = await fetchFn(
            `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                callback_query_id: callbackQueryId,
                ...(botResponse.callbackAnswerText
                  ? { text: botResponse.callbackAnswerText }
                  : {}),
              }),
            }
          );
          callbackAnswered = Boolean(cbResp.ok);
        }

        const rawMarkup = botResponse.replyMarkup;
        const telegramReplyMarkup = rawMarkup?.inline_keyboard?.length
          ? { inline_keyboard: rawMarkup.inline_keyboard }
          : rawMarkup?.keyboard?.length
            ? {
                keyboard: rawMarkup.keyboard,
                resize_keyboard: rawMarkup.resize_keyboard ?? true,
                one_time_keyboard: rawMarkup.one_time_keyboard ?? false,
              }
            : undefined;

        const tgResp = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: botResponse.chatId,
            text: botResponse.text,
            parse_mode: botResponse.parseMode,
            ...(telegramReplyMarkup ? { reply_markup: telegramReplyMarkup } : {}),
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
      text: botResponse.text,
      replyMarkup: botResponse.replyMarkup,
      registrationStatus: botResponse.registrationStatus,
      securityCode: botResponse.securityCode,
      ...(botResponse.callbackAnswerText
        ? { callbackAnswerText: botResponse.callbackAnswerText }
        : {}),
      callbackAnswered,
      deliveredToTelegramApi,
      telegramDeliveryNote,
    });
  };
}

/**
 * POST /api/telegram/register-webhook
 */
export function createRegisterWebhookHandler(deps: RegisterWebhookHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['POST'])) return;

    const rawWebhookSecret = deps.getWebhookSecret
      ? deps.getWebhookSecret()
      : process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!requireValidWebhookSecret(req, res, rawWebhookSecret)) {
      return;
    }

    if (
      !enforceRateLimit(req, res, {
        scope: 'telegram_register_webhook',
        limit: 10,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      sendError(
        res,
        503,
        'missing_bot_token',
        'TELEGRAM_BOT_TOKEN is not configured in server environment.'
      );
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: false });
    if (!body) return;

    const defaultBaseUrl = getPublicMiniAppUrl().replace(/\/+$/, '');
    const candidateUrl = body.baseUrl ?? body.publicBaseUrl;
    let requestedBaseUrl = defaultBaseUrl;
    if (typeof candidateUrl === 'string' && candidateUrl.trim()) {
      const trimmed = candidateUrl.trim().replace(/\/+$/, '');
      if (
        !trimmed.startsWith('https://') ||
        trimmed.includes('ais-dev-') ||
        trimmed.includes('ais-pre-') ||
        trimmed.includes('.run.app')
      ) {
        sendError(
          res,
          400,
          'invalid_public_base_url',
          'baseUrl must be a valid public HTTPS URL.'
        );
        return;
      }
      requestedBaseUrl = trimmed;
    }

    const requestedLaunchUrl = `${requestedBaseUrl}/`;
    const webhookUrl = `${requestedBaseUrl}/api/telegram/webhook`;
    const normalizedSecret = normalizeWebhookSecretForTelegram(rawWebhookSecret!.trim());
    const fetchFn = deps.fetchImpl ?? fetch;

    try {
      const getMeResp = await fetchFn(`https://api.telegram.org/bot${botToken}/getMe`);
      const getMeData = (await getMeResp.json()) as {
        ok?: boolean;
        description?: string;
        result?: {
          id?: number;
          first_name?: string;
          username?: string;
          can_join_groups?: boolean;
        };
      };
      if (!getMeResp.ok || !getMeData.ok) {
        sendError(
          res,
          400,
          'telegram_get_me_failed',
          'Failed to authenticate bot token with Telegram API.'
        );
        return;
      }

      const setCommandsResp = await fetchFn(
        `https://api.telegram.org/bot${botToken}/setMyCommands`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commands: [
              {
                command: 'start',
                description: 'ቦቱን ይጀምሩ እና ዋና ሜኑን ይክፈቱ (Start ADEYBINGO)',
              },
              {
                command: 'wallet',
                description: 'የእኔ ቦርሳ እና ቀሪ ሂሳብ (My Wallet)',
              },
              {
                command: 'deposit',
                description: 'ገንዘብ ያስገቡ (Demo Deposit)',
              },
              {
                command: 'withdraw',
                description: 'ገንዘብ ያውጡ (Demo Withdraw)',
              },
              {
                command: 'invite',
                description: 'ጓደኞችን ይጋብዙ (Invite Friends)',
              },
              {
                command: 'leaderboard',
                description: 'የደረጃ ሰንጠረዥ (Leaderboard)',
              },
              {
                command: 'history',
                description: 'የጨዋታ ታሪክ (Game History)',
              },
              {
                command: 'profile',
                description: 'የእኔ መገለጫ (My Profile)',
              },
              {
                command: 'language',
                description: 'ቋንቋ ይምረጡ / Select Language (አማርኛ / English)',
              },
              {
                command: 'support',
                description: 'እገዛ እና የደንበኞች ድጋፍ (Support)',
              },
              {
                command: 'help',
                description: 'የጨዋታ መመሪያ (Help & Guide)',
              },
              {
                command: 'terms',
                description: 'ህጎች እና የግላዊነት ጥበቃ (Terms & Privacy)',
              },
            ],
          }),
        }
      );
      const setCommandsData = (await setCommandsResp.json()) as { ok?: boolean };

      const menuConfigurator = defaultMenuButtonConfigurator;
      const menuButtonResult = await menuConfigurator.configure({
        botToken,
        miniAppUrl: requestedLaunchUrl,
        fetchImpl: fetchFn,
        force: true,
        checkExistingFirst: false,
        verifyAfterSet: true,
      });

      const setWebhookResp = await fetchFn(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: normalizedSecret,
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: false,
          }),
        }
      );
      const setWebhookData = (await setWebhookResp.json()) as {
        ok?: boolean;
        description?: string;
      };

      const infoResp = await fetchFn(
        `https://api.telegram.org/bot${botToken}/getWebhookInfo`
      );
      const infoData = (await infoResp.json()) as {
        ok?: boolean;
        result?: Record<string, unknown>;
      };

      sendJson(res, 200, {
        ok: Boolean(setWebhookData.ok && infoData.ok),
        botProfile: {
          id: getMeData.result?.id,
          firstName: getMeData.result?.first_name,
          username: getMeData.result?.username,
          canJoinGroups: getMeData.result?.can_join_groups,
        },
        commandsRegistered: Boolean(setCommandsData.ok),
        menuButtonConfigured: Boolean(menuButtonResult.ok && menuButtonResult.configured),
        menuButton: menuButtonResult.verifiedMenuButton || menuButtonResult.menuButton,
        menuButtonStatus: menuButtonResult,
        webhookSet: {
          ok: Boolean(setWebhookData.ok),
          webhookUrl,
          secretTokenConfigured: true,
        },
        webhookInfo: infoData.result || null,
      });
    } catch {
      sendError(
        res,
        502,
        'telegram_api_network_error',
        'Failed to communicate with Telegram Bot API.'
      );
    }
  };
}

/**
 * GET /api/telegram/webhook-info
 */
export function createWebhookInfoHandler(deps: WebhookInfoHandlerDeps = {}) {
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
        scope: 'telegram_webhook_info',
        limit: 30,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      sendJson(res, 200, {
        ok: false,
        telegramBotTokenConfigured: false,
        telegramWebhookSecretConfigured: true,
      });
      return;
    }

    const fetchFn = deps.fetchImpl ?? fetch;
    try {
      const [meResp, infoResp, menuBtnRes] = await Promise.all([
        fetchFn(`https://api.telegram.org/bot${botToken}/getMe`),
        fetchFn(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
        fetchCurrentChatMenuButton({ botToken, fetchImpl: fetchFn }),
      ]);
      const [meData, infoData] = (await Promise.all([meResp.json(), infoResp.json()])) as [
        { ok?: boolean; result?: { id?: number; first_name?: string; username?: string } },
        { ok?: boolean; result?: Record<string, unknown> },
      ];
      sendJson(res, 200, {
        ok: Boolean(meData.ok && infoData.ok),
        telegramBotTokenConfigured: true,
        telegramWebhookSecretConfigured: true,
        botProfile: meData.ok
          ? {
              id: meData.result?.id,
              firstName: meData.result?.first_name,
              username: meData.result?.username,
            }
          : null,
        webhookInfo: infoData.ok ? infoData.result : null,
        menuButton: menuBtnRes.ok ? menuBtnRes.menuButton : null,
      });
    } catch {
      sendError(
        res,
        502,
        'telegram_api_network_error',
        'Failed to fetch Telegram webhook info.'
      );
    }
  };
}

/**
 * POST /api/telegram/bot-command
 */
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
    const callbackQueryId =
      typeof body.callbackQueryId === 'string' && body.callbackQueryId.trim() !== ''
        ? body.callbackQueryId.trim().slice(0, 128)
        : undefined;
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
      callbackQueryId,
      senderTelegramId: caller.telegramId,
      chatId: caller.telegramId,
      chatType: 'private',
      firstName: caller.displayName,
      username: caller.uid,
      text,
      callbackData,
    });

    if (
      botResponse.securityCode === 'replay_detected' ||
      botResponse.securityCode === 'duplicate_callback_query'
    ) {
      sendError(
        res,
        409,
        botResponse.securityCode,
        'Duplicate command or callback query blocked.'
      );
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

/**
 * POST /api/telegram/notify
 */
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

/**
 * GET /api/telegram/bot-state
 */
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

/**
 * POST /api/telegram/configure-menu-button
 * Programmatically configures & verifies AdeyBingo's default Telegram Mini App Menu Button
 * via setChatMenuButton / getChatMenuButton (protected by webhook secret or Admin Bearer token).
 */
export function createConfigureMenuButtonHandler(deps: ConfigureMenuButtonHandlerDeps = {}) {
  const configurator = deps.configurator ?? defaultMenuButtonConfigurator;

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
        scope: 'telegram_configure_menu_button',
        limit: 10,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const body = await parseJsonBody(req, res, { maxBytes: 8 * 1024, required: false });
    if (!body) return;

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      sendError(
        res,
        503,
        'missing_bot_token',
        'TELEGRAM_BOT_TOKEN is not configured in server environment.'
      );
      return;
    }

    const force = body.force === true;
    const result = await configurator.configure({
      botToken,
      miniAppUrl: getPublicMiniAppUrl(),
      fetchImpl: deps.fetchImpl,
      force,
      checkExistingFirst: !force,
      verifyAfterSet: true,
    });

    sendJson(res, result.ok ? 200 : 502, result as unknown as Record<string, unknown>);
  };
}

/**
 * Consolidated router for all 9 `/api/telegram/*` endpoints.
 */
export function createTelegramRouterHandler(deps: TelegramRouterDeps = {}) {
  const authHandler = createTelegramAuthHandler(deps);
  const validateInitDataHandler = createValidateInitDataHandler(deps);
  const webhookHandler = createTelegramWebhookHandler(deps);
  const registerWebhookHandler = createRegisterWebhookHandler(deps);
  const webhookInfoHandler = createWebhookInfoHandler(deps);
  const botCommandHandler = createBotCommandHandler(deps);
  const notifyHandler = createNotifyHandler(deps);
  const botStateHandler = createBotStateHandler(deps);
  const configureMenuButtonHandler = createConfigureMenuButtonHandler(deps);
  const menuConfigurator = deps.configurator ?? defaultMenuButtonConfigurator;

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const subRoute = extractSubRoute(req, '/api/telegram');

    // Deployment-safe once-per-cold-start Menu Button initialization for serverless runtime
    if (
      deps.autoConfigureMenuButton === true &&
      (subRoute === 'webhook' || subRoute === 'auth')
    ) {
      const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
      if (isConfiguredBotToken(botToken)) {
        await menuConfigurator.ensureConfiguredOnce({
          botToken,
          miniAppUrl: getPublicMiniAppUrl(),
          fetchImpl: deps.fetchImpl,
          timeoutMs: 3500,
        });
      }
    }

    switch (subRoute) {
      case 'auth':
        return await authHandler(req, res);
      case 'validate-init-data':
        return await validateInitDataHandler(req, res);
      case 'webhook':
        return await webhookHandler(req, res);
      case 'register-webhook':
        return await registerWebhookHandler(req, res);
      case 'webhook-info':
        return await webhookInfoHandler(req, res);
      case 'configure-menu-button':
        return await configureMenuButtonHandler(req, res);
      case 'bot-command':
        return await botCommandHandler(req, res);
      case 'notify':
        return await notifyHandler(req, res);
      case 'bot-state':
        return await botStateHandler(req, res);
      default:
        sendError(
          res,
          404,
          'telegram_endpoint_not_found',
          `Unknown Telegram endpoint: /api/telegram/${subRoute}`
        );
    }
  };
}
