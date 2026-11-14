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
}

interface TelegramWebAppWindow {
  Telegram?: {
    WebApp?: {
      initData?: string;
      initDataUnsafe?: {
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
      HapticFeedback?: {
        impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
        notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
      };
    };
  };
}

export function initTelegramMiniApp(): TelegramUserProfile {
  if (typeof window !== 'undefined') {
    const tg = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp;
    if (tg) {
      try {
        tg.ready?.();
        tg.expand?.();
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
        };
      }
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
  const haptics = (window as unknown as TelegramWebAppWindow).Telegram?.WebApp?.HapticFeedback;
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
