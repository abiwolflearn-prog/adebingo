import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  FIREBASE_DATABASE_ID,
  FIREBASE_PROJECT_ID,
  isFirebaseAdminConfigured,
} from '../_lib/firebaseAdmin.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  getPublicMiniAppUrl,
  isConfiguredBotToken,
  isConfiguredWebhookSecret,
  sendJson,
} from '../_lib/http.ts';

export interface StatusHandlerDeps {
  limiter?: BoundedRateLimiter;
}

export function createStatusHandler(deps: StatusHandlerDeps = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!enforceMethod(req, res, ['GET'])) return;
    if (
      !enforceRateLimit(req, res, {
        scope: 'backend_status',
        limit: 60,
        windowSeconds: 60,
        limiter: deps.limiter,
      })
    ) {
      return;
    }

    const miniAppUrl = getPublicMiniAppUrl();
    const publicBase = miniAppUrl.replace(/\/+$/, '');

    sendJson(res, 200, {
      ok: true,
      serverTime: new Date().toISOString(),
      firebaseProjectId: process.env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID,
      firestoreDatabaseId:
        process.env.FIREBASE_FIRESTORE_DATABASE_ID || FIREBASE_DATABASE_ID,
      firebaseAdminConfigured: isFirebaseAdminConfigured(),
      telegramBotTokenConfigured: isConfiguredBotToken(process.env.TELEGRAM_BOT_TOKEN),
      telegramWebhookSecretConfigured: isConfiguredWebhookSecret(
        process.env.TELEGRAM_WEBHOOK_SECRET
      ),
      miniAppUrl,
      webhookEndpointUrl: `${publicBase}/api/telegram/webhook`,
      mode: 'demo_sandbox',
    });
  };
}

export default createStatusHandler();
