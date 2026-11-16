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
  Telegram?: {
    WebApp?: {
      version?: string;
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
      HapticFeedback?: {
        impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
        notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
      };
    };
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
    const tgStart =
      (window as unknown as TelegramWebAppWindow).Telegram?.WebApp?.initDataUnsafe?.start_param || '';
    if (tgStart.trim()) return tgStart.trim();
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('start')?.trim() ||
      params.get('ref')?.trim() ||
      params.get('tgWebAppStartParam')?.trim() ||
      ''
    );
  } catch {
    return '';
  }
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
    const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
    if (tg) {
      try {
        tg.ready?.();
        tg.expand?.();
        applyTelegramBrandTheme(tg);
      } catch {
        // Ignore outside Telegram environment
      }
      const u = tg.initDataUnsafe?.user;
      if (u && u.first_name) {
        const first = u.first_name;
        const last = u.last_name || '';
        const initials = `${first[0] || 'A'}${last[0] || 'B'}`.toUpperCase();
        return {
          id: u.id,
          firstName: first,
          lastName: last,
          username: u.username ? `@${u.username}` : '@adey_player',
          languageCode: u.language_code || 'am',
          isTelegramWebApp: true,
          initials,
          startParam: startParam || undefined,
        };
      }
    }

    try {
      const params = new URLSearchParams(window.location.search);
      const customId = Number(params.get('tgId'));
      if (Number.isInteger(customId) && customId > 0) {
        const first = params.get('firstName')?.trim() || 'Meron';
        const last = params.get('lastName')?.trim() || 'Tadesse';
        const rawUser = params.get('username')?.trim() || 'meron_et';
        const initials = `${first[0] || 'M'}${last[0] || 'T'}`.toUpperCase();
        return {
          id: customId,
          firstName: first,
          lastName: last,
          username: rawUser.startsWith('@') ? rawUser : `@${rawUser}`,
          languageCode: 'am',
          isTelegramWebApp: false,
          initials,
          startParam: startParam || undefined,
        };
      }
    } catch {
      // Fall back to default demo profile below
    }
  }

  return {
    id: 8842109,
    firstName: 'Abebe',
    lastName: 'Bikila',
    username: '@abebe_adey',
    languageCode: 'am',
    isTelegramWebApp: false,
    initials: 'AB',
    startParam: startParam || undefined,
  };
}

/**
 * Waits briefly for Telegram WebApp SDK initialization (`window.Telegram.WebApp.ready()`),
 * then returns the untouched original `window.Telegram.WebApp.initData` query string.
 * Never constructs, modifies, or falls back to `initDataUnsafe` for authentication.
 */
export async function waitForTelegramWebAppInitData(timeoutMs = 1500): Promise<{
  isTelegramWebApp: boolean;
  initData: string;
}> {
  if (typeof window === 'undefined') {
    return { isTelegramWebApp: false, initData: '' };
  }

  const readState = () => {
    const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
    if (tg) {
      try {
        tg.ready?.();
        tg.expand?.();
        applyTelegramBrandTheme(tg);
      } catch {
        // Ignore outside Telegram environment
      }
    }
    const rawInitData = typeof tg?.initData === 'string' ? tg.initData : '';
    return { tg, rawInitData };
  };

  const initial = readState();
  if (initial.rawInitData.length > 0) {
    return { isTelegramWebApp: true, initData: initial.rawInitData };
  }

  // If the Telegram WebApp script already initialized with empty initData in a regular browser,
  // return immediately unless the document is still loading.
  if (initial.tg && typeof document !== 'undefined' && document.readyState === 'complete') {
    return { isTelegramWebApp: false, initData: '' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    const next = readState();
    if (next.rawInitData.length > 0) {
      return { isTelegramWebApp: true, initData: next.rawInitData };
    }
    if (next.tg && typeof document !== 'undefined' && document.readyState === 'complete') {
      break;
    }
  }

  const final = readState();
  return {
    isTelegramWebApp: final.rawInitData.length > 0,
    initData: final.rawInitData,
  };
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
