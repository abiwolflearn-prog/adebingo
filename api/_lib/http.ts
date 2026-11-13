import type { VercelRequest, VercelResponse } from '@vercel/node';
import { DEFAULT_DEPLOYED_MINI_APP_URL } from '../../src/utils/telegramBot.ts';

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getHeaderValue(
  req: Pick<VercelRequest, 'headers'>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  const raw = req.headers?.[lower] ?? req.headers?.[name];
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0] : undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

export function getClientIp(req: Pick<VercelRequest, 'headers' | 'socket'>): string {
  const xff = getHeaderValue(req, 'x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = getHeaderValue(req, 'x-real-ip');
  if (realIp) return realIp.trim().slice(0, 64);
  const remote = req.socket?.remoteAddress;
  return typeof remote === 'string' && remote ? remote.slice(0, 64) : 'unknown';
}

export function setSecurityHeaders(res: VercelResponse): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function sendJson(
  res: VercelResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  setSecurityHeaders(res);
  res.status(statusCode).json(payload);
}

export function sendError(
  res: VercelResponse,
  statusCode: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  sendJson(res, statusCode, {
    ok: false,
    error: reason,
    reason,
    message,
    ...extra,
  });
}

export function enforceMethod(
  req: VercelRequest,
  res: VercelResponse,
  allowedMethods: readonly string[]
): boolean {
  const method = (req.method || 'GET').toUpperCase();
  if (!allowedMethods.includes(method)) {
    res.setHeader('Allow', allowedMethods.join(', '));
    sendError(
      res,
      405,
      'method_not_allowed',
      `HTTP method ${method} is not allowed on this endpoint.`
    );
    return false;
  }
  return true;
}

function sanitizePlainObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const clean: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_PROTO_KEYS.has(k)) {
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

export async function parseJsonBody(
  req: VercelRequest,
  res: VercelResponse,
  options: { maxBytes?: number; required?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  const maxBytes = options.maxBytes ?? 32 * 1024;
  const required = options.required ?? true;

  const contentType = (getHeaderValue(req, 'content-type') || '').toLowerCase();
  const contentLengthRaw = getHeaderValue(req, 'content-length');
  if (contentLengthRaw !== undefined) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      sendError(res, 413, 'payload_too_large', 'Request body exceeds maximum allowed size.');
      return null;
    }
  }

  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > maxBytes) {
        sendError(res, 413, 'payload_too_large', 'Request body exceeds maximum allowed size.');
        return null;
      }
      if (req.body.trim() === '') {
        if (!required) return Object.create(null);
        sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
        return null;
      }
      if (contentType && !contentType.includes('application/json')) {
        sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
        return null;
      }
      try {
        const parsed = JSON.parse(req.body);
        const sanitized = sanitizePlainObject(parsed);
        if (!sanitized) {
          sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
          return null;
        }
        return sanitized;
      } catch {
        sendError(res, 400, 'invalid_json_body', 'Malformed JSON request body.');
        return null;
      }
    }

    if (Buffer.isBuffer(req.body)) {
      if (req.body.byteLength > maxBytes) {
        sendError(res, 413, 'payload_too_large', 'Request body exceeds maximum allowed size.');
        return null;
      }
      try {
        const parsed = JSON.parse(req.body.toString('utf8'));
        const sanitized = sanitizePlainObject(parsed);
        if (!sanitized) {
          sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
          return null;
        }
        return sanitized;
      } catch {
        sendError(res, 400, 'invalid_json_body', 'Malformed JSON request body.');
        return null;
      }
    }

    if (contentType && !contentType.includes('application/json')) {
      sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
      return null;
    }

    const rawBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (rawBytes > maxBytes) {
      sendError(res, 413, 'payload_too_large', 'Request body exceeds maximum allowed size.');
      return null;
    }
    const sanitized = sanitizePlainObject(req.body);
    if (!sanitized) {
      sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
      return null;
    }
    return sanitized;
  }

  if (contentType && !contentType.includes('application/json')) {
    sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
    return null;
  }

  // Fallback: read stream when framework has not pre-parsed req.body
  if (typeof (req as unknown as { on?: unknown }).on !== 'function') {
    if (!required) return Object.create(null);
    sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
    return null;
  }

  return await new Promise<Record<string, unknown> | null>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (status: number, reason: string, msg: string) => {
      if (settled) return;
      settled = true;
      sendError(res, status, reason, msg);
      resolve(null);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        fail(413, 'payload_too_large', 'Request body exceeds maximum allowed size.');
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        if (!required) {
          resolve(Object.create(null));
          return;
        }
        sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        const sanitized = sanitizePlainObject(parsed);
        if (!sanitized) {
          sendError(res, 400, 'invalid_json_body', 'Request body must be a JSON object.');
          resolve(null);
          return;
        }
        resolve(sanitized);
      } catch {
        sendError(res, 400, 'invalid_json_body', 'Malformed JSON request body.');
        resolve(null);
      }
    });

    req.on('error', () => {
      fail(400, 'invalid_json_body', 'Failed to read request body.');
    });
  });
}

