import crypto from 'node:crypto';
const KNOWN_PLACEHOLDER_BOT_TOKENS = new Set([
    'MY_TELEGRAM_BOT_TOKEN',
    'YOUR_TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'REPLACE_ME',
    'ADEYBINGO_SERVER_INITDATA_HMAC_KEY_V1',
]);
/**
 * Checks whether a Telegram Bot Token is missing, whitespace, or a known placeholder.
 * Never logs or exposes the token value.
 */
export function isPlaceholderOrEmptyBotToken(token) {
    if (typeof token !== 'string')
        return true;
    const trimmed = token.trim();
    if (!trimmed)
        return true;
    const upper = trimmed.toUpperCase();
    if (KNOWN_PLACEHOLDER_BOT_TOKENS.has(upper) ||
        upper.startsWith('PLACEHOLDER') ||
        upper.startsWith('YOUR_') ||
        upper.startsWith('MY_TELEGRAM_')) {
        return true;
    }
    return false;
}
/**
 * Telegram Bot API tokens issued by @BotFather follow `<numeric_bot_id>:<secret>`.
 */
export function hasValidTelegramBotTokenFormat(token) {
    if (typeof token !== 'string')
        return false;
    const trimmed = token.trim();
    if (isPlaceholderOrEmptyBotToken(trimmed))
        return false;
    return /^\d+:[^\s]{8,}$/.test(trimmed);
}
/**
 * Bounded TTL Replay & Duplicate Request Guard.
 * Prevents replay of Telegram initData hashes, query_ids, webhook update_ids, or action nonces.
 */
