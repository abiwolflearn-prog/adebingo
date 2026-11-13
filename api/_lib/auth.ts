import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyWebhookSecretHeader } from '../../src/utils/telegramBot.ts';
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
  displayName: string;
  isTelegramVerified: boolean;
  isEmailVerified: boolean;
  isAdmin: boolean;
}

export interface AuthBackendDeps {
  verifyIdToken: (idToken: string, checkRevoked?: boolean) => Promise<DecodedIdTokenLike>;
  isAdminUid: (uid: string) => Promise<boolean>;
  getUserDisplayName?: (uid: string) => Promise<string | null>;
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
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  return match[1];
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

  let resolvedDeps: AuthBackendDeps;
  try {
    resolvedDeps = deps ?? createDefaultAuthDeps();
  } catch {
    sendError(
      res,
      503,
      'auth_service_unavailable',
      'Server authentication service is not configured.'
    );
    return null;
  }

  let decoded: DecodedIdTokenLike;
  try {
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

  let isAdmin = false;
  if (
    isEmailVerified &&
    typeof decoded.email === 'string' &&
    decoded.email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL
  ) {
    isAdmin = true;
  } else {
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
    displayName,
    isTelegramVerified,
    isEmailVerified,
    isAdmin,
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
