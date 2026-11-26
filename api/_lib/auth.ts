import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyWebhookSecretHeader } from '../../src/utils/telegramBot.ts';
import {
  AUTHORIZED_ADMIN_EMAILS,
  getAuthorizedAdminTelegramIds,
  verifyServerSessionToken,
} from '../../src/utils/adminAuthority.ts';
import {
  getAdminAuth,
  getAdminDb,
  getTelegramFirebaseUid,
} from './firebaseAdmin.ts';
import { getHeaderValue, isConfiguredWebhookSecret, sendError } from './http.ts';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'abelbimrew868@gmail.com';

export interface DecodedIdTokenLike {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  telegram_verified?: boolean;
  telegram_id?: unknown;
}

export interface AuthenticatedCaller {
  uid: string;
  telegramId?: number;
  email?: string;
  displayName: string;
  isTelegramVerified: boolean;
  isEmailVerified: boolean;
  isAdmin: boolean;
  authMethod?: 'firebase_id_token' | 'admin_session_token';
  issuedAt?: number;
  expiresAt?: number;
}

export interface AuthBackendDeps {
  verifyIdToken?: (idToken: string, checkRevoked?: boolean) => Promise<DecodedIdTokenLike>;
  isAdminUid?: (uid: string) => Promise<boolean>;
  getUserDisplayName?: (uid: string) => Promise<string | null>;
  getDb?: () => unknown;
  sessionSecret?: string;
  getSessionSecret?: () => string | undefined;
  nowUnixSeconds?: () => number;
}

export function resolveAdminSessionSecret(
  explicitSecretOrDeps?: string | AuthBackendDeps
): string | null {
  const explicitSecret =
    typeof explicitSecretOrDeps === 'string'
      ? explicitSecretOrDeps
      : explicitSecretOrDeps?.sessionSecret ||
        (typeof explicitSecretOrDeps?.getSessionSecret === 'function'
          ? explicitSecretOrDeps.getSessionSecret()
          : undefined);
  if (typeof explicitSecret === 'string' && explicitSecret.trim().length >= 16) {
    return explicitSecret.trim();
  }
  const envAdminSecret = (process.env.ADMIN_SESSION_SECRET || '').trim();
  if (envAdminSecret.length >= 16) {
    return envAdminSecret;
  }
  const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (webhookSecret.length >= 8 && webhookSecret !== 'MY_TELEGRAM_WEBHOOK_SECRET') {
    return crypto
      .createHash('sha256')
      .update(`adeybingo_admin_session_v2:${webhookSecret}`)
      .digest('hex');
  }
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (botToken.length >= 10 && botToken !== 'MY_TELEGRAM_BOT_TOKEN') {
    return crypto
      .createHash('sha256')
      .update(`adeybingo_admin_session_v2:${botToken}`)
      .digest('hex');
  }
  return null;
}

export function isServerAllowlistedAdmin(params: {
  uid?: string;
  telegramId?: number;
  email?: string;
  isEmailVerified?: boolean;
}): boolean {
  if (
    params.isEmailVerified &&
    typeof params.email === 'string' &&
    AUTHORIZED_ADMIN_EMAILS.includes(params.email.toLowerCase())
  ) {
    return true;
  }

  const envTgIds = getAuthorizedAdminTelegramIds();

  if (
    typeof params.telegramId === 'number' &&
    Number.isInteger(params.telegramId) &&
    params.telegramId > 0
  ) {
    if (envTgIds.includes(params.telegramId)) {
      return true;
    }
  }

  return false;
}

export function createDefaultAuthDeps(): AuthBackendDeps {
  const auth = getAdminAuth();
  const db = getAdminDb();

  return {
    async verifyIdToken(idToken: string, checkRevoked = true): Promise<DecodedIdTokenLike> {
      return (await auth.verifyIdToken(idToken, checkRevoked)) as DecodedIdTokenLike;
    },
    async isAdminUid(uid: string): Promise<boolean> {
      const snap = await db.collection('admins').doc(uid).get();
      return snap.exists;
    },
    async getUserDisplayName(uid: string): Promise<string | null> {
      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) return null;
      const name = snap.get('displayName');
      return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null;
    },
  };
}

export function extractBearerToken(req: VercelRequest): string | null {
  const header = getHeaderValue(req, 'authorization');
  if (header) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
    if (match && match[1]) return match[1];
  }
  const sessionHeader = getHeaderValue(req, 'x-adey-session-token');
  if (sessionHeader && sessionHeader.trim()) {
    return sessionHeader.trim();
  }
  return null;
}

