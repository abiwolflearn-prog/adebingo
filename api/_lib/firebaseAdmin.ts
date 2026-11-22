import { cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const FIREBASE_PROJECT_ID = 'gen-lang-client-0559010770';
export const FIREBASE_DATABASE_ID =
  'ai-studio-adeybingotelegra-e167ea3c-c285-4e91-8373-d40b1718c6cc';

interface RawServiceAccountJson {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  projectId?: string;
  privateKey?: string;
  clientEmail?: string;
}

export type FirebaseAdminCredentialSource =
  | 'service_account_json'
  | 'split_env_vars'
  | 'none';

export type FirebaseAdminDiagnosticCode =
  | 'configured'
  | 'missing_credentials'
  | 'invalid_json_or_base64'
  | 'missing_required_fields'
  | 'invalid_private_key_format'
  | 'project_id_mismatch';

export interface FirebaseAdminConfigDiagnostics {
  configured: boolean;
  source: FirebaseAdminCredentialSource;
  diagnostic: FirebaseAdminDiagnosticCode;
  projectId: string;
  databaseId: string;
}

export interface FirestoreHealthCheckResult {
  reachable: boolean;
  status: 'ok' | 'unconfigured' | 'error';
  databaseId: string;
  latencyMs?: number;
  errorCode?: string;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizePrivateKeyPem(rawKey: string): string {
  const unquoted = stripOuterQuotes(rawKey);
  return unquoted
    .replace(/\r\n/g, '\n')
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();
}

function isValidPemPrivateKey(privateKey: string): boolean {
  return (
    privateKey.includes('-----BEGIN') &&
    privateKey.includes('PRIVATE KEY-----') &&
    privateKey.includes('-----END')
  );
}

function tryParseJsonObject(text: string): RawServiceAccountJson | null {
  const attempts: string[] = [text];
  // Handle pretty-printed or env-pasted JSON with literal newlines inside string values
  if (text.includes('\n') || text.includes('\r')) {
    attempts.push(text.replace(/\r\n/g, '\n').replace(/\n/g, '\\n'));
  }

  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        const inner = parsed.trim();
        if (inner.startsWith('{')) {
          const innerParsed: unknown = JSON.parse(inner);
          if (innerParsed && typeof innerParsed === 'object' && !Array.isArray(innerParsed)) {
            return innerParsed as RawServiceAccountJson;
          }
        }
        continue;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as RawServiceAccountJson;
      }
    } catch {
      // Try next normalization candidate
    }
  }
  return null;
}