export function findForbiddenOverrideFields(
  body: Record<string, unknown>,
  forbiddenFields: readonly string[]
): string[] {
  return forbiddenFields.filter(
    (field) => Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined
  );
}

export function extractIdempotencyKey(
  req: VercelRequest,
  body?: Record<string, unknown>
): string | undefined {
  const headerKey = getHeaderValue(req, 'x-idempotency-key');
  const bodyKey =
    body && typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey
      : body && typeof body.requestNonce === 'string'
        ? body.requestNonce
        : undefined;
  const candidate = (headerKey ?? bodyKey ?? '').trim();
  if (!candidate) return undefined;
  if (candidate.length > 128 || !/^[a-zA-Z0-9_.:-]+$/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

export function isValidRoomId(roomId: unknown): roomId is string {
  return (
    typeof roomId === 'string' &&
    roomId.length >= 1 &&
    roomId.length <= 64 &&
    /^[a-zA-Z0-9_-]+$/.test(roomId)
  );
}

export function isValidGameId(gameId: unknown): gameId is string {
  return (
    typeof gameId === 'string' &&
    gameId.length >= 1 &&
    gameId.length <= 64 &&
    /^[a-zA-Z0-9_-]+$/.test(gameId)
  );
}

export function getPublicMiniAppUrl(): string {
  const candidate = [process.env.PUBLIC_MINI_APP_URL, process.env.APP_URL].find(
    (url) =>
      typeof url === 'string' &&
      url.startsWith('https://') &&
      url !== 'MY_APP_URL' &&
      !url.includes('ais-dev-') &&
      !url.includes('ais-pre-')
  );
  const normalized = (candidate || DEFAULT_DEPLOYED_MINI_APP_URL).replace(/\/+$/, '');
  return `${normalized}/`;
}

export function isConfiguredBotToken(token: string | undefined): token is string {
  return Boolean(
    token && token.trim().length > 10 && token.trim() !== 'MY_TELEGRAM_BOT_TOKEN'
  );
}

export function isConfiguredWebhookSecret(secret: string | undefined): secret is string {
  return Boolean(
    secret && secret.trim().length >= 8 && secret.trim() !== 'MY_TELEGRAM_WEBHOOK_SECRET'
  );
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class BoundedRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();
  private readonly maxBuckets: number;

  constructor(maxBuckets = 5000) {
    this.maxBuckets = maxBuckets;
  }

  public check(
    key: string,
    limit: number,
    windowSeconds: number,
    nowMs: number = Date.now()
  ): RateLimitResult {
    const existing = this.buckets.get(key);
    const windowMs = Math.max(1000, windowSeconds * 1000);

    if (!existing || existing.resetAtMs <= nowMs) {
      if (this.buckets.size >= this.maxBuckets) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey) this.buckets.delete(firstKey);
      }
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return {
        allowed: true,
        remaining: Math.max(0, limit - 1),
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    };
  }

  public clear(): void {
    this.buckets.clear();
  }
}

export const defaultApiRateLimiter = new BoundedRateLimiter();

export function enforceRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  options: {
    scope: string;
    subject?: string;
    limit: number;
    windowSeconds: number;
    limiter?: BoundedRateLimiter;
    nowMs?: number;
  }
): boolean {
  const limiter = options.limiter ?? defaultApiRateLimiter;
  const ip = getClientIp(req);
  const key = options.subject
    ? `${options.scope}:${options.subject}:${ip}`
    : `${options.scope}:${ip}`;
  const result = limiter.check(key, options.limit, options.windowSeconds, options.nowMs);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    sendError(
      res,
      429,
      'rate_limit_exceeded',
      'Too many requests. Please wait before trying again.',
      { retryAfterSeconds: result.retryAfterSeconds }
    );
    return false;
  }
  return true;
}
