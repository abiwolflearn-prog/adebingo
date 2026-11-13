import crypto from 'node:crypto';

export interface TelegramValidationResult {
  valid: boolean;
  reason?:
    | 'missing_init_data'
    | 'missing_bot_token'
    | 'missing_hash'
    | 'expired_auth_date'
    | 'future_auth_date'
    | 'signature_mismatch'
    | 'missing_telegram_user'
    | 'replay_detected'
    | 'telegram_id_mismatch';
  telegramUser?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  queryId?: string;
  authDate?: number;
  dataCheckHash?: string;
}

export interface TelegramContactVerificationResult {
  valid: boolean;
  reason?:
    | 'missing_sender_id'
    | 'plain_text_phone_rejected'
    | 'missing_contact_object'
    | 'missing_contact_user_id'
    | 'contact_owner_mismatch'
    | 'invalid_phone_format';
  verifiedPhoneNumber?: string;
  telegramUserId?: number;
}

/**
 * Bounded TTL Replay & Duplicate Request Guard.
 * Prevents replay of Telegram initData hashes, query_ids, webhook update_ids, or action nonces.
 */
export class TelegramReplayGuard {
  private seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly defaultTtlSeconds: number;

  constructor(maxEntries = 5000, defaultTtlSeconds = 3600) {
    this.maxEntries = maxEntries;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  /**
   * Returns true if the key is fresh and records it; returns false if already consumed within TTL.
   */
  public consumeOnce(
    replayKey: string,
    nowUnixSeconds: number = Math.floor(Date.now() / 1000),
    ttlSeconds: number = this.defaultTtlSeconds
  ): boolean {
    if (!replayKey || replayKey.trim() === '') return false;
    this.pruneExpired(nowUnixSeconds);

    const expiresAt = this.seen.get(replayKey);
    if (expiresAt !== undefined && expiresAt >= nowUnixSeconds) {
      return false;
    }

    if (this.seen.size >= this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey) {
        this.seen.delete(oldestKey);
      }
    }

    this.seen.set(replayKey, nowUnixSeconds + ttlSeconds);
    return true;
  }

  public clear(): void {
    this.seen.clear();
  }

  private pruneExpired(nowUnixSeconds: number): void {
    for (const [k, exp] of this.seen.entries()) {
      if (exp < nowUnixSeconds) {
        this.seen.delete(k);
      }
    }
  }
}

export const defaultReplayGuard = new TelegramReplayGuard();

export interface ValidateTelegramOptions {
  maxAgeSeconds?: number;
  nowUnixSeconds?: number;
  maxFutureSkewSeconds?: number;
  expectedTelegramUserId?: number;
  replayGuard?: TelegramReplayGuard;
  actionNonce?: string;
}

/**
 * Validates Telegram Mini App initData using the official HMAC-SHA256 algorithm:
 * 1. Parse URLSearchParams from raw initData query string.
 * 2. Extract `hash` and sort all remaining key=value pairs alphabetically by key, joined with `\n`.
 * 3. Verify `auth_date` is neither expired nor forged in the future (>60s skew).
 * 4. Compute secretKey = HMAC_SHA256(key="WebAppData", data=botToken).
 * 5. Compute expectedHash = HMAC_SHA256(key=secretKey, data=dataCheckString).hex().
 * 6. Compare expectedHash with `hash` using timingSafeEqual.
 * 7. Require a valid `user` JSON payload with a positive integer `id`.
 * 8. Enforce optional expectedTelegramUserId ownership binding and replay protection.
 */