function parseServiceAccountKeyDetailed(rawValue: string | undefined): {
  serviceAccount: ServiceAccount | null;
  diagnostic: FirebaseAdminDiagnosticCode;
} {
  if (!rawValue || rawValue.trim() === '') {
    return { serviceAccount: null, diagnostic: 'missing_credentials' };
  }

  const trimmed = rawValue.trim();
  const unquoted = stripOuterQuotes(trimmed);
  const candidates: string[] = [];

  if (trimmed.startsWith('{')) {
    candidates.push(trimmed);
  }
  if (unquoted !== trimmed && unquoted.startsWith('{')) {
    candidates.push(unquoted);
  }
  if (unquoted.includes('\\"') && unquoted.startsWith('{')) {
    candidates.push(unquoted.replace(/\\"/g, '"'));
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    candidates.push(trimmed);
  }

  // Try base64 decoding (tolerating whitespace/newlines wrapped by secret managers)
  const compactB64 = unquoted.replace(/\s+/g, '');
  if (compactB64.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(compactB64)) {
    try {
      const normalizedB64 = compactB64.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalizedB64, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) {
        candidates.push(decoded);
      }
    } catch {
      // Ignore base64 decode errors
    }
  }

  let parsed: RawServiceAccountJson | null = null;
  for (const candidate of candidates) {
    parsed = tryParseJsonObject(candidate);
    if (parsed) break;
  }

  if (!parsed) {
    return { serviceAccount: null, diagnostic: 'invalid_json_or_base64' };
  }

  const projectId = (parsed.project_id || parsed.projectId || '').trim();
  const clientEmail = (parsed.client_email || parsed.clientEmail || '').trim();
  const rawPrivateKey = parsed.private_key || parsed.privateKey || '';
  const privateKey = normalizePrivateKeyPem(rawPrivateKey);

  if (!projectId || !clientEmail || !privateKey) {
    return { serviceAccount: null, diagnostic: 'missing_required_fields' };
  }

  if (!isValidPemPrivateKey(privateKey)) {
    return { serviceAccount: null, diagnostic: 'invalid_private_key_format' };
  }

  return {
    serviceAccount: {
      projectId,
      clientEmail,
      privateKey,
    },
    diagnostic: 'configured',
  };
}

/**
 * Parses FIREBASE_SERVICE_ACCOUNT_KEY from raw JSON, quoted JSON, or base64-encoded JSON,
 * normalizing escaped `\\n` sequences in `private_key` for Vercel / env vars.
 * Never throws secrets into error messages.
 */
export function parseServiceAccountKey(rawValue: string | undefined): ServiceAccount | null {
  return parseServiceAccountKeyDetailed(rawValue).serviceAccount;
}

export function resolveFirebaseAdminCredentials(
  env: NodeJS.ProcessEnv = process.env
): {
  serviceAccount: ServiceAccount | null;
  source: FirebaseAdminCredentialSource;
  diagnostic: FirebaseAdminDiagnosticCode;
  projectId: string;
  databaseId: string;
} {
  const configuredProjectId = (
    env.FIREBASE_PROJECT_ID ||
    env.VITE_FIREBASE_PROJECT_ID ||
    FIREBASE_PROJECT_ID
  ).trim();
  const databaseId = (
    env.FIREBASE_FIRESTORE_DATABASE_ID ||
    env.VITE_FIREBASE_FIRESTORE_DATABASE_ID ||
    FIREBASE_DATABASE_ID
  ).trim();

  // 1. Prefer FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON or base64 JSON)
  const rawKey = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (rawKey && rawKey.trim() !== '') {
    const detailed = parseServiceAccountKeyDetailed(rawKey);
    if (!detailed.serviceAccount) {
      return {
        serviceAccount: null,
        source: 'service_account_json',
        diagnostic: detailed.diagnostic,
        projectId: configuredProjectId,
        databaseId,
      };
    }
    if (
      detailed.serviceAccount.projectId &&
      detailed.serviceAccount.projectId !== configuredProjectId
    ) {
      return {
        serviceAccount: null,
        source: 'service_account_json',
        diagnostic: 'project_id_mismatch',
        projectId: configuredProjectId,
        databaseId,
      };
    }
    return {
      serviceAccount: detailed.serviceAccount,
      source: 'service_account_json',
      diagnostic: 'configured',
      projectId: configuredProjectId,
      databaseId,
    };
  }

  // 2. Fallback: split Vercel environment variables (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
  const rawEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const rawPrivateKey = (env.FIREBASE_PRIVATE_KEY || '').trim();
  if (rawEmail || rawPrivateKey) {
    if (!rawEmail || !rawPrivateKey) {
      return {
        serviceAccount: null,
        source: 'split_env_vars',
        diagnostic: 'missing_required_fields',
        projectId: configuredProjectId,
        databaseId,
      };
    }
    const privateKey = normalizePrivateKeyPem(rawPrivateKey);
    if (!isValidPemPrivateKey(privateKey)) {
      return {
        serviceAccount: null,
        source: 'split_env_vars',
        diagnostic: 'invalid_private_key_format',
        projectId: configuredProjectId,
        databaseId,
      };
    }
    return {
      serviceAccount: {
        projectId: configuredProjectId,
        clientEmail: stripOuterQuotes(rawEmail),
        privateKey,
      },
      source: 'split_env_vars',
      diagnostic: 'configured',
      projectId: configuredProjectId,
      databaseId,
    };
  }

  return {
    serviceAccount: null,
    source: 'none',
    diagnostic: 'missing_credentials',
    projectId: configuredProjectId,
    databaseId,
  };
}

export function getFirebaseAdminConfigDiagnostics(
  env: NodeJS.ProcessEnv = process.env
): FirebaseAdminConfigDiagnostics {
  const resolved = resolveFirebaseAdminCredentials(env);
  return {
    configured: resolved.serviceAccount !== null,
    source: resolved.source,
    diagnostic: resolved.diagnostic,
    projectId: resolved.projectId,
    databaseId: resolved.databaseId,
  };
}

export function isFirebaseAdminConfigured(): boolean {
  return resolveFirebaseAdminCredentials(process.env).serviceAccount !== null;
}

const ADMIN_APP_NAME = 'adeybingo-admin';

/**
 * Returns the singleton Firebase Admin App bound to project `gen-lang-client-0559010770`.
 * Safe across Vercel serverless warm invocations (never initializes multiple times).
 */
export function getFirebaseAdminApp(): App {
  const existing = getApps().find((a) => a.name === ADMIN_APP_NAME);
  if (existing) {
    return existing;
  }

  const resolved = resolveFirebaseAdminCredentials(process.env);
  if (!resolved.serviceAccount) {
    if (resolved.diagnostic === 'project_id_mismatch') {
      throw new Error(
        `Service account project_id mismatch: expected ${resolved.projectId}.`
      );
    }
    throw new Error(
      `Firebase Admin credentials are missing or invalid (${resolved.diagnostic}). Configure FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.`
    );
  }

  return initializeApp(
    {
      credential: cert(resolved.serviceAccount),
      projectId: resolved.projectId,
    },
    ADMIN_APP_NAME
  );
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

/**
 * Returns the singleton Firestore instance bound to the named ADEYBINGO database:
 * `ai-studio-adeybingotelegra-e167ea3c-c285-4e91-8373-d40b1718c6cc`.
 */
export function getAdminDb(): Firestore {
  const databaseId = (
    process.env.FIREBASE_FIRESTORE_DATABASE_ID ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID ||
    FIREBASE_DATABASE_ID
  ).trim();
  return getFirestore(getFirebaseAdminApp(), databaseId);
}

/**
 * Safe, read-only Firestore connectivity check against the named database.
 * Performs a bounded limit(1) read on `rooms` without mutating data or leaking credentials.
 */
export async function checkFirestoreConnectivity(options: {
  getDb?: () => Firestore;
  timeoutMs?: number;
} = {}): Promise<FirestoreHealthCheckResult> {
  const diagnostics = getFirebaseAdminConfigDiagnostics(process.env);
  const databaseId = diagnostics.databaseId;

  if (!options.getDb && !diagnostics.configured) {
    return {
      reachable: false,
      status: 'unconfigured',
      databaseId,
      errorCode: diagnostics.diagnostic,
    };
  }

  const timeoutMs = Math.max(500, Math.min(8000, options.timeoutMs ?? 4000));
  const startedAt = Date.now();

  try {
    const db = options.getDb ? options.getDb() : getAdminDb();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        db.collection('rooms').limit(1).get(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('firestore_health_timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      reachable: true,
      status: 'ok',
      databaseId,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (err) {
    const rawCode =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : '';
    const msg = err instanceof Error ? err.message : '';
    let errorCode = 'firestore_read_failed';
    if (msg === 'firestore_health_timeout') {
      errorCode = 'timeout';
    } else if (rawCode === '7' || msg.includes('PERMISSION_DENIED')) {
      errorCode = 'permission_denied';
    } else if (rawCode === '5' || msg.includes('NOT_FOUND')) {
      errorCode = 'database_not_found';
    } else if (rawCode === '16' || msg.includes('UNAUTHENTICATED') || msg.includes('invalid_grant')) {
      errorCode = 'invalid_credentials';
    } else if (rawCode === '14' || msg.includes('UNAVAILABLE')) {
      errorCode = 'service_unavailable';
    }
    return {
      reachable: false,
      status: 'error',
      databaseId,
      latencyMs: Math.max(0, Date.now() - startedAt),
      errorCode,
    };
  }
}

/**
 * Deterministic Firebase Auth UID for a verified Telegram user.
 */
export function getTelegramFirebaseUid(telegramUserId: number): string {
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
    throw new RangeError('telegramUserId must be a positive integer.');
  }
  return `tg_${telegramUserId}`;
}

/**
 * Mints a Firebase Custom Authentication Token for a server-verified Telegram user,
 * embedding `telegram_verified: true` in custom claims for Firestore Security Rules.
 */
export async function createTelegramCustomToken(params: {
  telegramUserId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}): Promise<{ uid: string; customToken: string }> {
  const uid = getTelegramFirebaseUid(params.telegramUserId);
  const auth = getAdminAuth();
  const customToken = await auth.createCustomToken(uid, {
    telegram_verified: true,
    telegram_id: params.telegramUserId,
    provider: 'telegram',
  });
  return { uid, customToken };
}
