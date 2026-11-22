import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  checkFirestoreConnectivity,
  type FirestoreHealthCheckResult,
  getFirebaseAdminConfigDiagnostics,
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
  checkFirestore?: () => Promise<FirestoreHealthCheckResult>;
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
    const adminDiag = getFirebaseAdminConfigDiagnostics(process.env);
    const firestoreHealth = deps.checkFirestore
      ? await deps.checkFirestore()
      : await checkFirestoreConnectivity();

    sendJson(res, 200, {
      ok: true,
      serverTime: new Date().toISOString(),
      firebaseProjectId: adminDiag.projectId,
      firestoreDatabaseId: adminDiag.databaseId,
      firebaseAdminConfigured: adminDiag.configured,
      firebaseAdminCredentialSource: adminDiag.source,
      firebaseAdminDiagnostic: adminDiag.diagnostic,
      firestoreHealth,
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
