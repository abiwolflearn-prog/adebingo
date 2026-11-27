// Safe Telegram Mini App environment detector and haptic helper.
// Never exposes bot tokens or private keys; falls back cleanly in standard browsers.

export interface TelegramUserProfile {
  id: number;
  firstName: string;
  lastName?: string;
  username: string;
  languageCode: string;
  isTelegramWebApp: boolean;
  initials: string;
  startParam?: string;
}

interface TelegramBackButton {
  isVisible?: boolean;
  show?: () => void;
  hide?: () => void;
  onClick?: (cb: () => void) => void;
  offClick?: (cb: () => void) => void;
}

interface TelegramWebAppWindow {
  TelegramWebviewProxy?: unknown;
  Telegram?: {
    WebApp?: {
      version?: string;
      platform?: string;
      isVersionAtLeast?: (version: string) => boolean;
      initData?: string;
      initDataUnsafe?: {
        start_param?: string;
        user?: {
          id: number;
          first_name: string;
          last_name?: string;
          username?: string;
          language_code?: string;
        };
      };
      ready?: () => void;
      expand?: () => void;
      setHeaderColor?: (color: string) => void;
      setBackgroundColor?: (color: string) => void;
      setBottomBarColor?: (color: string) => void;
      BackButton?: TelegramBackButton;
      requestContact?: (callback?: (sent: boolean) => void) => void;
      openTelegramLink?: (url: string) => void;
      HapticFeedback?: {
        impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
        notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
      };
    };
  };
}

export type TelegramInitDataSource = 'webapp' | 'hash_fragment' | 'telegram_session_cache' | 'none';

export interface TelegramLaunchContext {
  launchedInTelegram: boolean;
  isTelegramWebApp: boolean;
  initData: string;
  initDataSource: TelegramInitDataSource;
  platform: string;
}

/**
 * Extracts the untouched signed Telegram `initData` query string from a Telegram WebApp
 * URL fragment (`#tgWebAppData=...`). Never constructs or alters `initData`.
 */