export async function authenticateRequest(
  req: VercelRequest,
  res: VercelResponse,
  deps?: AuthBackendDeps,
  options: {
    requireAdmin?: boolean;
    requireTelegramVerified?: boolean;
  } = {}
): Promise<AuthenticatedCaller | null> {
  const token = extractBearerToken(req);
  if (!token) {
    sendError(
      res,
      401,
      'missing_authorization',
      'Authentication required. Provide a valid Bearer token.'
    );
    return null;
  }

  const nowUnixSeconds = deps?.nowUnixSeconds
    ? deps.nowUnixSeconds()
    : Math.floor(Date.now() / 1000);

  // 1. First check if the token is a signed server session token (format: base64url.hmacSig)
  const sessionSecret = resolveAdminSessionSecret(deps);
  if (sessionSecret && token.includes('.') && token.split('.').length === 2) {
    const verifiedSession = verifyServerSessionToken(
      token,
      sessionSecret,
      3600,
      nowUnixSeconds
    );
    if (verifiedSession) {
      let isAdmin = isServerAllowlistedAdmin({
        uid: verifiedSession.uid,
        telegramId: verifiedSession.telegramUserId,
        email: verifiedSession.email,
        isEmailVerified: Boolean(verifiedSession.email),
      });

      if (!isAdmin && deps?.isAdminUid) {
        try {
          isAdmin = await deps.isAdminUid(verifiedSession.uid);
        } catch {
          isAdmin = false;
        }
      }

      if (options.requireTelegramVerified && !verifiedSession.telegramUserId) {
        sendError(
          res,
          403,
          'telegram_verification_required',
          'This endpoint requires a verified Telegram Mini App session.'
        );
        return null;
      }

      if (options.requireAdmin && !isAdmin) {
        sendError(
          res,
          403,
          'admin_required',
          'Administrator authorization is required for this operation.'
        );
        return null;
      }

      return {
        uid: verifiedSession.uid,
        telegramId: verifiedSession.telegramUserId || undefined,
        email: verifiedSession.email,
        displayName: verifiedSession.displayName || `Player ${verifiedSession.uid}`,
        isTelegramVerified: Boolean(verifiedSession.telegramUserId),
        isEmailVerified: Boolean(verifiedSession.email),
        isAdmin,
        authMethod: 'admin_session_token',
        issuedAt: verifiedSession.issuedAt,
        expiresAt: verifiedSession.expiresAt,
      };
    }
  }

  // 2. Otherwise verify as a Firebase ID Token
  let resolvedDeps: AuthBackendDeps;
  try {
    resolvedDeps = deps?.verifyIdToken ? deps : { ...createDefaultAuthDeps(), ...deps };
  } catch {
    if (deps?.verifyIdToken) {
      resolvedDeps = deps;
    } else {
      sendError(
        res,
        503,
        'auth_service_unavailable',
        'Server authentication service is not configured.'
      );
      return null;
    }
  }

  let decoded: DecodedIdTokenLike;
  try {
    if (!resolvedDeps.verifyIdToken) {
      throw new Error('verifyIdToken not available');
    }
    decoded = await resolvedDeps.verifyIdToken(token, true);
  } catch {
    sendError(
      res,
      401,
      'invalid_or_expired_token',
      'Authentication token is invalid, expired, or revoked.'
    );
    return null;
  }

  const uid = typeof decoded.uid === 'string' ? decoded.uid.trim() : '';
  if (!uid || !/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) {
    sendError(res, 401, 'invalid_token_uid', 'Authenticated token contains an invalid UID.');
    return null;
  }

  const rawTgId = decoded.telegram_id;
  const tgIdNum = typeof rawTgId === 'number' ? rawTgId : Number.NaN;
  const isTelegramVerified =
    decoded.telegram_verified === true &&
    Number.isInteger(tgIdNum) &&
    tgIdNum > 0 &&
    uid === getTelegramFirebaseUid(tgIdNum);

  const isEmailVerified = decoded.email_verified === true;
  if (!isTelegramVerified && !isEmailVerified) {
    sendError(
      res,
      403,
      'unverified_identity',
      'Verified Telegram or verified email authentication is required.'
    );
    return null;
  }

  if (options.requireTelegramVerified && !isTelegramVerified) {
    sendError(
      res,
      403,
      'telegram_verification_required',
      'This endpoint requires a verified Telegram Mini App session.'
    );
    return null;
  }

  let isAdmin = isServerAllowlistedAdmin({
    uid,
    telegramId: isTelegramVerified ? tgIdNum : undefined,
    email: decoded.email,
    isEmailVerified,
  });

  if (!isAdmin && resolvedDeps.isAdminUid) {
    try {
      isAdmin = await resolvedDeps.isAdminUid(uid);
    } catch {
      isAdmin = false;
    }
  }

  if (options.requireAdmin && !isAdmin) {
    sendError(
      res,
      403,
      'admin_required',
      'Administrator authorization is required for this operation.'
    );
    return null;
  }

  let displayName =
    typeof decoded.name === 'string' && decoded.name.trim()
      ? decoded.name.trim().slice(0, 80)
      : '';
  if (!displayName && resolvedDeps.getUserDisplayName) {
    try {
      displayName = (await resolvedDeps.getUserDisplayName(uid)) || '';
    } catch {
      displayName = '';
    }
  }
  if (!displayName) {
    displayName = isTelegramVerified ? `Player ${tgIdNum}` : 'Adey Player';
  }

  return {
    uid,
    telegramId: isTelegramVerified ? tgIdNum : undefined,
    email: decoded.email,
    displayName,
    isTelegramVerified,
    isEmailVerified,
    isAdmin,
    authMethod: 'firebase_id_token',
  };
}

