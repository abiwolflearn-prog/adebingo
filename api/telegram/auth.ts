import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Firestore } from 'firebase-admin/firestore';
import { mintServerSessionToken } from '../../src/utils/adminAuthority.ts';
import {
  createTelegramCustomToken,
  getAdminDb,
  getTelegramFirebaseUid,
  isFirebaseAdminConfigured,
} from '../_lib/firebaseAdmin.ts';
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
import {
  createFirestoreTelegramStore,
  verifyTelegramInitDataPersistent,
} from '../_lib/telegramPersistence.ts';

const FORBIDDEN_AUTH_OVERRIDE_FIELDS = [
  'uid',
  'firebaseUid',
  'telegramUserId',
  'telegramId',
  'isAdmin',
  'demoBalanceEtb',
  'customToken',
] as const;

export interface TelegramAuthHandlerDeps {
  getDb?: () => Firestore;
  getBotToken?: () => string | undefined;
  isAdminReady?: () => boolean;
  mintCustomToken?: typeof createTelegramCustomToken;
  nowUnixSeconds?: () => number;
  limiter?: BoundedRateLimiter;
}

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

    const rawInitData = typeof body.initData === 'string' ? body.initData.trim() : '';
    if (!rawInitData) {
      sendError(res, 400, 'missing_init_data', 'Telegram Mini App initData is required.');
      return;
    }
    if (rawInitData.length > 4096) {
      sendError(res, 400, 'invalid_init_data', 'Telegram initData exceeds allowed length.');
      return;
    }

    const botToken = deps.getBotToken ? deps.getBotToken() : process.env.TELEGRAM_BOT_TOKEN;
    if (!isConfiguredBotToken(botToken)) {
      sendError(
        res,
        503,
        'missing_bot_token',
        'Telegram authentication is not configured on the server.'
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
      if (validation.reason === 'replay_detected') {
        sendError(
          res,
          409,
          'replay_detected',
          'This Telegram initData payload has already been used.'
        );
        return;
      }
      if (validation.reason === 'missing_bot_token') {
        sendError(
          res,
          503,
          'missing_bot_token',
          'Telegram authentication is not configured on the server.'
        );
        return;
      }
      const message =
        validation.reason === 'expired_auth_date' || validation.reason === 'future_auth_date'
          ? 'Telegram initData auth_date is expired or invalid.'
          : 'Telegram initData verification failed.';
      sendError(res, 401, validation.reason || 'signature_mismatch', message);
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
      language: tgUser.language_code === 'en' ? 'en' : 'am',
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

    const secret =
      (process.env.ADEY_ADMIN_SESSION_SECRET ||
        process.env.TELEGRAM_WEBHOOK_SECRET ||
        botToken ||
        '').trim();
    const sessionToken =
      secret.length >= 8
        ? mintServerSessionToken(
            {
              uid: minted.uid,
              telegramUserId: tgUser.id,
              displayName: `${persisted.player.firstName} ${persisted.player.lastName || ''}`.trim(),
              username: persisted.player.username,
              nowUnixSeconds,
              expiresInSeconds: 3600,
            },
            secret.startsWith('adeybingo_admin_session_secret_')
              ? secret
              : `adeybingo_admin_session_secret_${secret}`
          ).token
        : undefined;

    sendJson(res, 200, {
      ok: true,
      uid: minted.uid,
      verifiedTelegramId: tgUser.id,
      customToken: minted.customToken,
      ...(sessionToken ? { sessionToken } : {}),
      profile: {
        uid: minted.uid,
        telegramUserId: tgUser.id,
        firstName: persisted.player.firstName,
        lastName: persisted.player.lastName || '',
        username: persisted.player.username,
        language: persisted.player.language,
        phoneVerified: persisted.player.phoneVerified,
        verifiedPhoneMasked: persisted.player.verifiedPhoneMasked,
        demoBalanceEtb: persisted.player.demoBalanceEtb,
        referralCode: persisted.player.referralCode,
      },
    });
  };
}

export default createTelegramAuthHandler();
