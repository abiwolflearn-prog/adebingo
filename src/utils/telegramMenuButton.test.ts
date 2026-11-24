import test from 'node:test';
import assert from 'node:assert/strict';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  ADEYBINGO_MENU_BUTTON_TEXT,
  buildAdeyBingoMenuButtonPayload,
  fetchCurrentChatMenuButton,
  sanitizeTelegramApiError,
  TelegramMenuButtonConfigurator,
} from './telegramMenuButton.ts';
import { DEFAULT_DEPLOYED_MINI_APP_URL } from './telegramBot.ts';
import {
  createConfigureMenuButtonHandler,
  createRegisterWebhookHandler,
  createTelegramRouterHandler,
} from '../../api/_lib/telegramHandler.ts';
import { BoundedRateLimiter } from '../../api/_lib/http.ts';

function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void>,
  reqInit: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
  }
) {
  return new Promise<{ statusCode: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(reqInit.headers || {})) {
      headers[k.toLowerCase()] = v;
    }
    if (reqInit.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    const req = {
      method: reqInit.method || 'GET',
      url: reqInit.url || '/',
      headers,
      query: reqInit.query || {},
      body: reqInit.body,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as VercelRequest;

    let statusCode = 200;
    const res = {
      setHeader() {
        return res;
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: Record<string, unknown>) {
        resolve({ statusCode, body: payload });
        return res;
      },
    } as unknown as VercelResponse;

    handler(req, res).catch(reject);
  });
}

test('buildAdeyBingoMenuButtonPayload uses official web_app schema and canonical production URL', () => {
  const payload = buildAdeyBingoMenuButtonPayload(
    'https://ais-dev-example-12345.europe-west1.run.app'
  );
  assert.deepEqual(payload, {
    menu_button: {
      type: 'web_app',
      text: ADEYBINGO_MENU_BUTTON_TEXT,
      web_app: {
        url: DEFAULT_DEPLOYED_MINI_APP_URL,
      },
    },
  });
  assert.equal(payload.menu_button.text, 'Open AdeyBingo');
  assert.equal(payload.menu_button.web_app.url, 'https://adebingo-3nta.vercel.app/');
});

test('TelegramMenuButtonConfigurator configures via setChatMenuButton, verifies via getChatMenuButton, and avoids redundant API calls', async () => {
  const token = '123456789:AAExampleSecretTokenForMenuTest99';
  const calls: Array<{ url: string; body: unknown }> = [];
  const logs: string[] = [];
  let remoteButton: Record<string, unknown> = { type: 'default' };

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body: parsedBody });

    if (url.endsWith('/getChatMenuButton')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: remoteButton }),
      } as unknown as Response;
    }
    if (url.endsWith('/setChatMenuButton')) {
      remoteButton = (parsedBody as { menu_button: Record<string, unknown> }).menu_button;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const logger = {
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => logs.push(args.join(' ')),
  };

  const configurator = new TelegramMenuButtonConfigurator();
  const first = await configurator.ensureConfiguredOnce({
    botToken: token,
    miniAppUrl: 'https://adebingo-3nta.vercel.app/',
    fetchImpl: mockFetch,
    logger,
    nowMs: 1_000_000,
  });

  assert.equal(first.ok, true);
  assert.equal(first.configured, true);
  assert.equal(first.skipped, false);
  assert.equal(first.telegramResponse?.ok, true);
  assert.equal(first.verifiedMenuButton?.type, 'web_app');
  assert.equal(first.verifiedMenuButton?.text, 'Open AdeyBingo');
  assert.equal(first.verifiedMenuButton?.web_app?.url, 'https://adebingo-3nta.vercel.app/');

  // Confirm exact setChatMenuButton endpoint & payload
  const setCalls = calls.filter((c) => c.url.endsWith('/setChatMenuButton'));
  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0].body, {
    menu_button: {
      type: 'web_app',
      text: 'Open AdeyBingo',
      web_app: {
        url: 'https://adebingo-3nta.vercel.app/',
      },
    },
  });

  // Never log the bot token
  for (const line of logs) {
    assert.equal(line.includes(token), false, 'Bot token must never appear in logs');
  }

  // Second call within TTL makes ZERO additional network calls
  const callCountAfterFirst = calls.length;
  const second = await configurator.ensureConfiguredOnce({
    botToken: token,
    miniAppUrl: 'https://adebingo-3nta.vercel.app/',
    fetchImpl: mockFetch,
    logger,
    nowMs: 1_060_000,
  });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_configured_cached');
  assert.equal(calls.length, callCountAfterFirst);

  // Fresh instance (cold start / restart) checks getChatMenuButton and skips redundant setChatMenuButton
  const coldStartConfigurator = new TelegramMenuButtonConfigurator();
  const third = await coldStartConfigurator.ensureConfiguredOnce({
    botToken: token,
    miniAppUrl: 'https://adebingo-3nta.vercel.app/',
    fetchImpl: mockFetch,
    logger,
  });
  assert.equal(third.ok, true);
  assert.equal(third.configured, true);
  assert.equal(third.skipped, true);
  assert.equal(third.reason, 'already_configured_remote');
  assert.equal(calls.filter((c) => c.url.endsWith('/setChatMenuButton')).length, 1);
});