export function extractInitDataFromUrlHash(rawHash: string): string {
  if (!rawHash || typeof rawHash !== 'string') return '';
  const cleaned = rawHash.replace(/^#/, '').trim();
  if (!cleaned || !cleaned.includes('tgWebAppData=')) return '';
  try {
    const params = new URLSearchParams(cleaned);
    const extracted = params.get('tgWebAppData');
    return typeof extracted === 'string' ? extracted.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Extracts cached `tgWebAppData` stored by Telegram's official `telegram-web-app.js` SDK
 * inside `sessionStorage['__telegram__initParams']` across WebView reloads.
 */
function extractInitDataFromTelegramSdkCache(): { initData: string; hasTelegramParams: boolean } {
  if (typeof window === 'undefined') return { initData: '', hasTelegramParams: false };
  try {
    const raw = window.sessionStorage?.getItem('__telegram__initParams');
    if (!raw) return { initData: '', hasTelegramParams: false };
    const parsed = JSON.parse(raw) as { tgWebAppData?: unknown; tgWebAppPlatform?: unknown };
    const data = typeof parsed?.tgWebAppData === 'string' ? parsed.tgWebAppData.trim() : '';
    const hasPlatform =
      typeof parsed?.tgWebAppPlatform === 'string' &&
      parsed.tgWebAppPlatform.trim().length > 0 &&
      parsed.tgWebAppPlatform !== 'unknown';
    return { initData: data, hasTelegramParams: Boolean(data || hasPlatform) };
  } catch {
    return { initData: '', hasTelegramParams: false };
  }
}

/**
 * Inspects whether the Mini App was launched inside Telegram and returns any authentic
 * untouched `initData` available from `Telegram.WebApp.initData`, `#tgWebAppData`, or
 * Telegram's own SDK session cache. Never synthesizes `initData` from `initDataUnsafe`.
 */
export function inspectTelegramLaunchContext(): TelegramLaunchContext {
  if (typeof window === 'undefined') {
    return {
      launchedInTelegram: false,
      isTelegramWebApp: false,
      initData: '',
      initDataSource: 'none',
      platform: 'unknown',
    };
  }

  const tgWin = window as unknown as TelegramWebAppWindow;
  const tg = tgWin.Telegram?.WebApp;
  if (tg) {
    try {
      tg.ready?.();
      tg.expand?.();
      applyTelegramBrandTheme(tg);
    } catch {
      // Ignore outside Telegram environment
    }
  }

  const platform =
    typeof tg?.platform === 'string' && tg.platform.trim() ? tg.platform.trim() : 'unknown';
  const webAppInitData = typeof tg?.initData === 'string' ? tg.initData.trim() : '';
  if (webAppInitData.length > 0) {
    return {
      launchedInTelegram: true,
      isTelegramWebApp: true,
      initData: webAppInitData,
      initDataSource: 'webapp',
      platform,
    };
  }

  const hashInitData = extractInitDataFromUrlHash(window.location.hash || '');
  if (hashInitData.length > 0) {
    return {
      launchedInTelegram: true,
      isTelegramWebApp: true,
      initData: hashInitData,
      initDataSource: 'hash_fragment',
      platform,
    };
  }

  const sdkCache = extractInitDataFromTelegramSdkCache();
  if (sdkCache.initData.length > 0) {
    return {
      launchedInTelegram: true,
      isTelegramWebApp: true,
      initData: sdkCache.initData,
      initDataSource: 'telegram_session_cache',
      platform,
    };
  }

  const rawHash = window.location.hash || '';
  const hasTelegramHashHint =
    rawHash.includes('tgWebAppPlatform=') ||
    rawHash.includes('tgWebAppVersion=') ||
    rawHash.includes('tgWebAppData=');
  const hasNativeBridge = Boolean(tgWin.TelegramWebviewProxy);
  const hasKnownTelegramPlatform = platform !== 'unknown';
  const launchedInTelegram =
    hasKnownTelegramPlatform || hasTelegramHashHint || hasNativeBridge || sdkCache.hasTelegramParams;

  return {
    launchedInTelegram,
    isTelegramWebApp: false,
    initData: '',
    initDataSource: 'none',
    platform,
  };
}

function supportsVersion(
  tg: NonNullable<TelegramWebAppWindow['Telegram']>['WebApp'],
  minVersion: string
): boolean {
  if (!tg || typeof tg.isVersionAtLeast !== 'function') return false;
  try {
    return Boolean(tg.isVersionAtLeast(minVersion));
  } catch {
    return false;
  }
}

function applyTelegramBrandTheme(tg: NonNullable<TelegramWebAppWindow['Telegram']>['WebApp']) {
  if (!tg) return;
  try {
    if (supportsVersion(tg, '6.1')) {
      tg.setHeaderColor?.('#159447');
      tg.setBackgroundColor?.('#FFF9ED');
    }
    if (supportsVersion(tg, '7.10')) {
      tg.setBottomBarColor?.('#FFFFFF');
    }
  } catch {
    // Ignore on older Telegram WebApp versions
  }
}

export function getTelegramStartParam(): string {
  if (typeof window === 'undefined') return '';
  try {
    const tgWebApp = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
    const tgStart = tgWebApp?.initDataUnsafe?.start_param || '';
    if (tgStart.trim()) return tgStart.trim();
    const rawWebAppInitData = typeof tgWebApp?.initData === 'string' ? tgWebApp.initData.trim() : '';
    if (rawWebAppInitData) {
      const fromInitData = new URLSearchParams(rawWebAppInitData).get('start_param')?.trim() || '';
      if (fromInitData) return fromInitData;
    }
    const params = new URLSearchParams(window.location.search);
    const fromQuery =
      params.get('start')?.trim() ||
      params.get('startapp')?.trim() ||
      params.get('ref')?.trim() ||
      params.get('tgWebAppStartParam')?.trim() ||
      '';
    if (fromQuery) return fromQuery;
    const rawHash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
    if (rawHash) {
      const hashParams = new URLSearchParams(rawHash);
      const direct =
        hashParams.get('tgWebAppStartParam')?.trim() ||
        hashParams.get('startapp')?.trim() ||
        hashParams.get('start')?.trim() ||
        hashParams.get('ref')?.trim() ||
        '';
      if (direct) return direct;
      const hashInitData = hashParams.get('tgWebAppData');
      if (hashInitData) {
        const inner = new URLSearchParams(hashInitData).get('start_param')?.trim() || '';
        if (inner) return inner;
      }
    }
    const sdkCache = extractInitDataFromTelegramSdkCache();
    if (sdkCache.initData) {
      const fromCache = new URLSearchParams(sdkCache.initData).get('start_param')?.trim() || '';
      if (fromCache) return fromCache;
    }
    return '';
  } catch {
    return '';
  }
}

export function getLiveTelegramWebAppUserId(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp?.initDataUnsafe?.user?.id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
    const ctx = inspectTelegramLaunchContext();
    if (ctx.initData) {
      const userJson = new URLSearchParams(ctx.initData).get('user');
      if (userJson) {
        const parsed = JSON.parse(userJson) as { id?: unknown };
        if (typeof parsed.id === 'number' && Number.isInteger(parsed.id) && parsed.id > 0) {
          return parsed.id;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Triggers Telegram WebApp's native verified contact sharing dialog (Bot API 6.9+).
 * When the user accepts, Telegram delivers a verified `contact` update directly to
 * the bot webhook so the backend can verify and persist the phone number securely.
 */
export function requestTelegramContact(): Promise<{ supported: boolean; sent: boolean }> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ supported: false, sent: false });
  }
  const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
  if (!tg || typeof tg.requestContact !== 'function' || !supportsVersion(tg, '6.9')) {
    return Promise.resolve({ supported: false, sent: false });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sent: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ supported: true, sent });
    };
    const fallbackTimer = window.setTimeout(() => finish(false), 15000);
    try {
      tg.requestContact?.((sent: boolean) => {
        window.clearTimeout(fallbackTimer);
        finish(Boolean(sent));
      });
    } catch {
      window.clearTimeout(fallbackTimer);
      resolve({ supported: false, sent: false });
    }
  });
}

