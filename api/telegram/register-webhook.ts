import type { VercelRequest, VercelResponse } from '@vercel/node';
import { normalizeWebhookSecretForTelegram } from '../../src/utils/telegramBot.ts';
import { requireValidWebhookSecret } from '../_lib/auth.ts';
import {
  BoundedRateLimiter,
  enforceMethod,
  enforceRateLimit,
  getPublicMiniAppUrl,
  isConfiguredBotToken,
  parseJsonBody,
  sendError,
  sendJson,
} from '../_lib/http.ts';

export interface RegisterWebhookHandlerDeps {
  getBotToken?: () => string | undefined;
  getWebhookSecret?: () => string | undefined;
  fetchImpl?: typeof fetch;
  limiter?: BoundedRateLimiter;
}

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

      const setMenuResp = await fetchFn(
        `https://api.telegram.org/bot${botToken}/setChatMenuButton`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            menu_button: {
              type: 'web_app',
              text: '🎱 ቢንጎ ይጫወቱ',
              web_app: { url: requestedLaunchUrl },
            },
          }),
        }
      );
      const setMenuData = (await setMenuResp.json()) as { ok?: boolean };

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
        menuButtonConfigured: Boolean(setMenuData.ok),
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

export default createRegisterWebhookHandler();
