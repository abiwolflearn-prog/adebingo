import {
  DEFAULT_DEPLOYED_MINI_APP_URL,
  sanitizeProductionMiniAppUrl,
} from './telegramBot.ts';
import { hasValidTelegramBotTokenFormat } from './telegramVerify.ts';

export const ADEYBINGO_MENU_BUTTON_TEXT = 'Open AdeyBingo';
export const DEFAULT_MENU_BUTTON_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 8000;

export interface TelegramWebAppMenuButton {
  type: 'web_app';
  text: string;
  web_app: {
    url: string;
  };
}

export interface TelegramReturnedMenuButton {
  type?: string;
  text?: string;
  web_app?: {
    url?: string;
  };
}

export interface SetChatMenuButtonPayload {
  menu_button: TelegramWebAppMenuButton;
}

export interface TelegramChatMenuButtonApiResponse {
  ok: boolean;
  result?: boolean | TelegramReturnedMenuButton;
  error_code?: number;
  description?: string;
}

export interface MenuButtonLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface MenuButtonConfigurationResult {
  ok: boolean;
  configured: boolean;
  skipped: boolean;
  alreadyConfigured?: boolean;
  reason?:
    | 'missing_bot_token'
    | 'already_configured_cached'
    | 'already_configured_remote'
    | 'telegram_api_rejected'
    | 'network_error';
  httpStatus?: number;
  telegramResponse?: {
    ok: boolean;
    result?: boolean;
    error_code?: number;
    description?: string;
  };
  verifiedMenuButton?: TelegramReturnedMenuButton | null;
  menuButton: TelegramWebAppMenuButton;
  checkedAt: string;
}

export interface ConfigureMenuButtonOptions {
  botToken?: string;
  miniAppUrl?: string;
  buttonText?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
  checkExistingFirst?: boolean;
  verifyAfterSet?: boolean;
  timeoutMs?: number;
  nowMs?: number;
  logger?: MenuButtonLogger;
}

/**
 * Redacts any Telegram Bot API token fragment from error messages or URLs
 * so secrets are never written to logs or returned in responses.
 */
