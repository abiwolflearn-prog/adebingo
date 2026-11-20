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

/**
 * Parses FIREBASE_SERVICE_ACCOUNT_KEY from either raw JSON or base64-encoded JSON,
 * normalizing escaped `\\n` sequences in `private_key` for Vercel / env vars.
 * Never throws secrets into error messages.
 */
export function parseServiceAccountKey(rawValue: string | undefined): ServiceAccount | null {
  if (!rawValue || rawValue.trim() === '') {
    return null;
  }

  let jsonText = rawValue.trim();
  if (!jsonText.startsWith('{')) {
    try {
      const decoded = Buffer.from(jsonText, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) {
        jsonText = decoded;
      }
    } catch {
      return null;
    }
  }

  let parsed: RawServiceAccountJson;
  try {
    parsed = JSON.parse(jsonText) as RawServiceAccountJson;
  } catch {
    return null;
  }

  const projectId = (parsed.project_id || parsed.projectId || '').trim();
  const clientEmail = (parsed.client_email || parsed.clientEmail || '').trim();
  const rawPrivateKey = parsed.private_key || parsed.privateKey || '';
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n').trim();

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

export function isFirebaseAdminConfigured(): boolean {
  return parseServiceAccountKey(process.env.FIREBASE_SERVICE_ACCOUNT_KEY) !== null;
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

  const serviceAccount = parseServiceAccountKey(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  if (!serviceAccount) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY is missing or invalid in server environment variables.'
    );
  }

  const configuredProjectId = process.env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID;
  if (serviceAccount.projectId && serviceAccount.projectId !== configuredProjectId) {
    throw new Error(
      `Service account project_id mismatch: expected ${configuredProjectId}.`
    );
  }

  return initializeApp(
    {
      credential: cert(serviceAccount),
      projectId: configuredProjectId,
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
  const databaseId = process.env.FIREBASE_FIRESTORE_DATABASE_ID || FIREBASE_DATABASE_ID;
  return getFirestore(getFirebaseAdminApp(), databaseId);
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
