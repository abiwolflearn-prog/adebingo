import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireValidWebhookSecret } from '../_lib/auth.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  isConfiguredBotToken,
  sendError,
  sendJson,
} from '../_lib/http.ts';

export interface WebhookInfoHandlerDeps {
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  fetchImpl?: typeof fetch;
  limiter?: BoundedRateLimiter;
}

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
      const [meResp, infoResp] = await Promise.all([
        fetchFn(`https://api.telegram.org/bot${botToken}/getMe`),
        fetchFn(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
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

export default createWebhookInfoHandler();