test('TelegramMenuButtonConfigurator handles missing token, Telegram rejection, and network errors without leaking token', async () => {
  const token = '987654321:AASecretLeakCheckTokenXYZ987';
  const logs: string[] = [];
  const logger = {
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => logs.push(args.join(' ')),
  };

  // 1. Missing token
  const c1 = new TelegramMenuButtonConfigurator();
  let fetchCalled = false;
  const missingRes = await c1.ensureConfiguredOnce({
    botToken: '',
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('should not fetch');
    },
    logger,
  });
  assert.equal(missingRes.ok, false);
  assert.equal(missingRes.skipped, true);
  assert.equal(missingRes.reason, 'missing_bot_token');
  assert.equal(fetchCalled, false);

  // 2. Telegram rejection
  const c2 = new TelegramMenuButtonConfigurator();
  const rejectedRes = await c2.configure({
    botToken: token,
    checkExistingFirst: false,
    fetchImpl: async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
      }) as unknown as Response,
    logger,
  });
  assert.equal(rejectedRes.ok, false);
  assert.equal(rejectedRes.reason, 'telegram_api_rejected');
  assert.equal(rejectedRes.telegramResponse?.error_code, 401);
  assert.equal(rejectedRes.telegramResponse?.description, 'Unauthorized');

  // 3. Network error redacts token from URL in error message
  const c3 = new TelegramMenuButtonConfigurator();
  const netRes = await c3.configure({
    botToken: token,
    checkExistingFirst: false,
    fetchImpl: async () => {
      throw new Error(`request to https://api.telegram.org/bot${token}/setChatMenuButton failed`);
    },
    logger,
  });
  assert.equal(netRes.ok, false);
  assert.equal(netRes.reason, 'network_error');
  assert.equal(netRes.telegramResponse?.description?.includes(token), false);
  assert.match(netRes.telegramResponse?.description || '', /bot<REDACTED>/);
  assert.equal(
    sanitizeTelegramApiError(new Error(`https://api.telegram.org/bot${token}/getMe`)).includes(
      token
    ),
    false
  );

  for (const line of logs) {
    assert.equal(line.includes(token), false, 'Bot token must never leak in error logs');
  }

  // 4. fetchCurrentChatMenuButton also rejects missing token cleanly
  const emptyCurrent = await fetchCurrentChatMenuButton({ botToken: '' });
  assert.equal(emptyCurrent.ok, false);
  assert.equal(emptyCurrent.menuButton, null);
});

test('POST /api/telegram/configure-menu-button, /register-webhook, and serverless autoConfigureMenuButton work securely', async () => {
  const token = '123456789:AAHandlerTestSecretToken777';
  const webhookSecret = 'adey_menu_webhook_secret_2026';
  let setMenuCalls = 0;
  let lastSetMenuPayload: unknown = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/getChatMenuButton')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: lastSetMenuPayload
            ? (lastSetMenuPayload as { menu_button: unknown }).menu_button
            : { type: 'default' },
        }),
      } as unknown as Response;
    }
    if (url.endsWith('/setChatMenuButton')) {
      setMenuCalls += 1;
      lastSetMenuPayload = body;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: 123, username: 'AdeyBingoGameBot' } }),
    } as unknown as Response;
  };

  // Unauthenticated request rejected -> 401
  const configurator = new TelegramMenuButtonConfigurator();
  const configureHandler = createConfigureMenuButtonHandler({
    getBotToken: () => token,
    getWebhookSecret: () => webhookSecret,
    fetchImpl: mockFetch,
    configurator,
    limiter: new BoundedRateLimiter(),
  });
  const unauth = await invokeHandler(configureHandler, { method: 'POST', body: {} });
  assert.equal(unauth.statusCode, 401);

  // Authenticated with webhook secret -> 200 and configures exact web_app button
  const authOk = await invokeHandler(configureHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {},
  });
  assert.equal(authOk.statusCode, 200);
  assert.equal(authOk.body.ok, true);
  assert.equal(authOk.body.configured, true);
  assert.equal(setMenuCalls, 1);
  assert.deepEqual(lastSetMenuPayload, {
    menu_button: {
      type: 'web_app',
      text: 'Open AdeyBingo',
      web_app: {
        url: 'https://adebingo-3nta.vercel.app/',
      },
    },
  });

  // register-webhook also uses Open AdeyBingo + canonical URL
  const regHandler = createRegisterWebhookHandler({
    getBotToken: () => token,
    getWebhookSecret: () => webhookSecret,
    fetchImpl: mockFetch,
    limiter: new BoundedRateLimiter(),
  });
  const regRes = await invokeHandler(regHandler, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
    body: {},
  });
  assert.equal(regRes.statusCode, 200);
  assert.equal(regRes.body.menuButtonConfigured, true);
  assert.deepEqual(regRes.body.menuButton, {
    type: 'web_app',
    text: 'Open AdeyBingo',
    web_app: {
      url: 'https://adebingo-3nta.vercel.app/',
    },
  });

  // Serverless router autoConfigureMenuButton runs once on cold-start auth/webhook route
  const routerConfigurator = new TelegramMenuButtonConfigurator();
  lastSetMenuPayload = null;
  setMenuCalls = 0;
  const router = createTelegramRouterHandler({
    autoConfigureMenuButton: true,
    getBotToken: () => token,
    getWebhookSecret: () => webhookSecret,
    fetchImpl: mockFetch,
    configurator: routerConfigurator,
    limiter: new BoundedRateLimiter(),
  });

  // Hit /api/telegram/auth (missing initData -> 400, but cold-start menu button initialization ran once!)
  const firstHit = await invokeHandler(router, {
    method: 'POST',
    url: '/api/telegram/auth',
    body: {},
  });
  assert.equal(firstHit.statusCode, 400);
  assert.equal(setMenuCalls, 1);

  // Second hit does NOT call setChatMenuButton again (cached)
  const secondHit = await invokeHandler(router, {
    method: 'POST',
    url: '/api/telegram/auth',
    body: {},
  });
  assert.equal(secondHit.statusCode, 400);
  assert.equal(setMenuCalls, 1);
});