export function syncTelegramBackButton(visible: boolean, onBack: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
  if (!tg || !supportsVersion(tg, '6.1')) return () => {};
  const backButton = tg.BackButton;
  if (!backButton) return () => {};
  try {
    if (visible) {
      backButton.onClick?.(onBack);
      backButton.show?.();
    } else {
      backButton.hide?.();
    }
  } catch {
    // Ignore outside Telegram environment
  }
  return () => {
    try {
      backButton.offClick?.(onBack);
    } catch {
      // Ignore cleanup error
    }
  };
}

function enforceUnifiedThemeAndClearStaleCaches() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    document.documentElement.style.colorScheme = 'light';
    document.documentElement.setAttribute('data-theme', 'adeybingo-emerald-gold');
  } catch {
    // Ignore DOM attribute errors
  }
  try {
    const staleThemeKeys = ['theme', 'adey_theme', 'color-scheme', 'darkMode', 'adeybingo_theme'];
    for (const key of staleThemeKeys) {
      window.localStorage?.removeItem(key);
      window.sessionStorage?.removeItem(key);
    }
  } catch {
    // Ignore storage access errors in restricted WebViews
  }
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker?.getRegistrations) {
      const currentOrigin = window.location.origin;
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const reg of registrations) {
            const scope = reg.scope || '';
            const scriptUrl =
              reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || '';
            const isSameOrigin = scope.startsWith(currentOrigin);
            const isFirebaseOrAuthWorker = /firebase|__\/auth/i.test(scriptUrl);
            if (isSameOrigin && !isFirebaseOrAuthWorker) {
              void reg.unregister();
            }
          }
        })
        .catch(() => {});
    }
  } catch {
    // Ignore service worker cleanup errors
  }
}