export function validateTelegramWebAppInitData(
  rawInitData: string,
  botToken: string,
  maxAgeSecondsOrOptions: number | ValidateTelegramOptions = 3600,
  nowUnixSecondsArg?: number
): TelegramValidationResult {
  const opts: ValidateTelegramOptions =
    typeof maxAgeSecondsOrOptions === 'number'
      ? {
          maxAgeSeconds: maxAgeSecondsOrOptions,
          nowUnixSeconds: nowUnixSecondsArg,
        }
      : maxAgeSecondsOrOptions;

  const maxAgeSeconds = opts.maxAgeSeconds ?? 3600;
  const nowUnixSeconds = opts.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const maxFutureSkewSeconds = opts.maxFutureSkewSeconds ?? 60;

  if (!rawInitData || typeof rawInitData !== 'string' || rawInitData.trim() === '') {
    return { valid: false, reason: 'missing_init_data' };
  }
  if (!botToken || typeof botToken !== 'string' || botToken.trim() === '') {
    return { valid: false, reason: 'missing_bot_token' };
  }

  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    return { valid: false, reason: 'missing_hash' };
  }

  const authDateRaw = Number(params.get('auth_date') || '0');
  if (!Number.isInteger(authDateRaw) || authDateRaw <= 0) {
    return { valid: false, reason: 'expired_auth_date' };
  }
  if (authDateRaw > nowUnixSeconds + maxFutureSkewSeconds) {
    return { valid: false, reason: 'future_auth_date' };
  }
  if (maxAgeSeconds > 0 && nowUnixSeconds - authDateRaw > maxAgeSeconds) {
    return { valid: false, reason: 'expired_auth_date' };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const aBuf = Buffer.from(computedHash, 'hex');
  const bBuf = Buffer.from(receivedHash.toLowerCase(), 'hex');
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  let parsedUser: TelegramValidationResult['telegramUser'];
  const userJson = params.get('user');
  if (userJson) {
    try {
      parsedUser = JSON.parse(userJson);
    } catch {
      return { valid: false, reason: 'missing_telegram_user' };
    }
  }

  if (
    !parsedUser ||
    typeof parsedUser.id !== 'number' ||
    !Number.isInteger(parsedUser.id) ||
    parsedUser.id <= 0
  ) {
    return { valid: false, reason: 'missing_telegram_user' };
  }

  if (
    opts.expectedTelegramUserId !== undefined &&
    parsedUser.id !== opts.expectedTelegramUserId
  ) {
    return { valid: false, reason: 'telegram_id_mismatch' };
  }

  const queryId = params.get('query_id') || undefined;
  if (opts.replayGuard) {
    const replayKey = opts.actionNonce
      ? `init:${computedHash}:nonce:${opts.actionNonce}`
      : `init:${computedHash}`;
    const isFresh = opts.replayGuard.consumeOnce(
      replayKey,
      nowUnixSeconds,
      Math.max(60, maxAgeSeconds)
    );
    if (!isFresh) {
      return { valid: false, reason: 'replay_detected' };
    }
  }

  return {
    valid: true,
    telegramUser: parsedUser,
    queryId,
    authDate: authDateRaw,
    dataCheckHash: computedHash,
  };
}

/**
 * Verifies that a shared Telegram contact strictly belongs to the Telegram sender.
 * Security Rules:
 * 1. Never accept plain-text messages as a verified phone number.
 * 2. Require a native Telegram `contact` payload.
 * 3. Require `contact.user_id` to exist and strictly equal `senderTelegramId` (blocks forwarded contacts).
 * 4. Normalize and validate E.164 phone format (9..15 digits).
 */
export function verifyTelegramSharedContact(params: {
  senderTelegramId?: number;
  messageText?: string;
  contact?: {
    phone_number?: string;
    first_name?: string;
    last_name?: string;
    user_id?: number;
  } | null;
}): TelegramContactVerificationResult {
  const { senderTelegramId, messageText, contact } = params;

  if (
    typeof senderTelegramId !== 'number' ||
    !Number.isInteger(senderTelegramId) ||
    senderTelegramId <= 0
  ) {
    return { valid: false, reason: 'missing_sender_id' };
  }

  if (!contact) {
    if (messageText && /\+?[0-9]{7,15}/.test(messageText)) {
      return { valid: false, reason: 'plain_text_phone_rejected' };
    }
    return { valid: false, reason: 'missing_contact_object' };
  }

  if (typeof contact.user_id !== 'number' || !Number.isInteger(contact.user_id)) {
    return { valid: false, reason: 'missing_contact_user_id' };
  }

  if (contact.user_id !== senderTelegramId) {
    return { valid: false, reason: 'contact_owner_mismatch' };
  }

  const rawPhone = String(contact.phone_number || '').replace(/[\s\-()]/g, '');
  const normalizedPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
  if (!/^\+[0-9]{9,15}$/.test(normalizedPhone)) {
    return { valid: false, reason: 'invalid_phone_format' };
  }

  return {
    valid: true,
    verifiedPhoneNumber: normalizedPhone,
    telegramUserId: senderTelegramId,
  };
}