export class TelegramReplayGuard {
    constructor(maxEntries = 5000, defaultTtlSeconds = 3600) {
        this.seen = new Map();
        this.maxEntries = maxEntries;
        this.defaultTtlSeconds = defaultTtlSeconds;
    }
    /**
     * Returns true if the key is fresh and records it; returns false if already consumed within TTL.
     */
    consumeOnce(replayKey, nowUnixSeconds = Math.floor(Date.now() / 1000), ttlSeconds = this.defaultTtlSeconds) {
        if (!replayKey || replayKey.trim() === '')
            return false;
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
    clear() {
        this.seen.clear();
    }
    pruneExpired(nowUnixSeconds) {
        for (const [k, exp] of this.seen.entries()) {
            if (exp < nowUnixSeconds) {
                this.seen.delete(k);
            }
        }
    }
}
export const defaultReplayGuard = new TelegramReplayGuard();
/**
 * Inspects raw query string structure before URLSearchParams normalizes away errors.
 */
function inspectRawQueryStringFormatting(trimmedInitData) {
    const looksLikeJsonInsteadOfQueryString = trimmedInitData.startsWith('{') || trimmedInitData.startsWith('[');
    const hasLeadingQuestionMarkOrHashPrefix = trimmedInitData.startsWith('?') || trimmedInitData.startsWith('#');
    const looksLikeInitDataUnsafe = looksLikeJsonInsteadOfQueryString &&
        (trimmedInitData.includes('"user"') || trimmedInitData.includes('"auth_date"'));
    if (looksLikeJsonInsteadOfQueryString || hasLeadingQuestionMarkOrHashPrefix) {
        return {
            looksLikeJsonInsteadOfQueryString,
            looksLikeInitDataUnsafe,
            hasLeadingQuestionMarkOrHashPrefix,
            malformedSegments: true,
        };
    }
    const segments = trimmedInitData.split('&').filter((seg) => seg.length > 0);
    if (segments.length === 0) {
        return {
            looksLikeJsonInsteadOfQueryString: false,
            looksLikeInitDataUnsafe: false,
            hasLeadingQuestionMarkOrHashPrefix: false,
            malformedSegments: true,
        };
    }
    for (const seg of segments) {
        const eqIdx = seg.indexOf('=');
        if (eqIdx <= 0) {
            // Missing '=' or empty key (e.g. "not_a_query_string" or "=value")
            return {
                looksLikeJsonInsteadOfQueryString: false,
                looksLikeInitDataUnsafe: false,
                hasLeadingQuestionMarkOrHashPrefix: false,
                malformedSegments: true,
            };
        }
        const rawKey = seg.slice(0, eqIdx);
        const rawVal = seg.slice(eqIdx + 1);
        try {
            decodeURIComponent(rawKey.replace(/\+/g, '%20'));
            decodeURIComponent(rawVal.replace(/\+/g, '%20'));
        }
        catch {
            return {
                looksLikeJsonInsteadOfQueryString: false,
                looksLikeInitDataUnsafe: false,
                hasLeadingQuestionMarkOrHashPrefix: false,
                malformedSegments: true,
            };
        }
    }
    return {
        looksLikeJsonInsteadOfQueryString: false,
        looksLikeInitDataUnsafe: false,
        hasLeadingQuestionMarkOrHashPrefix: false,
        malformedSegments: false,
    };
}
/**
 * Validates Telegram Mini App initData using the official HMAC-SHA256 algorithm:
 * 1. Parse original raw initData query string cleanly without altering field encoding.
 * 2. Extract `hash` and exclude it from data_check_string.
 * 3. Sort remaining entries alphabetically by **key** using ASCII/UTF-8 code-unit order and join with `\n`.
 * 4. Derive secretKey = HMAC_SHA256(key="WebAppData", message=TELEGRAM_BOT_TOKEN) as raw 32-byte digest.
 * 5. Compute expectedHash = HMAC_SHA256(key=secretKey, message=dataCheckString).hex().
 * 6. Compare expectedHash with `hash` using constant-time crypto.timingSafeEqual.
 * 7. Verify `auth_date` is neither expired nor forged in the future (>60s skew).
 * 8. Require a valid `user` JSON payload with a positive integer `id`.
 * 9. Enforce optional expectedTelegramUserId ownership binding and replay protection.
 */
export function validateTelegramWebAppInitData(rawInitData, botToken, maxAgeSecondsOrOptions = 3600, nowUnixSecondsArg) {
    const opts = typeof maxAgeSecondsOrOptions === 'number'
        ? {
            maxAgeSeconds: maxAgeSecondsOrOptions,
            nowUnixSeconds: nowUnixSecondsArg,
        }
        : maxAgeSecondsOrOptions;
    const maxAgeSeconds = opts.maxAgeSeconds ?? 3600;
    const nowUnixSeconds = opts.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    const maxFutureSkewSeconds = opts.maxFutureSkewSeconds ?? 60;
    const trimmedBotToken = typeof botToken === 'string' ? botToken.trim() : '';
    const botTokenConfigured = !isPlaceholderOrEmptyBotToken(trimmedBotToken);
    const botTokenFormatValid = hasValidTelegramBotTokenFormat(trimmedBotToken);
    const trimmedInitData = typeof rawInitData === 'string' ? rawInitData.trim() : '';
    const initDataPresent = trimmedInitData.length > 0;
    if (!initDataPresent) {
        return {
            valid: false,
            reason: 'missing_init_data',
            diagnostics: {
                failureCategory: 'missing_init_data',
                botTokenConfigured,
                botTokenFormatValid,
                initDataPresent: false,
                initDataLength: 0,
                looksLikeJsonInsteadOfQueryString: false,
                looksLikeInitDataUnsafe: false,
                hasLeadingQuestionMarkOrHashPrefix: false,
                hasHash: false,
                hashFormatValid: false,
                hasAuthDate: false,
                maxAgeSeconds,
                hasUserField: false,
                fieldKeysCount: 0,
                fieldKeys: [],
            },
        };
    }
    const formatCheck = inspectRawQueryStringFormatting(trimmedInitData);
    const params = formatCheck.malformedSegments
        ? new URLSearchParams()
        : new URLSearchParams(trimmedInitData);
    const fieldKeys = Array.from(new Set(Array.from(params.keys()))).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const receivedHash = params.get('hash');
    const hasHash = Boolean(receivedHash && receivedHash.trim().length > 0);
    const hashFormatValid = Boolean(receivedHash && /^[0-9a-f]{64}$/i.test(receivedHash));
    const authDateParam = params.get('auth_date');
    const authDateRaw = authDateParam !== null ? Number(authDateParam) : Number.NaN;
    const hasAuthDate = authDateParam !== null && authDateParam.trim() !== '';
    const authDateAgeSeconds = Number.isInteger(authDateRaw) && authDateRaw > 0
        ? nowUnixSeconds - authDateRaw
        : undefined;
    const hasUserField = Boolean(params.get('user'));
    const buildDiagnostics = (failureCategory) => ({
        failureCategory,
        botTokenConfigured,
        botTokenFormatValid,
        initDataPresent,
        initDataLength: trimmedInitData.length,
        looksLikeJsonInsteadOfQueryString: formatCheck.looksLikeJsonInsteadOfQueryString,
        looksLikeInitDataUnsafe: formatCheck.looksLikeInitDataUnsafe,
        hasLeadingQuestionMarkOrHashPrefix: formatCheck.hasLeadingQuestionMarkOrHashPrefix,
        hasHash,
        hashFormatValid,
        hasAuthDate,
        ...(authDateAgeSeconds !== undefined ? { authDateAgeSeconds } : {}),
        maxAgeSeconds,
        hasUserField,
        fieldKeysCount: fieldKeys.length,
        fieldKeys,
    });
    if (!botTokenConfigured) {
        return {
            valid: false,
            reason: 'missing_bot_token',
            diagnostics: buildDiagnostics('backend_environment_configuration'),
        };
    }
    if (formatCheck.malformedSegments) {
        return {
            valid: false,
            reason: 'malformed_init_data',
            diagnostics: buildDiagnostics(formatCheck.looksLikeJsonInsteadOfQueryString ||
                formatCheck.hasLeadingQuestionMarkOrHashPrefix
                ? 'frontend_request_formatting'
                : 'malformed_init_data'),
        };
    }
    if (!hasHash) {
        return {
            valid: false,
            reason: 'missing_hash',
            diagnostics: buildDiagnostics('missing_hash'),
        };
    }
    if (!hashFormatValid || !receivedHash) {
        return {
            valid: false,
            reason: 'malformed_init_data',
            diagnostics: buildDiagnostics('malformed_init_data'),
        };
    }
    if (!Number.isInteger(authDateRaw) || authDateRaw <= 0) {
        return {
            valid: false,
            reason: 'malformed_init_data',
            diagnostics: buildDiagnostics('malformed_init_data'),
        };
    }
    // Sort strictly alphabetically by parameter KEY (ASCII/UTF-8 code-unit order), never by "key=value" with localeCompare.
    const entries = [];
    params.forEach((value, key) => {
        if (key !== 'hash') {
            entries.push([key, value]);
        }
    });
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    // Official Telegram algorithm:
    // secret_key = HMAC-SHA256(key="WebAppData", message=bot_token) -> raw binary Buffer (never hex)
    // hash = HMAC-SHA256(key=secret_key, message=data_check_string).hex()
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(trimmedBotToken).digest();
    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');
    const aBuf = Buffer.from(computedHash, 'hex');
    const bBuf = Buffer.from(receivedHash.toLowerCase(), 'hex');
    if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
        return {
            valid: false,
            reason: 'signature_mismatch',
            diagnostics: buildDiagnostics(botTokenFormatValid
                ? 'incorrect_bot_token_or_signature'
                : 'backend_environment_configuration'),
        };
    }
    if (authDateRaw > nowUnixSeconds + maxFutureSkewSeconds) {
        return {
            valid: false,
            reason: 'future_auth_date',
            diagnostics: buildDiagnostics('future_auth_date'),
        };
    }
    if (maxAgeSeconds > 0 && nowUnixSeconds - authDateRaw > maxAgeSeconds) {
        return {
            valid: false,
            reason: 'expired_auth_date',
            diagnostics: buildDiagnostics('expired_auth_date'),
        };
    }
    let parsedUser;
    const userJson = params.get('user');
    if (userJson) {
        try {
            parsedUser = JSON.parse(userJson);
        }
        catch {
            return {
                valid: false,
                reason: 'malformed_init_data',
                diagnostics: buildDiagnostics('malformed_init_data'),
            };
        }
    }
    if (!parsedUser ||
        typeof parsedUser.id !== 'number' ||
        !Number.isInteger(parsedUser.id) ||
        parsedUser.id <= 0) {
        return {
            valid: false,
            reason: 'missing_telegram_user',
            diagnostics: buildDiagnostics('missing_telegram_user'),
        };
    }
    if (opts.expectedTelegramUserId !== undefined &&
        parsedUser.id !== opts.expectedTelegramUserId) {
        return {
            valid: false,
            reason: 'telegram_id_mismatch',
            diagnostics: buildDiagnostics('telegram_id_mismatch'),
        };
    }
    const queryId = params.get('query_id') || undefined;
    if (opts.replayGuard) {
        const replayKey = opts.actionNonce
            ? `init:${computedHash}:nonce:${opts.actionNonce}`
            : `init:${computedHash}`;
        const isFresh = opts.replayGuard.consumeOnce(replayKey, nowUnixSeconds, Math.max(60, maxAgeSeconds));
        if (!isFresh) {
            return {
                valid: false,
                reason: 'replay_detected',
                diagnostics: buildDiagnostics('replay_detected'),
            };
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
export function verifyTelegramSharedContact(params) {
    const { senderTelegramId, messageText, contact } = params;
    if (typeof senderTelegramId !== 'number' ||
        !Number.isInteger(senderTelegramId) ||
        senderTelegramId <= 0) {
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