/**
 * Fail-closed verification of X-Telegram-Bot-Api-Secret-Token.
 * Rejects with 503 if server secret is unconfigured, and 401 if header is missing/incorrect.
 */
export function requireValidWebhookSecret(
  req: VercelRequest,
  res: VercelResponse,
  configuredSecret: string | undefined = process.env.TELEGRAM_WEBHOOK_SECRET
): boolean {
  if (!isConfiguredWebhookSecret(configuredSecret)) {
    sendError(
      res,
      503,
      'missing_webhook_secret',
      'TELEGRAM_WEBHOOK_SECRET is not configured on the server.'
    );
    return false;
  }

  const secretHeader = getHeaderValue(req, 'x-telegram-bot-api-secret-token');
  if (!secretHeader || !verifyWebhookSecretHeader(secretHeader, configuredSecret)) {
    sendError(
      res,
      401,
      'invalid_webhook_secret_token',
      'Missing or invalid X-Telegram-Bot-Api-Secret-Token header.'
    );
    return false;
  }

  return true;
}

/**
 * Enforces that non-admin players have completed Telegram contact phone verification
 * before reserving cards, participating in live rounds, or submitting wallet deposits/withdrawals.
 * Fails closed with HTTP 403 `phone_verification_required`.
 */
export async function requirePhoneVerifiedPlayer(
  db: {
    collection: (name: string) => {
      doc: (id: string) => {
        get: () => Promise<{
          exists: boolean;
          get?: (field: string) => unknown;
          data?: () => Record<string, unknown> | undefined;
        }>;
      };
    };
  },
  caller: AuthenticatedCaller,
  res: VercelResponse
): Promise<boolean> {
  if (caller.isAdmin) {
    return true;
  }

  const tgMatch = /^tg_([1-9]\d*)$/.exec(caller.uid);
  const resolvedTgId = caller.telegramId || (tgMatch ? Number(tgMatch[1]) : 0);

  let verified = false;
  try {
    const userSnap = await db.collection('users').doc(caller.uid).get();
    if (userSnap.exists) {
      const val =
        typeof userSnap.get === 'function'
          ? userSnap.get('phoneVerified')
          : userSnap.data?.()?.phoneVerified;
      if (val === true) verified = true;
    }
    if (!verified && resolvedTgId > 0) {
      const botSnap = await db.collection('botPlayers').doc(String(resolvedTgId)).get();
      if (botSnap.exists) {
        const val =
          typeof botSnap.get === 'function'
            ? botSnap.get('phoneVerified')
            : botSnap.data?.()?.phoneVerified;
        if (val === true) verified = true;
      }
    }
  } catch {
    verified = false;
  }

  if (!verified) {
    sendError(
      res,
      403,
      'phone_verification_required',
      'Phone verification is required before playing. Please verify your phone number via @AdeyBingoGameBot first. / ከመጫወትዎ በፊት በ @AdeyBingoGameBot ስልክ ቁጥርዎን ያረጋግጡ።'
    );
    return false;
  }

  return true;
}
