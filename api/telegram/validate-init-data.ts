import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb, isFirebaseAdminConfigured } from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  findForbiddenOverrideFields,
  isConfiguredBotToken,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';
import {
  createFirestoreReplayAdapter,
  PersistentReplayGuard,
} from '../_lib/replayGuard.ts';
import { verifyTelegramInitDataPersistent } from '../_lib/telegramPersistence.ts';

const FORBIDDEN_FIELDS = [
  'uid',
  'firebaseUid',
  'telegramUserId',
  'telegramId',
  'expectedTelegramUserId',
  'actionNonce',
] as const;

export interface ValidateInitDataHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  isAdminReady?: () => boolean;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

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

    const forbidden = findForbiddenOverrideFields(body, FORBIDDEN_FIELDS);
    if (forbidden.length > 0) {
      sendError(
        res,
        400,
        'client_identity_override_rejected',
        'Caller-supplied Telegram IDs, Firebase UIDs, or replay nonces are not accepted.'
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
        { verified: false, statusCode: 400 }
      );
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      sendError(
        res,
        503,
        'missing_bot_token',
        'TELEGRAM_BOT_TOKEN is not configured on the server environment.',
        { verified: false, statusCode: 503 }
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
      const code =
        result.reason === 'missing_bot_token'
          ? 503
          : result.reason === 'replay_detected'
            ? 409
            : 401;
      const message =
        result.reason === 'replay_detected'
          ? 'Duplicate/replayed Telegram initData request blocked.'
          : result.reason === 'future_auth_date' || result.reason === 'expired_auth_date'
            ? 'Telegram initData auth_date is expired or invalid.'
            : 'Telegram initData cryptographic signature validation failed.';
      sendError(res, code, result.reason || 'signature_mismatch', message, {
        verified: false,
        statusCode: code,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      verified: true,
      statusCode: 200,
      telegramUser: result.telegramUser,
      authDate: result.authDate,
      dataCheckHash: result.dataCheckHash,
    });
  };
}

export default createValidateInitDataHandler();