export function sanitizeTelegramApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown network error');
  return raw.replace(/bot\d+:[^\s/?#]+/gi, 'bot<REDACTED>');
}

/**
 * Builds the official Telegram Bot API `setChatMenuButton` payload for AdeyBingo
 * using the sanitized canonical production Mini App URL.
 */
export function buildAdeyBingoMenuButtonPayload(
  rawMiniAppUrl?: string | null,
  buttonText: string = ADEYBINGO_MENU_BUTTON_TEXT
): SetChatMenuButtonPayload {
  const resolvedUrl = sanitizeProductionMiniAppUrl(rawMiniAppUrl || DEFAULT_DEPLOYED_MINI_APP_URL);
  const cleanText =
    typeof buttonText === 'string' && buttonText.trim().length > 0
      ? buttonText.trim().slice(0, 64)
      : ADEYBINGO_MENU_BUTTON_TEXT;
  return {
    menu_button: {
      type: 'web_app',
      text: cleanText,
      web_app: {
        url: resolvedUrl,
      },
    },
  };
}

/**
 * Checks whether the menu button currently returned by Telegram's `getChatMenuButton`
 * already matches the desired AdeyBingo Web App menu button.
 */
export function isMatchingWebAppMenuButton(
  actual: TelegramReturnedMenuButton | null | undefined,
  expected: TelegramWebAppMenuButton
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  if (actual.type !== 'web_app') return false;
  if (actual.text !== expected.text) return false;
  const actualUrl = typeof actual.web_app?.url === 'string' ? actual.web_app.url.trim() : '';
  return actualUrl === expected.web_app.url;
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (typeof AbortController === 'undefined' || timeoutMs <= 0) {
    return await fetchFn(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the current default bot menu button from Telegram (`getChatMenuButton`).
 * Never exposes or logs the bot token.
 */
export async function fetchCurrentChatMenuButton(options: {
  botToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  menuButton: TelegramReturnedMenuButton | null;
  errorCode?: number;
  description?: string;
}> {
  const botToken = (options.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!hasValidTelegramBotTokenFormat(botToken)) {
    return {
      ok: false,
      menuButton: null,
      description: 'TELEGRAM_BOT_TOKEN is not configured.',
    };
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_API_TIMEOUT_MS;
  try {
    const resp = await fetchWithTimeout(
      fetchFn,
      `https://api.telegram.org/bot${botToken}/getChatMenuButton`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      timeoutMs
    );
    const data = (await resp.json().catch(() => ({}))) as TelegramChatMenuButtonApiResponse;
    if (resp.ok && data.ok && data.result && typeof data.result === 'object') {
      return {
        ok: true,
        menuButton: data.result as TelegramReturnedMenuButton,
      };
    }
    return {
      ok: false,
      menuButton: null,
      errorCode: typeof data.error_code === 'number' ? data.error_code : resp.status,
      description:
        typeof data.description === 'string'
          ? data.description
          : `HTTP ${resp.status} from getChatMenuButton`,
    };
  } catch (err) {
    return {
      ok: false,
      menuButton: null,
      description: sanitizeTelegramApiError(err),
    };
  }
}

/**
 * Deployment-safe, idempotent configurator for AdeyBingo's default Telegram Menu Button.
 * - Deduplicates concurrent calls via an in-flight promise lock.
 * - Caches successful configuration for `ttlMs` (default 6h) to avoid repeated API calls.
 * - Optionally queries `getChatMenuButton` first so restarts/cold-starts skip `setChatMenuButton`
 *   when Telegram already has the exact `web_app` configuration.
 * - Logs acceptance/rejection clearly without ever exposing the bot token.
 */
export class TelegramMenuButtonConfigurator {
  private readonly ttlMs: number;
  private lastConfiguredKey: string | null = null;
  private lastConfiguredAtMs = 0;
  private lastResult: MenuButtonConfigurationResult | null = null;
  private inFlight: { key: string; promise: Promise<MenuButtonConfigurationResult> } | null = null;

  constructor(ttlMs: number = DEFAULT_MENU_BUTTON_TTL_MS) {
    this.ttlMs = Math.max(1000, ttlMs);
  }

  public getLastResult(): MenuButtonConfigurationResult | null {
    return this.lastResult;
  }

  public reset(): void {
    this.lastConfiguredKey = null;
    this.lastConfiguredAtMs = 0;
    this.lastResult = null;
    this.inFlight = null;
  }

  public async ensureConfiguredOnce(
    options: Omit<ConfigureMenuButtonOptions, 'force'> = {}
  ): Promise<MenuButtonConfigurationResult> {
    try {
      return await this.configure({
        ...options,
        force: false,
        checkExistingFirst: options.checkExistingFirst ?? true,
        verifyAfterSet: options.verifyAfterSet ?? true,
      });
    } catch (err) {
      const payload = buildAdeyBingoMenuButtonPayload(options.miniAppUrl, options.buttonText);
      const safeError = sanitizeTelegramApiError(err);
      const logger = options.logger ?? console;
      logger.error(`[telegram/menu-button] Unexpected configuration error: ${safeError}`);
      const fallback: MenuButtonConfigurationResult = {
        ok: false,
        configured: false,
        skipped: false,
        reason: 'network_error',
        telegramResponse: { ok: false, description: safeError },
        menuButton: payload.menu_button,
        checkedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
      };
      this.lastResult = fallback;
      return fallback;
    }
  }

  public async configure(
    options: ConfigureMenuButtonOptions = {}
  ): Promise<MenuButtonConfigurationResult> {
    const nowMs = options.nowMs ?? Date.now();
    const checkedAt = new Date(nowMs).toISOString();
    const logger = options.logger ?? console;
    const rawUrl =
      options.miniAppUrl ?? process.env.PUBLIC_MINI_APP_URL ?? process.env.APP_URL ?? undefined;
    const payload = buildAdeyBingoMenuButtonPayload(rawUrl, options.buttonText);
    const desired = payload.menu_button;
    const cacheKey = `${desired.type}|${desired.text}|${desired.web_app.url}`;

    const rawToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    const botToken = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!hasValidTelegramBotTokenFormat(botToken)) {
      logger.warn(
        '[telegram/menu-button] Skipping automatic setChatMenuButton: TELEGRAM_BOT_TOKEN is missing or invalid.'
      );
      const missingRes: MenuButtonConfigurationResult = {
        ok: false,
        configured: false,
        skipped: true,
        reason: 'missing_bot_token',
        menuButton: desired,
        checkedAt,
      };
      this.lastResult = missingRes;
      return missingRes;
    }

    const force = Boolean(options.force);
    if (
      !force &&
      this.lastConfiguredKey === cacheKey &&
      this.lastResult?.configured &&
      nowMs - this.lastConfiguredAtMs < this.ttlMs
    ) {
      return {
        ...this.lastResult,
        skipped: true,
        alreadyConfigured: true,
        reason: 'already_configured_cached',
        checkedAt,
      };
    }

    if (!force && this.inFlight && this.inFlight.key === cacheKey) {
      return await this.inFlight.promise;
    }

    const runPromise = this.executeConfigure({
      botToken,
      payload,
      cacheKey,
      fetchFn: options.fetchImpl ?? fetch,
      checkExistingFirst: options.checkExistingFirst ?? !force,
      verifyAfterSet: options.verifyAfterSet ?? true,
      timeoutMs: options.timeoutMs ?? DEFAULT_TELEGRAM_API_TIMEOUT_MS,
      nowMs,
      checkedAt,
      logger,
    });

    if (!force) {
      this.inFlight = { key: cacheKey, promise: runPromise };
    }

    try {
      return await runPromise;
    } finally {
      if (this.inFlight?.promise === runPromise) {
        this.inFlight = null;
      }
    }
  }

  private async executeConfigure(params: {
    botToken: string;
    payload: SetChatMenuButtonPayload;
    cacheKey: string;
    fetchFn: typeof fetch;
    checkExistingFirst: boolean;
    verifyAfterSet: boolean;
    timeoutMs: number;
    nowMs: number;
    checkedAt: string;
    logger: MenuButtonLogger;
  }): Promise<MenuButtonConfigurationResult> {
    const {
      botToken,
      payload,
      cacheKey,
      fetchFn,
      checkExistingFirst,
      verifyAfterSet,
      timeoutMs,
      nowMs,
      checkedAt,
      logger,
    } = params;
    const desired = payload.menu_button;

    // Step 1: Avoid redundant setChatMenuButton writes when Telegram already has the exact config
    if (checkExistingFirst) {
      const existing = await fetchCurrentChatMenuButton({
        botToken,
        fetchImpl: fetchFn,
        timeoutMs,
      });
      if (existing.ok && isMatchingWebAppMenuButton(existing.menuButton, desired)) {
        logger.info(
          `[telegram/menu-button] Default Menu Button already configured on Telegram (type=${desired.type}, text="${desired.text}", url="${desired.web_app.url}"). Skipping setChatMenuButton.`
        );
        const alreadyRes: MenuButtonConfigurationResult = {
          ok: true,
          configured: true,
          skipped: true,
          alreadyConfigured: true,
          reason: 'already_configured_remote',
          telegramResponse: { ok: true, result: true },
          verifiedMenuButton: existing.menuButton,
          menuButton: desired,
          checkedAt,
        };
        this.lastConfiguredKey = cacheKey;
        this.lastConfiguredAtMs = nowMs;
        this.lastResult = alreadyRes;
        return alreadyRes;
      }
    }

    // Step 2: Call official Telegram Bot API setChatMenuButton
    try {
      const resp = await fetchWithTimeout(
        fetchFn,
        `https://api.telegram.org/bot${botToken}/setChatMenuButton`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );

      const data = (await resp.json().catch(() => ({}))) as TelegramChatMenuButtonApiResponse;
      if (!resp.ok || data.ok !== true) {
        const errorCode = typeof data.error_code === 'number' ? data.error_code : resp.status;
        const description =
          typeof data.description === 'string'
            ? data.description
            : `Telegram API returned HTTP ${resp.status}`;
        logger.error(
          `[telegram/menu-button] Telegram rejected setChatMenuButton (httpStatus=${resp.status}, errorCode=${errorCode}, description="${description}").`
        );
        const rejectedRes: MenuButtonConfigurationResult = {
          ok: false,
          configured: false,
          skipped: false,
          reason: 'telegram_api_rejected',
          httpStatus: resp.status,
          telegramResponse: {
            ok: false,
            error_code: errorCode,
            description,
          },
          menuButton: desired,
          checkedAt,
        };
        this.lastResult = rejectedRes;
        return rejectedRes;
      }

      let verifiedMenuButton: TelegramReturnedMenuButton | null = null;
      if (verifyAfterSet) {
        const verification = await fetchCurrentChatMenuButton({
          botToken,
          fetchImpl: fetchFn,
          timeoutMs,
        });
        if (verification.ok) {
          verifiedMenuButton = verification.menuButton;
        }
      }

      logger.info(
        `[telegram/menu-button] Telegram accepted setChatMenuButton (ok=true, type=${desired.type}, text="${desired.text}", url="${desired.web_app.url}").`
      );

      const okRes: MenuButtonConfigurationResult = {
        ok: true,
        configured: true,
        skipped: false,
        httpStatus: resp.status,
        telegramResponse: {
          ok: true,
          result: typeof data.result === 'boolean' ? data.result : true,
          ...(typeof data.description === 'string' ? { description: data.description } : {}),
        },
        verifiedMenuButton,
        menuButton: desired,
        checkedAt,
      };
      this.lastConfiguredKey = cacheKey;
      this.lastConfiguredAtMs = nowMs;
      this.lastResult = okRes;
      return okRes;
    } catch (err) {
      const safeError = sanitizeTelegramApiError(err);
      logger.error(
        `[telegram/menu-button] Network error while calling setChatMenuButton: ${safeError}`
      );
      const netRes: MenuButtonConfigurationResult = {
        ok: false,
        configured: false,
        skipped: false,
        reason: 'network_error',
        telegramResponse: {
          ok: false,
          description: safeError,
        },
        menuButton: desired,
        checkedAt,
      };
      this.lastResult = netRes;
      return netRes;
    }
  }
}

export const defaultMenuButtonConfigurator = new TelegramMenuButtonConfigurator();