export function initTelegramMiniApp(): TelegramUserProfile {
  enforceUnifiedThemeAndClearStaleCaches();
  const startParam = getTelegramStartParam();
  if (typeof window !== 'undefined') {
    const ctx = inspectTelegramLaunchContext();
    const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
    let u = ctx.initData.length > 0 ? tg?.initDataUnsafe?.user : undefined;
    if (!u && ctx.initData.length > 0) {
      try {
        const userJson = new URLSearchParams(ctx.initData).get('user');
        if (userJson) {
          u = JSON.parse(userJson) as NonNullable<
            NonNullable<TelegramWebAppWindow['Telegram']>['WebApp']
          >['initDataUnsafe'] extends { user?: infer U }
            ? U
            : never;
        }
      } catch {
        u = undefined;
      }
    }
    if (ctx.initData.length > 0 && u && Number.isInteger(u.id) && u.id > 0 && u.first_name) {
      const first = u.first_name;
      const last = u.last_name || '';
      const initials = `${first[0] || 'A'}${last[0] || 'B'}`.toUpperCase();
      return {
        // Display preview only; authentication and UID binding occur strictly via server-verified /api/telegram/auth
        id: u.id,
        firstName: first,
        lastName: last,
        username: u.username ? `@${u.username}` : '',
        languageCode: u.language_code || 'am',
        isTelegramWebApp: true,
        initials,
        startParam: startParam || undefined,
      };
    }
  }

  return {
    id: 0,
    firstName: 'ADEYBINGO',
    lastName: 'Player',
    username: '',
    languageCode: 'am',
    isTelegramWebApp: false,
    initials: 'AB',
    startParam: startParam || undefined,
  };
}

/**
 * Waits briefly for Telegram WebApp SDK initialization (`window.Telegram.WebApp.ready()`),
 * then returns the untouched original `initData` query string along with safe launch diagnostics.
 * Never constructs, modifies, or falls back to `initDataUnsafe` for authentication.
 */
export async function waitForTelegramWebAppInitData(
  timeoutMs = 1500
): Promise<TelegramLaunchContext> {
  if (typeof window === 'undefined') {
    return {
      launchedInTelegram: false,
      isTelegramWebApp: false,
      initData: '',
      initDataSource: 'none',
      platform: 'unknown',
    };
  }

  const initial = inspectTelegramLaunchContext();
  if (initial.initData.length > 0) {
    return initial;
  }

  // In a standard non-Telegram browser (e.g. Chrome) once the page has finished loading
  // and no Telegram bridge/hash/platform is detected, return immediately without stalling.
  const hasTelegramScript = Boolean((window as unknown as TelegramWebAppWindow).Telegram?.WebApp);
  if (
    !initial.launchedInTelegram &&
    hasTelegramScript &&
    typeof document !== 'undefined' &&
    document.readyState === 'complete'
  ) {
    return initial;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    const next = inspectTelegramLaunchContext();
    if (next.initData.length > 0) {
      return next;
    }
    if (
      !next.launchedInTelegram &&
      Boolean((window as unknown as TelegramWebAppWindow).Telegram?.WebApp) &&
      typeof document !== 'undefined' &&
      document.readyState === 'complete'
    ) {
      return next;
    }
  }

  return inspectTelegramLaunchContext();
}

export function triggerHaptic(type: 'light' | 'medium' | 'success' | 'error' = 'light') {
  if (typeof window === 'undefined') return;
  const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
  if (!tg || !supportsVersion(tg, '6.1')) return;
  const haptics = tg.HapticFeedback;
  try {
    if (type === 'success' || type === 'error') {
      haptics?.notificationOccurred?.(type);
    } else {
      haptics?.impactOccurred?.(type);
    }
  } catch {
    // Ignore outside Telegram
  }
}

export const OFFICIAL_TELEGRAM_BOT_USERNAME = 'AdeyBingoGameBot';

export function buildTelegramReferralCode(telegramUserId: number): string {
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new RangeError('telegramUserId must be a positive integer.');
  }
  return `ADEY-${telegramUserId}`;
}

export function buildTelegramInviteLink(referralCodeOrTelegramId: string | number): string {
  const code =
    typeof referralCodeOrTelegramId === 'number'
      ? buildTelegramReferralCode(referralCodeOrTelegramId)
      : referralCodeOrTelegramId.trim().toUpperCase();
  return `https://t.me/${OFFICIAL_TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(code)}`;
}

export function buildTelegramShareUrl(inviteLink: string, message: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(message)}`;
}

export function openTelegramShareLink(shareUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
  if (tg && typeof tg.openTelegramLink === 'function') {
    try {
      tg.openTelegramLink(shareUrl);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Extracts and normalizes a `/start` deep-link payload from Telegram messages such as:
 * - `/start ADEY-5152447113`
 * - `/start@AdeyBingoGameBot ADEY-5152447113`
 * - `/start adey-5152447113`
 */
export function extractStartCommandReferralCode(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{3,48}))?/i.exec(trimmed);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return raw.toUpperCase().startsWith('ADEY-') ? raw.toUpperCase() : raw;
}

