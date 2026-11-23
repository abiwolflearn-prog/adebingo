import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { cert, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import {
  checkFirestoreConnectivity,
  getFirebaseAdminConfigDiagnostics,
  resolveFirebaseAdminCredentials,
} from './api/_lib/firebaseAdmin.ts';
import {
  defaultReplayGuard,
  hasValidTelegramBotTokenFormat,
  validateTelegramWebAppInitData,
} from './src/utils/telegramVerify.ts';
import {
  AdeyBingoTelegramBotEngine,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  isDisallowedMiniAppPreviewUrl,
  normalizeWebhookSecretForTelegram,
  sanitizeProductionMiniAppUrl,
  ServerGameAuthority,
  verifyWebhookSecretHeader,
} from './src/utils/telegramBot.ts';
import type { NotificationEventType } from './src/utils/telegramBot.ts';
import {
  defaultMenuButtonConfigurator,
  fetchCurrentChatMenuButton,
  sanitizeTelegramApiError,
} from './src/utils/telegramMenuButton.ts';
import { getBingoVoiceCallScript } from './src/utils/amharicNumbers.ts';
import {
  calculateAuthoritativeGameFinancials,
  resolveGameLifecycleStage,
} from './src/game/rules.ts';
import {
  evaluateRoundWinners,
  type RoomCardOwnerEntry,
  type RoundWinnerShare,
} from './src/game/roundSettlement.ts';
import {
  authorizeAdminRequest,
  mintServerSessionToken,
  ServerAdminAuthority,
} from './src/utils/adminAuthority.ts';
import type {
  DepositRequestStatus,
  PayoutOrderStatus,
  VerifiedSessionActor,
} from './src/utils/adminAuthority.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const firebaseProjectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.VITE_FIREBASE_PROJECT_ID ||
  'gen-lang-client-0559010770';

function getOrInitFirebaseAdminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];

  const resolved = resolveFirebaseAdminCredentials(process.env);
  if (resolved.serviceAccount) {
    return initializeAdminApp({
      credential: cert(resolved.serviceAccount),
      projectId: resolved.projectId || firebaseProjectId,
    });
  }

  return initializeAdminApp({ projectId: firebaseProjectId });
}

async function mintFirebaseCustomTokenForTelegramUser(
  uid: string,
  telegramUserId: number,
  username: string
): Promise<{ customToken: string | null; customTokenStatus: string }> {
  try {
    const adminApp = getOrInitFirebaseAdminApp();
    const customToken = await getAdminAuth(adminApp).createCustomToken(uid, {
      telegram_verified: true,
      telegram_id: telegramUserId,
      telegramUserId,
      username,
      provider: 'telegram_mini_app',
    });
    return { customToken, customTokenStatus: 'minted' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('signBlob') || msg.includes('insufficient-permission')) {
      return {
        customToken: null,
        customTokenStatus: 'iam_sign_blob_role_needed_for_custom_token',
      };
    }
    return { customToken: null, customTokenStatus: 'custom_token_unavailable' };
  }
}

function buildSignedTelegramInitDataOnBackend(
  botToken: string,
  scenario: 'valid' | 'expired' | 'tampered' = 'valid'
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const authDate = scenario === 'expired' ? nowSec - 90000 : nowSec;
  const userJson = JSON.stringify({
    id: 8842109,
    first_name: 'Abebe',
    last_name: 'Bikila',
    username: 'abebe_adey',
    language_code: 'am',
  });

  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `AAHdF6IQAAAAAN0XohD_${authDate}`);
  params.set('user', userJson);

  const entries: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    entries.push([k, v]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  let hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (scenario === 'tampered') {
    hash = `${hash.slice(0, -4)}dead`;
  }

  params.set('hash', hash);
  return params.toString();
}

async function startServer() {
  const app = express();
  const portArgIndex = process.argv.indexOf('--port');
  const cliPort =
    portArgIndex !== -1 && process.argv[portArgIndex + 1]
      ? Number(process.argv[portArgIndex + 1])
      : undefined;
  const PORT =
    cliPort && Number.isFinite(cliPort)
      ? cliPort
      : process.env.NODE_ENV === 'production'
        ? Number(process.env.PORT) || 3000
        : 3000;

  // Never use any Google AI Studio preview/dev URL (ais-dev-*, ais-pre-*, *.run.app) for Telegram Mini App launch,
  // because *.run.app preview URLs redirect unauthenticated Telegram WebView users to a Google verification page.
  const rawAppUrl = (process.env.PUBLIC_MINI_APP_URL || process.env.APP_URL || '').trim();
  const miniAppUrl = sanitizeProductionMiniAppUrl(
    !isDisallowedMiniAppPreviewUrl(rawAppUrl) ? rawAppUrl : DEFAULT_DEPLOYED_MINI_APP_URL
  ).replace(/\/+$/, '');
  const miniAppLaunchUrl = `${miniAppUrl}/`;

  const botEngine = new AdeyBingoTelegramBotEngine(miniAppLaunchUrl);
  const gameAuthority = new ServerGameAuthority();
  const adminAuthority = new ServerAdminAuthority(botEngine);

  // Seed default demo player profile in bot engine so outbox & profile queries work out of the box
  botEngine.handleIncomingUpdate({
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    lastName: 'Bikila',
    username: 'abebe_adey',
    firebaseUid: 'tg_8842109',
    text: '/start',
  });

  app.use(express.json({ limit: '64kb' }));

  const resolveConfiguredBotToken = (): string | undefined => {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    return hasValidTelegramBotTokenFormat(envToken) ? envToken : undefined;
  };

  const resolveAdminSessionSecret = (): string => {
    const raw = (
      process.env.ADEY_ADMIN_SESSION_SECRET ||
      process.env.TELEGRAM_WEBHOOK_SECRET ||
      process.env.TELEGRAM_BOT_TOKEN ||
      ''
    ).trim();
    if (raw && raw.length >= 8 && raw !== 'MY_TELEGRAM_WEBHOOK_SECRET') {
      return raw.startsWith('adeybingo_admin_session_secret_')
        ? raw
        : `adeybingo_admin_session_secret_${raw}`;
    }
    return 'adeybingo_server_admin_session_hmac_secret_v1';
  };

  // 1. Trusted Backend Status Endpoint (Honest reporting — never exposes or logs secrets)
  app.get('/api/backend/status', async (_req, res) => {
    const hasBotToken = Boolean(resolveConfiguredBotToken());
    const hasWebhookSecret = Boolean(
      process.env.TELEGRAM_WEBHOOK_SECRET &&
        process.env.TELEGRAM_WEBHOOK_SECRET.trim().length >= 8 &&
        process.env.TELEGRAM_WEBHOOK_SECRET !== 'MY_TELEGRAM_WEBHOOK_SECRET'
    );
    const adminDiag = getFirebaseAdminConfigDiagnostics(process.env);
    const firestoreHealth = await checkFirestoreConnectivity();
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      firebaseProjectId: adminDiag.projectId,
      firestoreDatabaseId: adminDiag.databaseId,
      firebaseAdminConfigured: adminDiag.configured,
      firebaseAdminCredentialSource: adminDiag.source,
      firebaseAdminDiagnostic: adminDiag.diagnostic,
      firestoreHealth,
      telegramBotTokenConfigured: hasBotToken,
      telegramWebhookSecretConfigured: hasWebhookSecret,
      miniAppUrl,
      webhookEndpointUrl: `${miniAppUrl}/api/telegram/webhook`,
      authProvider: 'telegram_init_data_hmac_sha256',
      googleSignInEnabled: false,
      mode: 'demo_sandbox',
    });
  });

  // 2. Trusted Backend Telegram Mini App Authentication & Custom Token Endpoint
  const handleTelegramInitDataAuth: express.RequestHandler = async (req, res) => {
    if (
      req.body?.telegramId !== undefined ||
      req.body?.telegramUserId !== undefined ||
      req.body?.uid !== undefined ||
      req.body?.firebaseUid !== undefined ||
      req.body?.isAdmin !== undefined ||
      req.body?.demoBalanceEtb !== undefined ||
      req.body?.customToken !== undefined ||
      req.body?.initDataUnsafe !== undefined ||
      req.body?.user !== undefined
    ) {
      res.status(400).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: 400,
        error: 'client_identity_override_rejected',
        reason: 'client_identity_override_rejected',
        message: 'Caller-supplied Telegram IDs, initDataUnsafe, or privilege fields are not accepted.',
        diagnostics: {
          failureCategory: 'frontend_request_formatting',
        },
      });
      return;
    }

    const allowEnvelope = Boolean(req.body?.envelope);
    if (req.body?.initData !== undefined && typeof req.body.initData !== 'string') {
      console.warn('[server/telegram-auth] rejected non-string initData payload', {
        receivedType: typeof req.body.initData,
      });
      res.status(allowEnvelope ? 200 : 400).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: 400,
        reason: 'malformed_init_data',
        message: 'Telegram initData must be sent as the raw query string from window.Telegram.WebApp.initData.',
        diagnostics: {
          failureCategory: 'frontend_request_formatting',
          botTokenConfigured: Boolean(resolveConfiguredBotToken()),
          initDataPresent: true,
        },
      });
      return;
    }

    const rawInitData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const expectedTelegramUserId =
      typeof req.body?.expectedTelegramUserId === 'number'
        ? req.body.expectedTelegramUserId
        : undefined;
    const actionNonce =
      typeof req.body?.actionNonce === 'string' ? req.body.actionNonce : undefined;
    const botToken = resolveConfiguredBotToken();

    if (!rawInitData.trim()) {
      res.status(allowEnvelope ? 200 : 400).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: 400,
        reason: 'missing_init_data',
        message: 'No Telegram WebApp initData was provided. Please open ADEYBINGO inside Telegram.',
        diagnostics: {
          failureCategory: 'missing_init_data',
          botTokenConfigured: Boolean(botToken),
          initDataPresent: false,
        },
      });
      return;
    }

    if (!botToken) {
      console.warn('[server/telegram-auth] missing or invalid TELEGRAM_BOT_TOKEN in server environment');
      res.status(allowEnvelope ? 200 : 503).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: 503,
        reason: 'missing_bot_token',
        message: 'TELEGRAM_BOT_TOKEN is not configured on the server environment.',
        diagnostics: {
          failureCategory: 'backend_environment_configuration',
          botTokenConfigured: false,
          botTokenFormatValid: false,
          initDataPresent: true,
          initDataLength: rawInitData.trim().length,
        },
      });
      return;
    }

    const result = validateTelegramWebAppInitData(rawInitData, botToken, {
      maxAgeSeconds: 86400,
      expectedTelegramUserId,
      replayGuard: actionNonce ? defaultReplayGuard : undefined,
      actionNonce,
    });

    if (!result.valid || !result.telegramUser) {
      console.warn('[server/telegram-auth] initData verification failed', {
        reason: result.reason,
        diagnostics: result.diagnostics,
      });
      const code =
        result.reason === 'missing_bot_token'
          ? 503
          : result.reason === 'replay_detected'
            ? 409
            : result.reason === 'malformed_init_data' ||
                result.reason === 'missing_hash' ||
                result.reason === 'missing_init_data'
              ? 400
              : 401;
      res.status(allowEnvelope ? 200 : code).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: code,
        reason: result.reason,
        message:
          result.reason === 'missing_bot_token'
            ? 'TELEGRAM_BOT_TOKEN is not configured on the server environment.'
            : result.reason === 'missing_init_data'
              ? 'No Telegram WebApp initData was provided. Please open ADEYBINGO inside Telegram.'
              : result.reason === 'replay_detected'
                ? 'Duplicate/replayed Telegram initData request blocked.'
                : result.reason === 'missing_hash'
                  ? 'Telegram initData is missing its cryptographic hash parameter.'
                  : result.reason === 'malformed_init_data'
                    ? 'Telegram initData query string is malformed or incorrectly formatted.'
                    : result.reason === 'future_auth_date' || result.reason === 'expired_auth_date'
                      ? 'Telegram initData auth_date is expired or invalid. Please relaunch from the Telegram bot.'
                      : 'Telegram initData cryptographic HMAC-SHA256 signature validation failed.',
        diagnostics: result.diagnostics,
      });
      return;
    }

    const tgUser = result.telegramUser;
    const uid = `tg_${tgUser.id}`;

    // Ensure player profile exists in backend bot registry bound to uid with authoritative initial balance (15 ETB)
    let playerProfile = botEngine.getPlayerByTelegramId(tgUser.id);
    if (!playerProfile) {
      playerProfile = ensureServerPlayerWithWelcomeBonus({
        uid,
        telegramUserId: tgUser.id,
        displayName: `${tgUser.first_name || 'Player'} ${tgUser.last_name || ''}`.trim(),
        username: tgUser.username || `tg_${tgUser.id}`,
      });
    }

    // Auto-apply cryptographically signed start_param (or safe ADEY-* referral code) atomically on authentication
    const candidateStartParam =
      result.startParam ||
      (typeof req.body?.startParam === 'string' && /^ADEY-[1-9]\d*$/i.test(req.body.startParam.trim())
        ? req.body.startParam.trim().toUpperCase()
        : undefined);
    let referralApplied:
      | {
          applied: boolean;
          reason?: string;
          code: string;
          inviterTelegramId?: number;
          inviterBonusEtb?: number;
          inviteeBonusEtb?: number;
        }
      | undefined;

    if (candidateStartParam && /^ADEY-[1-9]\d*$/i.test(candidateStartParam)) {
      const refOutcome = applyServerReferralAtomic(
        {
          uid,
          telegramUserId: tgUser.id,
          displayName: playerProfile
            ? `${playerProfile.firstName} ${playerProfile.lastName || ''}`.trim()
            : `${tgUser.first_name || 'Adey'} ${tgUser.last_name || ''}`.trim(),
          username: playerProfile?.username || tgUser.username || `tg_${tgUser.id}`,
        },
        candidateStartParam.toUpperCase()
      );
      referralApplied = {
        applied: refOutcome.ok,
        reason: refOutcome.ok ? undefined : refOutcome.error,
        code: candidateStartParam.toUpperCase(),
        inviterTelegramId: refOutcome.inviterTelegramId,
        inviterBonusEtb: refOutcome.inviterBonusEtb,
        inviteeBonusEtb: refOutcome.inviteeBonusEtb,
      };
    }

    // Mint Firebase Custom Token using Firebase Admin SDK
    const { customToken, customTokenStatus } = await mintFirebaseCustomTokenForTelegramUser(
      uid,
      tgUser.id,
      tgUser.username || `tg_${tgUser.id}`
    );

    const mintedSession = mintServerSessionToken(
      {
        uid,
        telegramUserId: tgUser.id,
        displayName: playerProfile
          ? `${playerProfile.firstName} ${playerProfile.lastName || ''}`.trim()
          : `${tgUser.first_name || 'Adey'} ${tgUser.last_name || ''}`.trim(),
        username: playerProfile?.username || tgUser.username || `tg_${tgUser.id}`,
      },
      resolveAdminSessionSecret()
    );

    persistLocalStateSnapshot();

    const verifiedRole = mintedSession.actor.role;

    res.json({
      ok: true,
      authenticated: true,
      verified: true,
      statusCode: 200,
      uid,
      verifiedTelegramId: tgUser.id,
      role: verifiedRole,
      isAdmin: verifiedRole === 'admin',
      customToken,
      customTokenStatus,
      sessionToken: mintedSession.token,
      ...(referralApplied ? { referralApplied } : {}),
      telegramUser: tgUser,
      profile: playerProfile
        ? {
            uid: playerProfile.uid,
            telegramUserId: playerProfile.telegramUserId,
            firstName: playerProfile.firstName,
            lastName: playerProfile.lastName,
            username: playerProfile.username,
            language: playerProfile.language,
            phoneVerified: playerProfile.phoneVerified,
            verifiedPhoneMasked: playerProfile.verifiedPhoneMasked,
            demoBalanceEtb: playerProfile.demoBalanceEtb,
            referralCode: playerProfile.referralCode,
            role: verifiedRole,
          }
        : undefined,
      authDate: result.authDate,
      dataCheckHash: result.dataCheckHash,
    });
  };

  app.post('/api/telegram/auth', handleTelegramInitDataAuth);
  app.post('/api/telegram/validate-init-data', handleTelegramInitDataAuth);

  // 2B. Backend Test initData Generator (Dev/Test only — requires configured TELEGRAM_BOT_TOKEN)
  app.post('/api/telegram/test-init-data', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({
        ok: false,
        reason: 'disabled_in_production',
        message: 'Synthetic test initData generation is disabled in production.',
      });
      return;
    }
    const botToken = resolveConfiguredBotToken();
    if (!botToken) {
      res.status(503).json({
        ok: false,
        reason: 'missing_bot_token',
        message: 'TELEGRAM_BOT_TOKEN is not configured on the server environment.',
      });
      return;
    }
    const rawScenario = req.body?.scenario;
    const scenario: 'valid' | 'expired' | 'tampered' =
      rawScenario === 'expired' || rawScenario === 'tampered' ? rawScenario : 'valid';
    const initData = buildSignedTelegramInitDataOnBackend(botToken, scenario);

    res.json({
      ok: true,
      scenario,
      initData,
    });
  });

  // 3. Telegram Bot API Webhook Endpoint (Standard Telegram Update format)
  app.post('/api/telegram/webhook', async (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!verifyWebhookSecretHeader(secretHeader, expectedSecret)) {
      res.status(401).json({ ok: false, reason: 'invalid_webhook_secret_token' });
      return;
    }

    const update = req.body || {};
    const updateId =
      typeof update.update_id === 'number'
        ? update.update_id
        : typeof update.updateId === 'number'
        ? update.updateId
        : undefined;
    const message = update.message || update.callback_query?.message || {};
    const from = update.message?.from || update.callback_query?.from || {};
    const senderTelegramId = Number(
      from.id || message.chat?.id || update.senderTelegramId || 8842109
    );
    const callbackQueryId =
      typeof update.callback_query?.id === 'string'
        ? update.callback_query.id
        : typeof update.callbackQueryId === 'string'
        ? update.callbackQueryId
        : undefined;

    const botResponse = botEngine.handleIncomingUpdate({
      updateId,
      callbackQueryId,
      senderTelegramId,
      firstName: from.first_name || update.firstName || 'Player',
      lastName: from.last_name || update.lastName || '',
      username: from.username || update.username || `tg_${senderTelegramId}`,
      text:
        typeof update.message?.text === 'string'
          ? update.message.text
          : typeof update.text === 'string'
          ? update.text
          : '',
      callbackData:
        typeof update.callback_query?.data === 'string'
          ? update.callback_query.data
          : typeof update.callbackData === 'string'
          ? update.callbackData
          : '',
      contact: update.message?.contact || update.contact || null,
    });

    // Deliver response to live Telegram chat unless explicitly marked as local simulation (simulateOnly: true)
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    let deliveredToTelegramApi = false;
    let telegramDeliveryNote: string | undefined;
    if (
      botToken &&
      botToken.trim().length > 10 &&
      botToken !== 'MY_TELEGRAM_BOT_TOKEN' &&
      update.simulateOnly !== true
    ) {
      try {
        if (update.callback_query?.id) {
          await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: update.callback_query.id,
              ...(botResponse.callbackAnswerText
                ? { text: botResponse.callbackAnswerText }
                : {}),
            }),
          });
        }

        const rawMarkup = botResponse.replyMarkup;
        const telegramReplyMarkup = rawMarkup?.inline_keyboard?.length
          ? { inline_keyboard: rawMarkup.inline_keyboard }
          : rawMarkup?.keyboard?.length
            ? {
                keyboard: rawMarkup.keyboard,
                resize_keyboard: rawMarkup.resize_keyboard ?? true,
                one_time_keyboard: rawMarkup.one_time_keyboard ?? false,
              }
            : undefined;

        const tgResp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: botResponse.chatId,
            text: botResponse.text,
            parse_mode: botResponse.parseMode,
            ...(telegramReplyMarkup ? { reply_markup: telegramReplyMarkup } : {}),
          }),
        });
        const tgData = await tgResp.json().catch(() => ({}));
        deliveredToTelegramApi = Boolean(tgResp.ok && tgData.ok);
        telegramDeliveryNote = tgData.description || (deliveredToTelegramApi ? 'delivered' : 'send_failed');
      } catch {
        deliveredToTelegramApi = false;
        telegramDeliveryNote = 'network_error';
      }
    }

    // Never return raw or internal player profile state in the public webhook HTTP response
    res.json({
      ok: botResponse.ok,
      chatId: botResponse.chatId,
      language: botResponse.language,
      text: botResponse.text,
      parseMode: botResponse.parseMode,
      replyMarkup: botResponse.replyMarkup,
      registrationStatus: botResponse.registrationStatus,
      securityCode: botResponse.securityCode,
      ...(botResponse.callbackAnswerText
        ? { callbackAnswerText: botResponse.callbackAnswerText }
        : {}),
      deliveredToTelegramApi,
      telegramDeliveryNote,
    });
  });

  // 3B. Register & Verify Live Telegram Webhook from Backend (Admin protected — never exposes secrets)
  app.post('/api/telegram/register-webhook', async (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!verifyWebhookSecretHeader(secretHeader, expectedSecret)) {
      res.status(401).json({ ok: false, reason: 'invalid_webhook_secret_token' });
      return;
    }

    const botToken = resolveConfiguredBotToken();
    const rawWebhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

    if (!botToken) {
      res.status(503).json({
        ok: false,
        reason: 'missing_bot_token',
        message: 'TELEGRAM_BOT_TOKEN is not configured in server environment.',
      });
      return;
    }
    if (!rawWebhookSecret || rawWebhookSecret === 'MY_TELEGRAM_WEBHOOK_SECRET') {
      res.status(503).json({
        ok: false,
        reason: 'missing_webhook_secret',
        message: 'TELEGRAM_WEBHOOK_SECRET is not configured in server environment.',
      });
      return;
    }

    const candidateUrl = req.body?.baseUrl || req.body?.publicBaseUrl;
    if (
      typeof candidateUrl === 'string' &&
      candidateUrl.trim() &&
      isDisallowedMiniAppPreviewUrl(candidateUrl)
    ) {
      res.status(400).json({
        ok: false,
        reason: 'invalid_public_base_url',
        message:
          'baseUrl must be a public production HTTPS URL (Google AI Studio preview URLs cannot be used for Telegram Mini Apps).',
      });
      return;
    }
    const requestedBaseUrl =
      typeof candidateUrl === 'string' &&
      candidateUrl.trim() &&
      !isDisallowedMiniAppPreviewUrl(candidateUrl)
        ? candidateUrl.trim().replace(/\/+$/, '')
        : miniAppUrl;
    const requestedLaunchUrl = `${requestedBaseUrl}/`;
    const webhookUrl = `${requestedBaseUrl}/api/telegram/webhook`;
    const normalizedSecret = normalizeWebhookSecretForTelegram(rawWebhookSecret);

    try {
      // Step 1: Verify bot identity via getMe
      const getMeResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const getMeData = await getMeResp.json();
      if (!getMeResp.ok || !getMeData.ok) {
        res.status(400).json({
          ok: false,
          reason: 'telegram_get_me_failed',
          description: getMeData.description || 'Failed to authenticate bot token with Telegram API.',
        });
        return;
      }

      // Step 2: Register bot commands (/start, /help, /language, /support, /terms)
      const setCommandsResp = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'start', description: 'ቦቱን ይጀምሩ እና ዋና ሜኑን ይክፈቱ (Start ADEYBINGO)' },
            { command: 'wallet', description: 'የእኔ ቦርሳ እና ቀሪ ሂሳብ (My Wallet)' },
            { command: 'deposit', description: 'ገንዘብ ያስገቡ (Demo Deposit)' },
            { command: 'withdraw', description: 'ገንዘብ ያውጡ (Demo Withdraw)' },
            { command: 'invite', description: 'ጓደኞችን ይጋብዙ (Invite Friends)' },
            { command: 'leaderboard', description: 'የደረጃ ሰንጠረዥ (Leaderboard)' },
            { command: 'history', description: 'የጨዋታ ታሪክ (Game History)' },
            { command: 'profile', description: 'የእኔ መገለጫ (My Profile)' },
            { command: 'language', description: 'ቋንቋ ይምረጡ / Select Language (አማርኛ / English)' },
            { command: 'support', description: 'እገዛ እና የደንበኞች ድጋፍ (Support)' },
            { command: 'help', description: 'የጨዋታ መመሪያ (Help & Guide)' },
            { command: 'terms', description: 'ህጎች እና የግላዊነት ጥበቃ (Terms & Privacy)' },
          ],
        }),
      });
      const setCommandsData = await setCommandsResp.json();

      // Step 3: Set Chat Menu Button to launch the deployed Mini App (https://adebingo-3nta.vercel.app/)
      const menuButtonResult = await defaultMenuButtonConfigurator.configure({
        botToken,
        miniAppUrl: requestedLaunchUrl,
        force: true,
        checkExistingFirst: false,
        verifyAfterSet: true,
      });

      // Step 4: Register Webhook with normalized secret_token
      const setWebhookResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: normalizedSecret,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false,
        }),
      });
      const setWebhookData = await setWebhookResp.json();

      // Step 5: Verify registration via getWebhookInfo
      const infoResp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
      const infoData = await infoResp.json();

      res.json({
        ok: Boolean(setWebhookData.ok && infoData.ok),
        botProfile: {
          id: getMeData.result?.id,
          firstName: getMeData.result?.first_name,
          username: getMeData.result?.username,
          canJoinGroups: getMeData.result?.can_join_groups,
        },
        commandsRegistered: Boolean(setCommandsData.ok),
        menuButtonConfigured: Boolean(menuButtonResult.ok && menuButtonResult.configured),
        menuButton: menuButtonResult.verifiedMenuButton || menuButtonResult.menuButton,
        menuButtonStatus: menuButtonResult,
        webhookSet: {
          ok: Boolean(setWebhookData.ok),
          description: setWebhookData.description,
          webhookUrl,
          secretTokenConfigured: true,
        },
        webhookInfo: infoData.result || null,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        reason: 'telegram_api_network_error',
        message: sanitizeTelegramApiError(err),
      });
    }
  });

  // 3C. Live Telegram Webhook Info Endpoint (Admin protected — never exposes secrets)
  app.get('/api/telegram/webhook-info', async (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!verifyWebhookSecretHeader(secretHeader, expectedSecret)) {
      res.status(401).json({ ok: false, reason: 'invalid_webhook_secret_token' });
      return;
    }

    const botToken = resolveConfiguredBotToken();
    const hasWebhookSecret = Boolean(
      process.env.TELEGRAM_WEBHOOK_SECRET &&
        process.env.TELEGRAM_WEBHOOK_SECRET.trim().length >= 8 &&
        process.env.TELEGRAM_WEBHOOK_SECRET !== 'MY_TELEGRAM_WEBHOOK_SECRET'
    );
    if (!botToken) {
      res.json({
        ok: false,
        telegramBotTokenConfigured: false,
        telegramWebhookSecretConfigured: hasWebhookSecret,
      });
      return;
    }

    try {
      const [meResp, infoResp, menuBtnRes] = await Promise.all([
        fetch(`https://api.telegram.org/bot${botToken}/getMe`),
        fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
        fetchCurrentChatMenuButton({ botToken }),
      ]);
      const [meData, infoData] = await Promise.all([meResp.json(), infoResp.json()]);
      res.json({
        ok: Boolean(meData.ok && infoData.ok),
        telegramBotTokenConfigured: true,
        telegramWebhookSecretConfigured: hasWebhookSecret,
        botProfile: meData.ok
          ? {
              id: meData.result?.id,
              firstName: meData.result?.first_name,
              username: meData.result?.username,
            }
          : null,
        webhookInfo: infoData.ok ? infoData.result : null,
        menuButton: menuBtnRes.ok ? menuBtnRes.menuButton : null,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: sanitizeTelegramApiError(err),
      });
    }
  });

  // 3D. Configure & Verify Telegram Bot Default Menu Button (Webhook Secret or Admin Protected)
  app.post('/api/telegram/configure-menu-button', async (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    const webhookSecretConfigured =
      expectedSecret.length >= 8 && expectedSecret !== 'MY_TELEGRAM_WEBHOOK_SECRET';
    const hasValidSecret =
      webhookSecretConfigured && verifyWebhookSecretHeader(secretHeader, expectedSecret);
    if (!hasValidSecret) {
      const adminCheck = extractAdminAuthFromRequest(req);
      if (!adminCheck.authorized) {
        res.status(adminCheck.statusCode || 401).json({
          ok: false,
          error: adminCheck.statusCode === 403 ? 'admin_required' : 'unauthenticated_request',
          message: 'Administrator authorization or valid webhook secret is required.',
        });
        return;
      }
    }

    const botToken = resolveConfiguredBotToken();
    if (!botToken) {
      res.status(503).json({
        ok: false,
        configured: false,
        reason: 'missing_bot_token',
        message: 'TELEGRAM_BOT_TOKEN is not configured in server environment.',
      });
      return;
    }

    const force = req.body?.force === true;
    const result = await defaultMenuButtonConfigurator.configure({
      botToken,
      miniAppUrl: miniAppLaunchUrl,
      force,
      checkExistingFirst: !force,
      verifyAfterSet: true,
    });

    res.status(result.ok ? 200 : 502).json(result);
  });

  // 4. Interactive Bot Command & Contact Verification Endpoint (Authenticated — blocks identity spoofing)
  app.post('/api/telegram/bot-command', (req, res) => {
    const sessionActor = extractPlayerSession(req);
    if (!sessionActor || !sessionActor.telegramUserId) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid authenticated Telegram session token is required.',
      });
      return;
    }

    if (
      req.body?.senderTelegramId !== undefined ||
      req.body?.telegramUserId !== undefined ||
      req.body?.firebaseUid !== undefined ||
      req.body?.uid !== undefined
    ) {
      res.status(403).json({
        ok: false,
        error: 'client_identity_override_rejected',
        message: 'Caller-supplied Telegram or Firebase IDs are forbidden on this endpoint.',
      });
      return;
    }

    const senderTelegramId = sessionActor.telegramUserId;
    const firstName = sessionActor.displayName || 'Player';
    const lastName = '';
    const username = sessionActor.username || `tg_${senderTelegramId}`;
    const firebaseUid = sessionActor.uid;
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 256) : '';
    const callbackData =
      typeof req.body?.callbackData === 'string' ? req.body.callbackData.slice(0, 128) : '';
    const contact = req.body?.contact ?? null;
    const updateId =
      typeof req.body?.updateId === 'number' ? req.body.updateId : undefined;
    const callbackQueryId =
      typeof req.body?.callbackQueryId === 'string' ? req.body.callbackQueryId : undefined;

    const botResponse = botEngine.handleIncomingUpdate({
      updateId,
      callbackQueryId,
      senderTelegramId,
      firstName,
      lastName,
      username,
      firebaseUid,
      text,
      callbackData,
      contact,
    });

    persistLocalStateSnapshot();

    res.json({
      ...botResponse,
      outbox: botEngine
        .getNotificationOutbox()
        .filter((m) => m.telegramUserId === senderTelegramId)
        .slice(0, 12),
    });
  });

  // 5. Secure Notification Preparation & Dispatch Endpoint (Admin or Webhook Secret Required)
  app.post('/api/telegram/notify', (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const hasValidSecret = verifyWebhookSecretHeader(secretHeader, expectedSecret);
    if (!hasValidSecret) {
      const adminCheck = extractAdminAuthFromRequest(req);
      if (!adminCheck.authorized) {
        res.status(adminCheck.statusCode || 401).json({
          ok: false,
          error: adminCheck.statusCode === 403 ? 'admin_required' : 'unauthenticated_request',
          message: 'Administrator authorization or valid webhook secret is required.',
        });
        return;
      }
    }

    const event = req.body?.event as NotificationEventType;
    const allowedEvents: NotificationEventType[] = [
      'registration_success',
      'game_starting',
      'new_bingo_number',
      'game_completion',
      'winner_announcement',
      'referral_confirmation',
      'support_response',
    ];
    if (!allowedEvents.includes(event)) {
      res.status(400).json({ ok: false, reason: 'invalid_notification_event' });
      return;
    }

    const telegramUserId = Number(req.body?.telegramUserId);
    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      res.status(400).json({ ok: false, reason: 'invalid_telegram_user_id' });
      return;
    }
    const payload = typeof req.body?.payload === 'object' && req.body.payload ? req.body.payload : {};
    const notification = botEngine.queueNotification(event, telegramUserId, payload, false);

    res.json({
      ok: true,
      notification,
      outbox: botEngine.getNotificationOutbox().slice(0, 12),
    });
  });

  // 6. Bot Registry & Notification Outbox State Endpoint (Admin protected — prevents public user enumeration)
  app.get('/api/telegram/bot-state', (req, res) => {
    const secretHeader =
      typeof req.headers['x-telegram-bot-api-secret-token'] === 'string'
        ? req.headers['x-telegram-bot-api-secret-token']
        : undefined;
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!verifyWebhookSecretHeader(secretHeader, expectedSecret)) {
      res.status(401).json({ ok: false, reason: 'invalid_webhook_secret_token' });
      return;
    }

    const telegramUserId = Number(req.query.telegramUserId || 8842109);
    const player = botEngine.getPlayerByTelegramId(telegramUserId);
    res.json({
      ok: true,
      miniAppUrl,
      language: botEngine.getLanguage(telegramUserId),
      player,
      outbox: botEngine.getNotificationOutbox().slice(0, 12),
    });
  });

  // 7. Server-Authoritative Number Calling Endpoint (Cryptographic CSPRNG 1..75 — Host/Admin Only)
  app.post('/api/game/draw-ball', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid Bearer token is required to draw Bingo balls.',
      });
      return;
    }
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : 'adey-main';
    const existingGame = localLiveGames.get(roomId);
    const hostUid = existingGame?.hostUid || 'tg_8842109';
    if (actor.role !== 'admin' && actor.uid !== hostUid) {
      res.status(403).json({
        ok: false,
        error: 'unauthorized_caller',
        message: 'Only the room host or administrator may draw Bingo balls.',
      });
      return;
    }

    const cycle = ensureRoomCycle(roomId);
    if (
      cycle.status === 'completed' ||
      cycle.settledRoundNumber === cycle.roundNumber ||
      existingGame?.status === 'completed'
    ) {
      res.status(409).json({
        ok: false,
        reason: 'round_completed',
        message: 'Winner announced — number calling terminated until the next round.',
      });
      return;
    }

    const requestNonce =
      typeof req.body?.requestNonce === 'string' ? req.body.requestNonce : undefined;

    // Never trust client-supplied calledNumbers or callerTelegramId
    const drawResult = gameAuthority.drawNextBallAuthoritative({
      roomId,
      callerTelegramId: actor.telegramUserId,
      requestNonce,
    });

    if (!drawResult.ok || !drawResult.ball) {
      res.status(400).json(drawResult);
      return;
    }

    const currentGame = localLiveGames.get(roomId);
    const updatedCalls = drawResult.calledNumbers || [
      ...(currentGame?.calledNumbers || []),
      drawResult.ball,
    ];
    if (currentGame) {
      currentGame.calledNumbers = updatedCalls;
      currentGame.latestBall = drawResult.ball;
      currentGame.status = 'live';
    } else {
      localLiveGames.set(roomId, {
        gameId: `game_${roomId}_live`,
        roomId,
        hostUid: actor.uid,
        roundNumber: ensureRoomCycle(roomId).roundNumber,
        status: 'live',
        calledNumbers: updatedCalls,
        latestBall: drawResult.ball,
        winnerUid: '',
        winnerName: '',
        winningCardId: 0,
        winningPattern: '',
        prizePoolEtb: 0,
        winners: [],
      });
    }

    // Check immediately if any reserved card(s) completed a diagonal or winning line on this ball
    settleRoomIfWinnerFound(roomId, updatedCalls, drawResult.ball);

    // Queue Part E notification for new Bingo number
    botEngine.queueNotification('new_bingo_number', actor.telegramUserId, {
      ballNumber: drawResult.ball,
      totalCalls: drawResult.totalCalled,
    });

    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json(drawResult);
  });

  // 8. Server-Authoritative Winner Verification Endpoint (Authenticated, Owns Card, Server Calls Only)
  app.post('/api/game/verify-winner', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        verified: false,
        error: 'unauthenticated_request',
        message: 'A valid Bearer token is required to claim a Bingo win.',
      });
      return;
    }

    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : 'adey-main';
    const cardId = Number(req.body?.cardId);
    const markedNumbers: number[] = Array.isArray(req.body?.markedNumbers)
      ? req.body.markedNumbers
          .map(Number)
          .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 75)
      : [];

    if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
      res.status(400).json({ ok: false, verified: false, reason: 'invalid_card_id', cardId });
      return;
    }

    const cycle = ensureRoomCycle(roomId);
    const activeGame = localLiveGames.get(roomId);
    if (
      cycle.status === 'completed' ||
      cycle.settledRoundNumber === cycle.roundNumber ||
      activeGame?.status === 'completed'
    ) {
      res.status(409).json({
        ok: false,
        verified: false,
        reason: 'game_already_completed',
        cardId,
      });
      return;
    }

    // Enforce verified card ownership for the authenticated caller
    const roomCards = localRoomCardOwnership.get(roomId);
    const cardOwner = roomCards?.get(cardId);
    if (!cardOwner || cardOwner !== actor.uid) {
      res.status(403).json({
        ok: false,
        verified: false,
        reason: 'card_not_owned_by_claimant',
        cardId,
        message: 'You do not own the claimed Bingo card in this room.',
      });
      return;
    }

    // Strictly use server-authoritative called numbers (never trust client-submitted calls)
    const authoritativeCalls = activeGame?.calledNumbers || [];
    if (authoritativeCalls.length === 0) {
      res.status(400).json({
        ok: false,
        verified: false,
        reason: 'pattern_not_satisfied',
        cardId,
      });
      return;
    }

    const verifyRes = gameAuthority.verifyWinnerAuthoritative({
      roomId,
      claimantTelegramId: actor.telegramUserId,
      playerName: actor.displayName,
      cardId,
      markedNumbers,
      enforceServerCallsOnly: true,
    });

    if (!verifyRes.verified) {
      res.status(400).json(verifyRes);
      return;
    }

    const winnerUid = actor.uid;
    const roomObj = adminAuthority.getRooms().find((r) => r.id === roomId);
    const cardPrice = roomObj ? roomObj.cardPriceEtb : 10;
    const distinctOwners = roomCards ? new Set(roomCards.values()).size : 1;
    const totalCards = roomCards ? roomCards.size : 1;
    const financials = calculateAuthoritativeGameFinancials(distinctOwners, totalCards, cardPrice);
    const prizeEtb = financials.winnersPrizePoolEtb;

    const p = ensureServerPlayerWithWelcomeBonus(actor);
    const balBefore = p ? Number(p.demoBalanceEtb ?? 0) : 0;
    const balAfter = Number((balBefore + prizeEtb).toFixed(2));
    if (p) {
      p.demoBalanceEtb = balAfter;
    }

    const winList = localTransactionsByUid.get(winnerUid) || [];
    winList.unshift({
      id: `tx_win_${roomId}_r${cycle.roundNumber}_${winnerUid}`,
      type: 'bingo_win',
      amount: prizeEtb,
      balanceBeforeEtb: balBefore,
      balanceAfterEtb: balAfter,
      relatedId: activeGame?.gameId || `game_${roomId}_live`,
      status: 'demo_completed',
      labelAm: `የቢንጎ ድል ሽልማት (ካርድ #${cardId})`,
      labelEn: `Bingo Win Prize (Card #${cardId})`,
      timestamp: new Date().toISOString(),
      reference: `WIN-${roomId.toUpperCase()}-R${cycle.roundNumber}-${cardId}`,
    });
    localTransactionsByUid.set(winnerUid, winList.slice(0, 50));

    cycle.settledRoundNumber = cycle.roundNumber;
    cycle.status = 'completed';
    cycle.phaseEndsAtMs = Date.now() + ROUND_INTERMISSION_MS;

    const winShare: RoundWinnerShare = {
      uid: winnerUid,
      telegramUserId: actor.telegramUserId,
      displayName: actor.displayName,
      cardId,
      patternType: verifyRes.winResult?.patternType || 'diagonal',
      patternLabelAm: verifyRes.winResult?.patternLabelAm || 'መስመር ቢንጎ',
      patternLabelEn: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
      winningCells: verifyRes.winResult?.winningCells || [],
      prizeEtb,
    };
    if (activeGame) {
      activeGame.status = 'completed';
      activeGame.winnerUid = winnerUid;
      activeGame.winnerName = actor.displayName;
      activeGame.winningCardId = cardId;
      activeGame.winningPattern = verifyRes.winResult?.patternLabelEn || 'Bingo Line';
      activeGame.prizePoolEtb = prizeEtb;
      activeGame.winners = [winShare];
    }

    botEngine.queueNotification('winner_announcement', actor.telegramUserId, {
      winnerName: actor.displayName,
      winningCardId: cardId,
      winningPattern: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
      demoPrizeEtb: prizeEtb,
    });
    botEngine.queueNotification('game_completion', actor.telegramUserId, {
      totalCalls: authoritativeCalls.length,
    });

    broadcastWalletUpdate(winnerUid);
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json({
      ...verifyRes,
      demoPrizeEtb: prizeEtb,
      updatedBalanceEtb: balAfter,
    });
  });

  // 8B. Server-Authoritative Card Reservation, Game Start, Round Reset, and Rooms Endpoints
  const extractPlayerSession = (req: express.Request) => {
    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const headerSessionToken =
      typeof req.headers['x-adey-session-token'] === 'string'
        ? req.headers['x-adey-session-token'].trim()
        : undefined;
    const token = bearerToken || headerSessionToken;
    if (!token) return null;
    const rawSecret = (
      process.env.ADEY_ADMIN_SESSION_SECRET ||
      process.env.TELEGRAM_WEBHOOK_SECRET ||
      process.env.TELEGRAM_BOT_TOKEN ||
      'adeybingo_server_admin_session_hmac_secret_v1'
    ).trim();
    const sessionSecret = rawSecret.startsWith('adeybingo_admin_session_secret_')
      ? rawSecret
      : `adeybingo_admin_session_secret_${rawSecret}`;
    const check = authorizeAdminRequest({
      sessionToken: token,
      botToken: resolveConfiguredBotToken() || '',
      sessionSecret,
    });
    return check.actor || null;
  };

  const localRoomCardOwnership = new Map<string, Map<number, string>>();
  const localLiveGames = new Map<
    string,
    {
      gameId: string;
      roomId: string;
      hostUid: string;
      roundNumber: number;
      status: 'countdown' | 'live' | 'completed';
      calledNumbers: number[];
      latestBall: number;
      winnerUid: string;
      winnerName: string;
      winningCardId: number;
      winningPattern: string;
      prizePoolEtb?: number;
      winners?: RoundWinnerShare[];
    }
  >();
  const localTransactionsByUid = new Map<
    string,
    Array<{
      id: string;
      type:
        | 'deposit_demo'
        | 'withdraw_demo'
        | 'card_entry'
        | 'bingo_win'
        | 'referral_bonus'
        | 'admin_adjustment';
      amount: number;
      balanceBeforeEtb?: number;
      balanceAfterEtb?: number;
      relatedId?: string;
      provider?: string;
      status: 'demo_completed' | 'demo_pending';
      labelAm: string;
      labelEn: string;
      timestamp: string;
      reference: string;
    }>
  >();
  const localDepositsByUid = new Map<
    string,
    Array<{
      depositId: string;
      amountEtb: number;
      provider: string;
      referenceCode: string;
      receiptProof?: string;
      reviewNotes?: string;
      status: 'Pending' | 'Approved' | 'Rejected';
      requestDate: string;
    }>
  >();
  const localPayoutsByUid = new Map<
    string,
    Array<{
      requestId: string;
      requestedAmountEtb: number;
      paymentMethod: string;
      status: 'Pending' | 'Under Review' | 'Approved' | 'Rejected' | 'Completed';
      requestDate: string;
      reviewNotes: string;
    }>
  >();
  const localAppliedPromoByUid = new Map<string, string>();
  const localReferralsByUid = new Map<
    string,
    Array<{
      id: string;
      friendName: string;
      handle: string;
      joinedAt: string;
      status: 'qualified' | 'pending';
      inviterBonus: number;
      inviteeBonus: number;
    }>
  >();
  const localSupportTicketsByUid = new Map<
    string,
    Array<{
      id: string;
      subject: string;
      category: 'wallet' | 'game' | 'account' | 'referral';
      message: string;
      status: 'open' | 'in_review' | 'resolved';
      createdAt: string;
      reply?: string;
    }>
  >();
  const localIdempotencyKeys = new Set<string>();

  // Authenticated Real-Time SSE Hub (user-scoped wallet updates + room/game state push)
  const sseClients = new Set<{ uid: string; res: express.Response }>();
  const broadcastSseEvent = (
    event: 'room_update' | 'wallet_update',
    payload: Record<string, unknown>,
    targetUid?: string
  ) => {
    const serialized = `event: ${event}\ndata: ${JSON.stringify({
      ...payload,
      serverNowMs: Date.now(),
    })}\n\n`;
    for (const client of sseClients) {
      if (targetUid && client.uid !== targetUid) continue;
      try {
        client.res.write(serialized);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const broadcastWalletUpdate = (uid: string) => {
    const tgId = uid.startsWith('tg_') ? Number(uid.slice(3)) || 0 : 0;
    const p = tgId > 0 ? botEngine.getPlayerByTelegramId(tgId) : undefined;
    const txs = localTransactionsByUid.get(uid) || [];
    const winningsBalanceEtb = txs
      .filter((tx) => tx.type === 'bingo_win' && tx.amount > 0)
      .reduce((sum, tx) => sum + tx.amount, 0);
    broadcastSseEvent(
      'wallet_update',
      {
        uid,
        availableBalanceEtb: p ? Math.max(0, Number(p.demoBalanceEtb ?? 0)) : 0,
        winningsBalanceEtb,
        transactions: txs.slice(0, 30),
        referrals: localReferralsByUid.get(uid) || [],
        depositRequests: localDepositsByUid.get(uid) || [],
        payoutRequests: localPayoutsByUid.get(uid) || [],
      },
      uid
    );
  };
  const broadcastRoomUpdate = (roomId: string) => {
    const targetRoom = adminAuthority.getRooms().find((r) => r.id === roomId);
    if (!targetRoom) return;
    const roomDto = getLocalRoomDto(targetRoom);
    const liveGame = localLiveGames.get(roomId) || null;
    const roomCards = localRoomCardOwnership.get(roomId);
    const takenCardIds = roomCards ? Array.from(roomCards.keys()).sort((a, b) => a - b) : [];
    broadcastSseEvent('room_update', {
      roomId,
      room: roomDto,
      game: liveGame,
      takenCardIds,
    });
  };

  // Lightweight local disk snapshot so server restarts preserve accounts, balances, referrals, and active countdowns
  const LOCAL_SNAPSHOT_PATH = path.join(__dirname, '.adeybingo-local-state.json');
  const persistLocalStateSnapshot = () => {
    try {
      const players = botEngine.getAllPlayers();
      const snapshot = {
        savedAtMs: Date.now(),
        players,
        transactions: Array.from(localTransactionsByUid.entries()),
        deposits: Array.from(localDepositsByUid.entries()),
        payouts: Array.from(localPayoutsByUid.entries()),
        appliedPromos: Array.from(localAppliedPromoByUid.entries()),
        referrals: Array.from(localReferralsByUid.entries()),
        supportTickets: Array.from(localSupportTicketsByUid.entries()),
        roomCycles: Array.from(localRoomCycleState.entries()),
        roomCards: Array.from(localRoomCardOwnership.entries()).map(([rid, m]) => [
          rid,
          Array.from(m.entries()),
        ]),
        liveGames: Array.from(localLiveGames.entries()),
      };
      const tmpPath = `${LOCAL_SNAPSHOT_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(tmpPath, LOCAL_SNAPSHOT_PATH);
    } catch {
      // Ignore snapshot errors on read-only filesystems
    }
  };

  const restoreLocalStateSnapshot = () => {
    try {
      if (!fs.existsSync(LOCAL_SNAPSHOT_PATH)) return;
      const raw = fs.readFileSync(LOCAL_SNAPSHOT_PATH, 'utf8');
      const snap = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(snap.players)) {
        for (const p of snap.players as Array<{
          uid?: string;
          telegramUserId?: number;
          firstName?: string;
          lastName?: string;
          username?: string;
          demoBalanceEtb?: number;
          referredByCode?: string;
          phoneVerified?: boolean;
          verifiedPhoneMasked?: string;
        }>) {
          if (!p.telegramUserId || !Number.isInteger(p.telegramUserId)) continue;
          let existing = botEngine.getPlayerByTelegramId(p.telegramUserId);
          if (!existing) {
            const reg = botEngine.handleIncomingUpdate({
              senderTelegramId: p.telegramUserId,
              firstName: p.firstName || 'Player',
              lastName: p.lastName || '',
              username: p.username || `tg_${p.telegramUserId}`,
              firebaseUid: p.uid || `tg_${p.telegramUserId}`,
              text: '/start',
            });
            existing = reg.profile;
          }
          if (existing) {
            if (typeof p.demoBalanceEtb === 'number' && Number.isFinite(p.demoBalanceEtb)) {
              existing.demoBalanceEtb = p.demoBalanceEtb;
            }
            if (p.referredByCode) existing.referredByCode = p.referredByCode;
            if (typeof p.phoneVerified === 'boolean') existing.phoneVerified = p.phoneVerified;
            if (p.verifiedPhoneMasked) existing.verifiedPhoneMasked = p.verifiedPhoneMasked;
          }
        }
      }
      if (Array.isArray(snap.transactions)) {
        for (const [k, v] of snap.transactions as [string, typeof localTransactionsByUid extends Map<string, infer V> ? V : never][]) {
          localTransactionsByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.deposits)) {
        for (const [k, v] of snap.deposits as [string, typeof localDepositsByUid extends Map<string, infer V> ? V : never][]) {
          localDepositsByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.payouts)) {
        for (const [k, v] of snap.payouts as [string, typeof localPayoutsByUid extends Map<string, infer V> ? V : never][]) {
          localPayoutsByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.appliedPromos)) {
        for (const [k, v] of snap.appliedPromos as [string, string][]) {
          localAppliedPromoByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.referrals)) {
        for (const [k, v] of snap.referrals as [string, typeof localReferralsByUid extends Map<string, infer V> ? V : never][]) {
          localReferralsByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.supportTickets)) {
        for (const [k, v] of snap.supportTickets as [string, typeof localSupportTicketsByUid extends Map<string, infer V> ? V : never][]) {
          localSupportTicketsByUid.set(k, v);
        }
      }
      if (Array.isArray(snap.roomCycles)) {
        for (const [k, v] of snap.roomCycles as [string, typeof localRoomCycleState extends Map<string, infer V> ? V : never][]) {
          localRoomCycleState.set(k, v);
        }
      }
      if (Array.isArray(snap.roomCards)) {
        for (const [rid, entries] of snap.roomCards as [string, [number, string][]][]) {
          localRoomCardOwnership.set(rid, new Map(entries));
        }
      }
      if (Array.isArray(snap.liveGames)) {
        for (const [k, v] of snap.liveGames as [string, typeof localLiveGames extends Map<string, infer V> ? V : never][]) {
          localLiveGames.set(k, v);
        }
      }
    } catch {
      // Ignore corrupt snapshot and start cleanly
    }
  };

  const ROUND_CARD_WINDOW_MS = 60_000;
  const ROUND_DRAW_INTERVAL_MS = 3_000;
  const ROUND_INTERMISSION_MS = 6_000;

  const localRoomCycleState = new Map<
    string,
    {
      status: 'countdown' | 'live' | 'completed';
      phaseEndsAtMs: number;
      roundNumber: number;
      lastDrawAtMs: number;
      settledRoundNumber?: number;
      extendedRegistrationCount: number;
      scheduleNoticeAm?: string;
      scheduleNoticeEn?: string;
    }
  >();

  const localSchedulerAuditLogs: Array<{
    logId: string;
    roomId: string;
    gameId: string;
    roundNumber: number;
    action: string;
    confirmedPlayersCount: number;
    totalCardsSold: number;
    totalCollectedEtb: number;
    adeyShareEtb: number;
    winnersPrizePoolEtb: number;
    details: string;
    workerId: string;
    timestampMs: number;
  }> = [];

  const recordLocalSchedulerAudit = (entry: {
    roomId: string;
    roundNumber: number;
    action: string;
    confirmedPlayersCount: number;
    totalCardsSold: number;
    totalCollectedEtb: number;
    adeyShareEtb: number;
    winnersPrizePoolEtb: number;
    details: string;
    workerId?: string;
  }) => {
    const nowMs = Date.now();
    localSchedulerAuditLogs.unshift({
      logId: `sched_${entry.roomId}_r${entry.roundNumber}_${entry.action}_${nowMs}`,
      roomId: entry.roomId,
      gameId: `game_${entry.roomId}_live`,
      roundNumber: entry.roundNumber,
      action: entry.action,
      confirmedPlayersCount: entry.confirmedPlayersCount,
      totalCardsSold: entry.totalCardsSold,
      totalCollectedEtb: entry.totalCollectedEtb,
      adeyShareEtb: entry.adeyShareEtb,
      winnersPrizePoolEtb: entry.winnersPrizePoolEtb,
      details: entry.details,
      workerId: entry.workerId || 'server_daemon',
      timestampMs: nowMs,
    });
    if (localSchedulerAuditLogs.length > 200) {
      localSchedulerAuditLogs.length = 200;
    }
  };

  const ensureRoomCycle = (roomId: string) => {
    let cycle = localRoomCycleState.get(roomId);
    if (!cycle) {
      const now = Date.now();
      cycle = {
        status: 'countdown',
        phaseEndsAtMs: now + ROUND_CARD_WINDOW_MS,
        roundNumber: 1,
        lastDrawAtMs: 0,
        extendedRegistrationCount: 0,
      };
      localRoomCycleState.set(roomId, cycle);
      if (!localLiveGames.has(roomId)) {
        localLiveGames.set(roomId, {
          gameId: `game_${roomId}_live`,
          roomId,
          hostUid: 'tg_8842109',
          roundNumber: 1,
          status: 'countdown',
          calledNumbers: [],
          latestBall: 0,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          prizePoolEtb: 0,
          winners: [],
        });
      }
    }
    return cycle;
  };

  const settleRoomIfWinnerFound = (
    roomId: string,
    calledNumbers: number[],
    latestBall: number
  ): boolean => {
    const cycle = ensureRoomCycle(roomId);
    if (cycle.settledRoundNumber === cycle.roundNumber || cycle.status === 'completed') {
      return false;
    }
    const ownership = localRoomCardOwnership.get(roomId);
    if (!ownership || ownership.size === 0) return false;

    const roomObj = adminAuthority.getRooms().find((r) => r.id === roomId);
    const cardPrice = roomObj ? roomObj.cardPriceEtb : 10;

    const entries: RoomCardOwnerEntry[] = [];
    const uniqueOwners = new Set<string>();
    for (const [cid, ownerUid] of ownership.entries()) {
      uniqueOwners.add(ownerUid);
      const tgId = ownerUid.startsWith('tg_') ? Number(ownerUid.slice(3)) || 0 : 0;
      const p = tgId > 0 ? botEngine.getPlayerByTelegramId(tgId) : undefined;
      const displayName = p
        ? `${p.firstName} ${p.lastName || ''}`.trim() || ownerUid
        : ownerUid;
      entries.push({
        cardId: cid,
        uid: ownerUid,
        telegramUserId: tgId,
        displayName,
      });
    }

    const settlement = evaluateRoundWinners({
      entries,
      calledNumbers,
      cardPrice,
      totalCardsInRoom: ownership.size,
      confirmedPlayersCount: uniqueOwners.size,
      useAuthoritative8020Split: true,
    });

    if (!settlement.hasWinner) return false;

    cycle.settledRoundNumber = cycle.roundNumber;
    cycle.status = 'completed';
    cycle.phaseEndsAtMs = Date.now() + ROUND_INTERMISSION_MS;

    const financials = calculateAuthoritativeGameFinancials(
      uniqueOwners.size,
      ownership.size,
      cardPrice
    );

    // Distribute exact 80% prize pool across all simultaneous winners and add directly to their account balances
    for (const payout of settlement.payoutsByPlayer) {
      let balBefore = 0;
      let balAfter = payout.totalPrizeEtb;
      if (payout.telegramUserId > 0) {
        const p = botEngine.getPlayerByTelegramId(payout.telegramUserId);
        if (p) {
          balBefore = Number(p.demoBalanceEtb ?? 0);
          balAfter = Number((balBefore + payout.totalPrizeEtb).toFixed(2));
          p.demoBalanceEtb = balAfter;
        }
      }
      const winList = localTransactionsByUid.get(payout.uid) || [];
      const cardsLabel = payout.cardIds.join(', ');
      winList.unshift({
        id: `tx_win_${cycle.roundNumber}_${payout.uid}_${Date.now()}`,
        type: 'bingo_win',
        amount: payout.totalPrizeEtb,
        balanceBeforeEtb: balBefore,
        balanceAfterEtb: balAfter,
        relatedId: `game_${roomId}_live`,
        status: 'demo_completed',
        labelAm:
          settlement.winners.length > 1
            ? `የጋራ የቢንጎ ድል (ካርድ ${cardsLabel})`
            : `የቢንጎ ድል ሽልማት (ካርድ ${cardsLabel})`,
        labelEn:
          settlement.winners.length > 1
            ? `Shared Bingo Win (Card ${cardsLabel})`
            : `Bingo Win Prize (Card ${cardsLabel})`,
        timestamp: new Date().toISOString(),
        reference: `WIN-${roomId.toUpperCase()}-R${cycle.roundNumber}`,
      });
      localTransactionsByUid.set(payout.uid, winList.slice(0, 50));
      broadcastWalletUpdate(payout.uid);

      if (payout.telegramUserId > 0) {
        const firstWin = settlement.winners.find((w) => w.uid === payout.uid);
        botEngine.queueNotification('winner_announcement', payout.telegramUserId, {
          winnerName: payout.displayName,
          winningCardId: payout.cardIds[0],
          winningPattern: firstWin?.patternLabelEn || 'Bingo Line',
          demoPrizeEtb: payout.totalPrizeEtb,
        });
        botEngine.queueNotification('game_completion', payout.telegramUserId, {
          totalCalls: calledNumbers.length,
        });
      }
    }

    recordLocalSchedulerAudit({
      roomId,
      roundNumber: cycle.roundNumber,
      action: 'winner_auto_settled',
      confirmedPlayersCount: financials.confirmedPlayersCount,
      totalCardsSold: financials.totalCardsSold,
      totalCollectedEtb: financials.totalCollectedEtb,
      adeyShareEtb: financials.adeyShareEtb,
      winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
      details: `Settled Round #${cycle.roundNumber}: ${settlement.prizePoolEtb} ETB (80% pool) distributed to ${settlement.payoutsByPlayer.length} winner(s).`,
    });

    const currentGame = localLiveGames.get(roomId);
    const primary = settlement.winners[0];
    localLiveGames.set(roomId, {
      gameId: currentGame?.gameId || `game_${roomId}_live`,
      roomId,
      hostUid: currentGame?.hostUid || 'tg_8842109',
      roundNumber: cycle.roundNumber,
      status: 'completed',
      calledNumbers,
      latestBall,
      winnerUid: primary.uid,
      winnerName: settlement.payoutsByPlayer.map((p) => p.displayName).join(', '),
      winningCardId: primary.cardId,
      winningPattern: primary.patternLabelEn,
      prizePoolEtb: settlement.prizePoolEtb,
      winners: settlement.winners,
    });
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    return true;
  };

  const tickRoomCycles = () => {
    const now = Date.now();
    for (const room of adminAuthority.getRooms()) {
      const roomId = room.id;
      const cycle = ensureRoomCycle(roomId);
      const currentGame = localLiveGames.get(roomId);
      const roomCards = localRoomCardOwnership.get(roomId);
      const confirmedPlayersCount = roomCards ? new Set(roomCards.values()).size : 0;
      const reservedCardsCount = roomCards?.size ?? 0;
      const minPlayers = Math.max(1, Number(room.minPlayers ?? 3));
      const financials = calculateAuthoritativeGameFinancials(
        confirmedPlayersCount,
        reservedCardsCount,
        room.cardPriceEtb
      );

      if (cycle.status === 'countdown' && now >= cycle.phaseEndsAtMs) {
        // Validate paid players against minPlayers (default 3; NEVER wait for 600!)
        if (confirmedPlayersCount < minPlayers) {
          // Do NOT fabricate players or start an invalid game!
          // Automatically extend registration and preserve all verified payments and card reservations.
          cycle.phaseEndsAtMs = now + ROUND_CARD_WINDOW_MS;
          cycle.extendedRegistrationCount += 1;
          cycle.scheduleNoticeAm = `ዝቅተኛው የተጫዋች ቁጥር (${minPlayers}) ስላልሞላ ምዝገባ ተራዝሟል። ክፍያዎ እና ካርድዎ ተጠብቋል።`;
          cycle.scheduleNoticeEn = `Minimum ${minPlayers} paid players not yet reached (${confirmedPlayersCount}/${minPlayers}). Registration extended; your verified payment & cards are preserved.`;
          recordLocalSchedulerAudit({
            roomId,
            roundNumber: cycle.roundNumber,
            action: 'registration_extended',
            confirmedPlayersCount: financials.confirmedPlayersCount,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            details: `Extended registration window #${cycle.extendedRegistrationCount} (${confirmedPlayersCount}/${minPlayers} paid players). Preserved ${reservedCardsCount} cards.`,
          });
          broadcastRoomUpdate(roomId);
          persistLocalStateSnapshot();
          continue;
        }

        // Minimum paid players met (3, 5, 50, up to 600) -> START GAME AUTOMATICALLY
        gameAuthority.resetRoomCalls(roomId, []);
        const openingDraw = gameAuthority.drawNextBallAuthoritative({
          roomId,
          callerTelegramId: 8842109,
        });
        const called = openingDraw.calledNumbers || (openingDraw.ball ? [openingDraw.ball] : []);
        const latest = openingDraw.ball || 0;
        cycle.status = 'live';
        cycle.phaseEndsAtMs = 0;
        cycle.lastDrawAtMs = now;
        cycle.scheduleNoticeAm = '';
        cycle.scheduleNoticeEn = '';
        recordLocalSchedulerAudit({
          roomId,
          roundNumber: cycle.roundNumber,
          action: 'game_auto_started',
          confirmedPlayersCount: financials.confirmedPlayersCount,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          details: `Auto-started Round #${cycle.roundNumber} with ${financials.confirmedPlayersCount} paid players (${financials.winnersPrizePoolEtb} ETB 80% prize pool).`,
        });
        localLiveGames.set(roomId, {
          gameId: `game_${roomId}_live`,
          roomId,
          hostUid: currentGame?.hostUid || 'tg_8842109',
          roundNumber: cycle.roundNumber,
          status: 'live',
          calledNumbers: called,
          latestBall: latest,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          prizePoolEtb: financials.winnersPrizePoolEtb,
          winners: [],
        });
        if (!settleRoomIfWinnerFound(roomId, called, latest)) {
          broadcastRoomUpdate(roomId);
          persistLocalStateSnapshot();
        }
      } else if (cycle.status === 'live' && now - cycle.lastDrawAtMs >= ROUND_DRAW_INTERVAL_MS) {
        if (cycle.settledRoundNumber === cycle.roundNumber || currentGame?.status === 'completed') {
          cycle.status = 'completed';
          if (!cycle.phaseEndsAtMs) cycle.phaseEndsAtMs = now + ROUND_INTERMISSION_MS;
          continue;
        }
        const drawRes = gameAuthority.drawNextBallAuthoritative({
          roomId,
          callerTelegramId: 8842109,
        });
        cycle.lastDrawAtMs = now;
        if (drawRes.ok && drawRes.ball) {
          const called =
            drawRes.calledNumbers ||
            [...(currentGame?.calledNumbers || []), drawRes.ball];
          localLiveGames.set(roomId, {
            gameId: currentGame?.gameId || `game_${roomId}_live`,
            roomId,
            hostUid: currentGame?.hostUid || 'tg_8842109',
            roundNumber: cycle.roundNumber,
            status: 'live',
            calledNumbers: called,
            latestBall: drawRes.ball,
            winnerUid: '',
            winnerName: '',
            winningCardId: 0,
            winningPattern: '',
            prizePoolEtb: financials.winnersPrizePoolEtb,
            winners: [],
          });
          if (!settleRoomIfWinnerFound(roomId, called, drawRes.ball)) {
            broadcastRoomUpdate(roomId);
          }
        } else {
          cycle.status = 'completed';
          cycle.phaseEndsAtMs = now + ROUND_INTERMISSION_MS;
          if (currentGame) {
            currentGame.status = 'completed';
          }
          broadcastRoomUpdate(roomId);
          persistLocalStateSnapshot();
        }
      } else if (cycle.status === 'completed' && now >= cycle.phaseEndsAtMs) {
        cycle.roundNumber += 1;
        cycle.status = 'countdown';
        cycle.phaseEndsAtMs = now + ROUND_CARD_WINDOW_MS;
        cycle.lastDrawAtMs = 0;
        cycle.settledRoundNumber = undefined;
        cycle.extendedRegistrationCount = 0;
        cycle.scheduleNoticeAm = '';
        cycle.scheduleNoticeEn = '';
        localRoomCardOwnership.delete(roomId);
        gameAuthority.resetRoomCalls(roomId, []);
        recordLocalSchedulerAudit({
          roomId,
          roundNumber: cycle.roundNumber,
          action: 'next_game_auto_created',
          confirmedPlayersCount: 0,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          details: `Automatically created next game Round #${cycle.roundNumber}. Registration open (min ${minPlayers} players, max 600).`,
        });
        localLiveGames.set(roomId, {
          gameId: `game_${roomId}_live`,
          roomId,
          hostUid: currentGame?.hostUid || 'tg_8842109',
          roundNumber: cycle.roundNumber,
          status: 'countdown',
          calledNumbers: [],
          latestBall: 0,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          prizePoolEtb: 0,
          winners: [],
        });
        broadcastRoomUpdate(roomId);
        persistLocalStateSnapshot();
      }
    }
  };

  restoreLocalStateSnapshot();
  for (const r of adminAuthority.getRooms()) {
    ensureRoomCycle(r.id);
  }
  const roomCycleTimer = setInterval(tickRoomCycles, 1000);
  roomCycleTimer.unref?.();

  // Authenticated Server-Sent Events (SSE) real-time stream (strictly scoped to caller's uid for wallet updates)
  app.get('/api/realtime/stream', (req, res) => {
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : undefined;
    if (queryToken && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${queryToken}`;
    }
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid session token is required for real-time updates.',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const client = { uid: actor.uid, res };
    sseClients.add(client);

    // Immediately push current server clock + rooms snapshot on connect
    const rooms = adminAuthority.getRooms().map(getLocalRoomDto);
    res.write(
      `event: sync\ndata: ${JSON.stringify({
        serverNowMs: Date.now(),
        rooms,
      })}\n\n`
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ serverNowMs: Date.now() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(client);
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  });

  const getLocalRoomDto = (r: ReturnType<typeof adminAuthority.getRooms>[number]) => {
    const cycle = ensureRoomCycle(r.id);
    const roomCards = localRoomCardOwnership.get(r.id);
    const activePlayersCount = roomCards ? new Set(roomCards.values()).size : 0;
    const reservedCardsCount = roomCards?.size ?? 0;
    const liveGame = localLiveGames.get(r.id);
    const remainingCountdown =
      cycle.status === 'countdown' || cycle.status === 'completed'
        ? Math.max(0, Math.ceil((cycle.phaseEndsAtMs - Date.now()) / 1000))
        : 0;
    const financials = calculateAuthoritativeGameFinancials(
      activePlayersCount,
      reservedCardsCount,
      r.cardPriceEtb
    );
    const lifecycleStage = resolveGameLifecycleStage({
      status: cycle.status,
      confirmedPlayersCount: financials.confirmedPlayersCount,
      countdownSeconds: remainingCountdown,
      minPlayers: r.minPlayers,
    });
    adminAuthority.syncLiveRoomFinancials({
      roomId: r.id,
      confirmedPlayersCount: financials.confirmedPlayersCount,
      totalCardsSold: financials.totalCardsSold,
      status: cycle.status,
      countdownSeconds: remainingCountdown,
      latestBall: liveGame?.latestBall ?? 0,
      calledNumbersCount: liveGame?.calledNumbers?.length ?? 0,
    });
    return {
      roomId: r.id,
      nameAm: r.nameAm,
      nameEn: r.nameEn,
      cardPrice: r.cardPriceEtb,
      maxPlayersPerRoom: financials.maxCapacityPlayers,
      maxCardsPerRoom: r.maxCardsPerRoom,
      maxCardsPerPlayer: r.maxCardsPerPlayer,
      minPlayers: r.minPlayers,
      countdownSeconds: remainingCountdown,
      roundNumber: cycle.roundNumber,
      registrationDeadlineMs: cycle.status === 'countdown' ? cycle.phaseEndsAtMs : 0,
      intermissionEndsAtMs: cycle.status === 'completed' ? cycle.phaseEndsAtMs : 0,
      nextBallDrawAtMs: cycle.status === 'live' ? cycle.lastDrawAtMs + 3_000 : 0,
      extendedRegistrationCount: cycle.extendedRegistrationCount,
      scheduleNoticeAm: cycle.scheduleNoticeAm,
      scheduleNoticeEn: cycle.scheduleNoticeEn,
      activePlayersCount: financials.confirmedPlayersCount,
      confirmedPlayersCount: financials.confirmedPlayersCount,
      verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
      availableSpaces: financials.availableSpaces,
      reservedCardsCount,
      totalCardsSold: financials.totalCardsSold,
      totalCollectedEtb: financials.totalCollectedEtb,
      adeyShareEtb: financials.adeyShareEtb,
      winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
      status: cycle.status,
      lifecycleStage,
      currentGameId: liveGame?.gameId || `game_${r.id}_live`,
      hostUid: liveGame?.hostUid || 'tg_8842109',
    };
  };

  app.post('/api/game/tick', (_req, res) => {
    tickRoomCycles();
    const rooms = adminAuthority.getRooms().map(getLocalRoomDto);
    res.json({
      ok: true,
      serverNowMs: Date.now(),
      mode: '24_7_autonomous',
      results: rooms,
    });
  });

  app.get('/api/game/scheduler-status', (req, res) => {
    const rawRoomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : '';
    const rooms = adminAuthority.getRooms().map(getLocalRoomDto);
    const logs = rawRoomId
      ? localSchedulerAuditLogs.filter((l) => l.roomId === rawRoomId)
      : localSchedulerAuditLogs;
    res.json({
      ok: true,
      serverNowMs: Date.now(),
      mode: '24_7_autonomous',
      minPlayersDefault: 3,
      maxCapacityPlayers: 600,
      rooms,
      auditLogs: logs.slice(0, 25),
    });
  });

  app.get('/api/rooms', (req, res) => {
    const rawRoomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : '';
    const allRooms = adminAuthority.getRooms();
    if (rawRoomId) {
      const target = allRooms.find((r) => r.id === rawRoomId);
      if (!target) {
        res.status(404).json({ ok: false, error: 'room_not_found', message: 'Requested room does not exist.' });
        return;
      }
      const actor = extractPlayerSession(req);
      const roomCards = localRoomCardOwnership.get(rawRoomId) || new Map<number, string>();
      const myCardIds: number[] = [];
      const takenCardIds: number[] = [];
      for (const [cid, owner] of roomCards.entries()) {
        if (actor && owner === actor.uid) myCardIds.push(cid);
        else takenCardIds.push(cid);
      }
      myCardIds.sort((a, b) => a - b);
      takenCardIds.sort((a, b) => a - b);
      res.json({
        ok: true,
        serverNowMs: Date.now(),
        room: getLocalRoomDto(target),
        myCardIds,
        takenCardIds,
        game: localLiveGames.get(rawRoomId) || null,
      });
      return;
    }

    res.json({ ok: true, serverNowMs: Date.now(), rooms: allRooms.map(getLocalRoomDto) });
  });

  const ensureServerPlayerWithWelcomeBonus = (actor: {
    uid: string;
    telegramUserId: number;
    displayName: string;
    username: string;
  }) => {
    let player = botEngine.getPlayerByTelegramId(actor.telegramUserId);
    if (!player) {
      const reg = botEngine.handleIncomingUpdate({
        senderTelegramId: actor.telegramUserId,
        firstName: actor.displayName || 'Player',
        lastName: '',
        username: actor.username || `tg_${actor.telegramUserId}`,
        firebaseUid: actor.uid,
        text: '/start',
      });
      player = reg.profile;
      if (player) {
        player.demoBalanceEtb = 15;
      }
    }
    if (!localTransactionsByUid.has(actor.uid)) {
      const initBal = player ? Number(player.demoBalanceEtb ?? 15) : 15;
      localTransactionsByUid.set(actor.uid, [
        {
          id: `tx_init_${actor.uid}`,
          type: 'deposit_demo',
          amount: initBal,
          balanceBeforeEtb: 0,
          balanceAfterEtb: initBal,
          relatedId: actor.uid,
          status: 'demo_completed',
          labelAm: 'የመጀመሪያ ሂሳብ (15 ብር)',
          labelEn: 'Initial Account Balance (15 ETB)',
          timestamp: new Date().toISOString(),
          reference: `ADB-INIT-${actor.telegramUserId}`,
        },
      ]);
      persistLocalStateSnapshot();
    }
    return player;
  };

  const applyServerReferralAtomic = (
    actor: { uid: string; telegramUserId: number; displayName: string; username: string },
    rawCode: string
  ): {
    ok: boolean;
    status: number;
    error?: string;
    message?: string;
    inviterTelegramId?: number;
    inviterBonusEtb?: number;
    inviteeBonusEtb?: number;
    updatedBalanceEtb?: number;
  } => {
    const normalized = rawCode.trim().toUpperCase();
    const match = /^ADEY-([1-9]\d*)$/.exec(normalized);
    if (!match) {
      return { ok: false, status: 400, error: 'invalid_promo_code', message: 'Invalid referral code format.' };
    }
    const inviterId = Number(match[1]);
    if (inviterId === actor.telegramUserId) {
      return { ok: false, status: 400, error: 'self_referral_forbidden', message: 'You cannot apply your own referral code.' };
    }
    const player = ensureServerPlayerWithWelcomeBonus(actor);
    if (localAppliedPromoByUid.has(actor.uid) || player?.referredByCode) {
      return { ok: false, status: 409, error: 'promo_already_applied', message: 'A referral code has already been applied to your account.' };
    }
    // Never fabricate a nonexistent inviter!
    const inviterPlayer = botEngine.getPlayerByTelegramId(inviterId);
    if (!inviterPlayer) {
      return { ok: false, status: 404, error: 'inviter_not_found', message: 'No registered player matches this referral code.' };
    }

    // Business rule: new player starts with 15 ETB initial credit (once); inviter earns +20 ETB per referred new player.
    const inviterBonus = 20;
    const inviteeBonus = 0;
    const nowIso = new Date().toISOString();
    const refId = `ref_tg_${actor.telegramUserId}`;

    const inviteeBalance = player ? Number(player.demoBalanceEtb ?? 15) : 15;
    if (player) {
      player.referredByCode = normalized;
    }

    const inviterBefore = Number(inviterPlayer.demoBalanceEtb ?? 0);
    const inviterAfter = Number((inviterBefore + inviterBonus).toFixed(2));
    inviterPlayer.demoBalanceEtb = inviterAfter;

    localAppliedPromoByUid.set(actor.uid, normalized);

    const inviterUid = inviterPlayer.uid || `tg_${inviterId}`;
    const inviterTxs = localTransactionsByUid.get(inviterUid) || [];
    inviterTxs.unshift({
      id: `tx_ref_inviter_${actor.telegramUserId}`,
      type: 'referral_bonus',
      amount: inviterBonus,
      balanceBeforeEtb: inviterBefore,
      balanceAfterEtb: inviterAfter,
      relatedId: refId,
      status: 'demo_completed',
      labelAm: `ጓደኛ በመጋበዝ የተገኘ ቦነስ (+20 ብር · ${actor.displayName})`,
      labelEn: `Referral Reward (+20 ETB · ${actor.displayName})`,
      timestamp: nowIso,
      reference: `ADB-REF-${actor.telegramUserId}`,
    });
    localTransactionsByUid.set(inviterUid, inviterTxs.slice(0, 50));

    const inviterRefs = localReferralsByUid.get(inviterUid) || [];
    inviterRefs.unshift({
      id: refId,
      friendName: actor.displayName,
      handle: `@${actor.username.replace(/^@/, '')}`,
      joinedAt: nowIso,
      status: 'qualified',
      inviterBonus,
      inviteeBonus,
    });
    localReferralsByUid.set(inviterUid, inviterRefs);

    broadcastWalletUpdate(actor.uid);
    broadcastWalletUpdate(inviterUid);
    persistLocalStateSnapshot();

    return {
      ok: true,
      status: 200,
      inviterTelegramId: inviterId,
      inviterBonusEtb: inviterBonus,
      inviteeBonusEtb: inviteeBonus,
      updatedBalanceEtb: inviteeBalance,
    };
  };

  app.get('/api/player/state', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'missing_authorization',
        message: 'Authentication required. Provide a valid Bearer token.',
      });
      return;
    }
    const player = ensureServerPlayerWithWelcomeBonus(actor);
    const availableBalanceEtb = player ? Math.max(0, Number(player.demoBalanceEtb ?? 0)) : 0;
    const txs = localTransactionsByUid.get(actor.uid) || [];
    const winningsBalanceEtb = txs
      .filter((tx) => tx.type === 'bingo_win' && tx.amount > 0)
      .reduce((sum, tx) => sum + tx.amount, 0);

    const leadersMap = new Map<string, { uid: string; telegramUserId: number; displayName: string; wins: number; winningsEtb: number }>();
    for (const [uidKey, list] of localTransactionsByUid.entries()) {
      const winsList = list.filter((t) => t.type === 'bingo_win' && t.amount > 0);
      if (winsList.length === 0) continue;
      const tgId = uidKey.startsWith('tg_') ? Number(uidKey.slice(3)) || 0 : 0;
      const p = tgId > 0 ? botEngine.getPlayerByTelegramId(tgId) : undefined;
      leadersMap.set(uidKey, {
        uid: uidKey,
        telegramUserId: tgId,
        displayName: p ? `${p.firstName} ${p.lastName || ''}`.trim() : uidKey,
        wins: winsList.length,
        winningsEtb: winsList.reduce((s, t) => s + t.amount, 0),
      });
    }
    const leaderboard = Array.from(leadersMap.values())
      .sort((a, b) => b.wins - a.wins || b.winningsEtb - a.winningsEtb)
      .slice(0, 15);

    res.json({
      ok: true,
      serverNowMs: Date.now(),
      profile: {
        uid: actor.uid,
        telegramUserId: actor.telegramUserId,
        displayName: actor.displayName,
        username: player?.username ? `@${player.username}` : `@${actor.username}`,
        language: player?.language || botEngine.getLanguage(actor.telegramUserId),
        phoneVerified: Boolean(player?.phoneVerified),
        referralCode: player?.referralCode || `ADEY-${actor.telegramUserId}`,
        ...(localAppliedPromoByUid.has(actor.uid)
          ? { referredByCode: localAppliedPromoByUid.get(actor.uid) }
          : player?.referredByCode
            ? { referredByCode: player.referredByCode }
            : {}),
      },
      wallet: {
        availableBalanceEtb,
        winningsBalanceEtb,
        demoSandboxOnly: true,
      },
      transactions: txs,
      depositRequests: localDepositsByUid.get(actor.uid) || [],
      payoutRequests: localPayoutsByUid.get(actor.uid) || [],
      referrals: localReferralsByUid.get(actor.uid) || [],
      supportTickets: localSupportTicketsByUid.get(actor.uid) || [],
      gameHistory: [],
      leaderboard,
    });
  });

  app.post('/api/player/wallet', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'missing_authorization',
        message: 'Authentication required. Provide a valid Bearer token.',
      });
      return;
    }
    if (
      req.body?.uid !== undefined ||
      req.body?.firebaseUid !== undefined ||
      req.body?.telegramUserId !== undefined ||
      req.body?.telegramId !== undefined ||
      req.body?.isAdmin !== undefined ||
      req.body?.demoBalanceEtb !== undefined ||
      req.body?.winningsBalanceEtb !== undefined
    ) {
      res.status(403).json({
        ok: false,
        error: 'client_override_rejected',
        message: 'Caller-supplied identity or balance fields are forbidden.',
      });
      return;
    }

    const action = req.body?.action;
    const rawIdemKey =
      (typeof req.headers['x-idempotency-key'] === 'string' && req.headers['x-idempotency-key'].trim()) ||
      (typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim()) ||
      '';
    if (rawIdemKey) {
      const scopedKey = `${actor.uid}:${String(action)}:${rawIdemKey}`;
      if (localIdempotencyKeys.has(scopedKey)) {
        res.status(409).json({
          ok: false,
          error: 'duplicate_request',
          message: 'This wallet request has already been processed.',
        });
        return;
      }
      localIdempotencyKeys.add(scopedKey);
    }

    const player = ensureServerPlayerWithWelcomeBonus(actor);
    const nowIso = new Date().toISOString();

    if (action === 'support_ticket') {
      const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim().slice(0, 120) : '';
      const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 1200) : '';
      const rawCat = typeof req.body?.category === 'string' ? req.body.category.trim() : 'game';
      const category =
        rawCat === 'wallet' || rawCat === 'game' || rawCat === 'account' || rawCat === 'referral'
          ? rawCat
          : 'game';
      if (!subject || !message) {
        res.status(400).json({ ok: false, error: 'invalid_support_ticket', message: 'Subject and message are required.' });
        return;
      }
      const ticket = {
        id: `SUP-${Date.now().toString(36).toUpperCase()}`,
        subject,
        category,
        message,
        status: 'open' as const,
        createdAt: nowIso,
      };
      const existingTickets = localSupportTicketsByUid.get(actor.uid) || [];
      existingTickets.unshift(ticket);
      localSupportTicketsByUid.set(actor.uid, existingTickets.slice(0, 20));
      persistLocalStateSnapshot();
      res.status(201).json({ ok: true, action: 'support_ticket', ticket });
      return;
    }

    if (action === 'apply_promo') {
      const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      if (!rawCode || rawCode.length < 3 || rawCode.length > 32 || !/^[A-Z0-9_-]+$/.test(rawCode)) {
        res.status(400).json({ ok: false, error: 'invalid_promo_code', message: 'Invalid promo or referral code.' });
        return;
      }
      if (/^ADEY-[1-9]\d*$/.test(rawCode)) {
        const refRes = applyServerReferralAtomic(actor, rawCode);
        if (!refRes.ok) {
          res.status(refRes.status).json({
            ok: false,
            error: refRes.error,
            message: refRes.message,
          });
          return;
        }
        res.json({
          ok: true,
          action: 'apply_promo',
          code: rawCode,
          bonusEtb: refRes.inviteeBonusEtb ?? 0,
          inviterBonusEtb: refRes.inviterBonusEtb ?? 20,
          updatedBalanceEtb: refRes.updatedBalanceEtb,
          demoSandboxOnly: true,
        });
        return;
      }
      res.status(404).json({ ok: false, error: 'promo_code_not_found', message: 'Promo or referral code not found.' });
      return;
    }

    if (action === 'deposit_request') {
      const amountEtb = Number(req.body?.amountEtb);
      if (!Number.isFinite(amountEtb) || amountEtb < 10 || amountEtb > 10000) {
        res.status(400).json({ ok: false, error: 'invalid_deposit_amount', message: 'Deposit request must be 10–10,000 ETB.' });
        return;
      }
      const rawProvider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
      const method =
        rawProvider === 'CBE Birr (Manual)' ||
        rawProvider === 'CBE Birr (Demo)' ||
        rawProvider === 'Bank Transfer (Manual)' ||
        rawProvider === 'Telebirr (Manual)' ||
        rawProvider === 'Telebirr (Demo)'
          ? rawProvider
          : 'Telebirr (Manual)';

      const rawRef =
        typeof req.body?.receiptReference === 'string' && req.body.receiptReference.trim()
          ? req.body.receiptReference.trim()
          : typeof req.body?.referenceCode === 'string' && req.body.referenceCode.trim()
            ? req.body.referenceCode.trim()
            : '';

      if (rawRef && rawRef.length < 4) {
        res.status(400).json({
          ok: false,
          error: 'invalid_receipt_reference',
          message: 'Payment receipt reference must be at least 4 characters.',
        });
        return;
      }

      const customRef = rawRef
        ? rawRef.toUpperCase().slice(0, 64)
        : `REF-${Math.floor(100000 + Math.random() * 899999)}`;

      const receiptProof =
        typeof req.body?.receiptProof === 'string'
          ? req.body.receiptProof.trim().slice(0, 500)
          : typeof req.body?.proofNote === 'string'
            ? req.body.proofNote.trim().slice(0, 500)
            : '';

      // Prevent duplicate receipt submissions across all users
      let isDuplicateReceipt = adminAuthority.hasDepositReferenceCode(customRef);
      if (!isDuplicateReceipt) {
        for (const list of localDepositsByUid.values()) {
          if (list.some((item) => item.referenceCode.trim().toUpperCase() === customRef)) {
            isDuplicateReceipt = true;
            break;
          }
        }
      }
      if (isDuplicateReceipt) {
        res.status(409).json({
          ok: false,
          error: 'duplicate_receipt',
          message: 'This payment receipt reference has already been submitted.',
        });
        return;
      }

      const depositId = `DEP-WEB-${Date.now().toString(36).toUpperCase()}`;
      const deposit = {
        depositId,
        amountEtb,
        provider: method,
        referenceCode: customRef,
        ...(receiptProof ? { receiptProof } : {}),
        reviewNotes: 'Manual payment receipt submitted — awaiting admin verification',
        status: 'Pending' as const,
        requestDate: nowIso,
      };
      const existing = localDepositsByUid.get(actor.uid) || [];
      existing.unshift(deposit);
      localDepositsByUid.set(actor.uid, existing.slice(0, 20));

      adminAuthority.registerPlayerDepositRequest({
        depositId,
        uid: actor.uid,
        userDisplayName: actor.displayName,
        telegramUserId: actor.telegramUserId,
        amountEtb,
        provider: method,
        referenceCode: customRef,
        receiptProof,
        requestDate: nowIso.slice(0, 16).replace('T', ' '),
      });

      broadcastWalletUpdate(actor.uid);
      persistLocalStateSnapshot();
      res.status(201).json({ ok: true, action: 'deposit_request', deposit, demoSandboxOnly: true });
      return;
    }

    if (action === 'withdraw_request') {
      const amountEtb = Number(req.body?.amountEtb);
      if (!Number.isFinite(amountEtb) || amountEtb < 20 || amountEtb > 50000) {
        res.status(400).json({ ok: false, error: 'invalid_withdraw_amount', message: 'Minimum withdrawal request is 20 ETB.' });
        return;
      }
      const availableBalanceEtb = player ? Math.max(0, Number(player.demoBalanceEtb ?? 0)) : 0;
      if (amountEtb > availableBalanceEtb) {
        res.status(400).json({
          ok: false,
          error: 'insufficient_demo_balance',
          availableBalanceEtb,
          message: `Insufficient verified Demo balance (${availableBalanceEtb.toFixed(2)} ETB available).`,
        });
        return;
      }
      const nextBalanceEtb = Math.max(0, Number((availableBalanceEtb - amountEtb).toFixed(2)));
      if (player) {
        player.demoBalanceEtb = nextBalanceEtb;
      }
      const method =
        req.body?.method === 'CBE Birr (Demo)' || req.body?.method === 'Chapa Sandbox (Demo)'
          ? req.body.method
          : 'Telebirr (Demo)';
      const requestId = `PO-WEB-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const withdrawal = {
        requestId,
        requestedAmountEtb: amountEtb,
        paymentMethod: method,
        status: 'Pending' as const,
        requestDate: nowIso,
        reviewNotes: 'Submitted via ADEYBINGO Mini App — awaiting admin payout approval',
      };
      const existing = localPayoutsByUid.get(actor.uid) || [];
      existing.unshift(withdrawal);
      localPayoutsByUid.set(actor.uid, existing.slice(0, 10));

      const txList = localTransactionsByUid.get(actor.uid) || [];
      txList.unshift({
        id: `tx_wd_${requestId}`,
        type: 'withdraw_demo',
        amount: -amountEtb,
        balanceBeforeEtb: availableBalanceEtb,
        balanceAfterEtb: nextBalanceEtb,
        relatedId: requestId,
        provider: method,
        status: 'demo_pending',
        labelAm: `${method} የወጪ ጥያቄ (${requestId})`,
        labelEn: `${method} Withdrawal Request (${requestId})`,
        timestamp: nowIso,
        reference: requestId,
      });
      localTransactionsByUid.set(actor.uid, txList.slice(0, 50));

      adminAuthority.registerPlayerPayoutOrder({
        requestId,
        uid: actor.uid,
        userDisplayName: actor.displayName,
        telegramUserId: actor.telegramUserId,
        requestedAmountEtb: amountEtb,
        paymentMethod: method,
        destinationMasked: player?.verifiedPhoneMasked || '+2519****00',
        requestDate: nowIso.slice(0, 16).replace('T', ' '),
        reviewNotes: withdrawal.reviewNotes,
      });

      broadcastWalletUpdate(actor.uid);
      persistLocalStateSnapshot();
      res.status(201).json({
        ok: true,
        action: 'withdraw_request',
        withdrawal,
        updatedBalanceEtb: nextBalanceEtb,
        demoSandboxOnly: true,
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'invalid_wallet_action', message: 'Unsupported wallet action.' });
  });

  app.post('/api/cards/reserve', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid Bearer token is required to reserve or release cards.',
      });
      return;
    }

    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : 'adey-main';
    const cardId = Number(req.body?.cardId);
    const action = req.body?.action === 'release' ? 'release' : req.body?.action === 'reserve' ? 'reserve' : 'toggle';

    if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
      res.status(400).json({ ok: false, error: 'invalid_card_id', message: 'cardId must be 1..600.' });
      return;
    }

    const cycle = ensureRoomCycle(roomId);
    if (cycle.status === 'live') {
      res.status(409).json({
        ok: false,
        error: 'room_already_live',
        message: 'Card selection is locked while this round is live. Wait until the round finishes.',
      });
      return;
    }
    if (cycle.status === 'completed') {
      res.status(409).json({
        ok: false,
        error: 'room_completed',
        message: 'Round just finished. Next 60s card selection opens in a moment.',
      });
      return;
    }

    const roomObj = adminAuthority.getRooms().find((r) => r.id === roomId);
    const cardPrice = roomObj ? roomObj.cardPriceEtb : 10;
    const player = ensureServerPlayerWithWelcomeBonus(actor);
    const currentBal = player ? Math.max(0, Number(player.demoBalanceEtb ?? 0)) : 0;

    let roomCards = localRoomCardOwnership.get(roomId);
    if (!roomCards) {
      roomCards = new Map<number, string>();
      localRoomCardOwnership.set(roomId, roomCards);
    }

    const existingOwner = roomCards.get(cardId);
    if (existingOwner && existingOwner !== actor.uid) {
      res.status(409).json({ ok: false, error: 'card_already_taken', message: 'Card is already reserved by another player.' });
      return;
    }

    const myCards = Array.from(roomCards.entries())
      .filter(([, owner]) => owner === actor.uid)
      .map(([cid]) => cid);

    if (existingOwner === actor.uid) {
      if (action === 'reserve') {
        res.status(409).json({ ok: false, error: 'card_already_reserved', message: 'Card already reserved.' });
        return;
      }
      roomCards.delete(cardId);
      const nextCards = myCards.filter((c) => c !== cardId).sort((a, b) => a - b);
      const updatedBal = currentBal + cardPrice;
      if (player) player.demoBalanceEtb = updatedBal;
      const confirmedPlayers = new Set(roomCards.values()).size;
      const financials = calculateAuthoritativeGameFinancials(
        confirmedPlayers,
        roomCards.size,
        cardPrice
      );
      adminAuthority.syncLiveRoomFinancials({
        roomId,
        confirmedPlayersCount: financials.confirmedPlayersCount,
        totalCardsSold: financials.totalCardsSold,
        status: cycle.status,
      });
      const txList = localTransactionsByUid.get(actor.uid) || [];
      txList.unshift({
        id: `tx_rel_${roomId}_${cardId}_${Date.now()}`,
        type: 'card_entry',
        amount: cardPrice,
        balanceBeforeEtb: currentBal,
        balanceAfterEtb: updatedBal,
        relatedId: roomId,
        status: 'demo_completed',
        labelAm: `የካርድ #${cardId} መመለሻ ተመላሽ`,
        labelEn: `Card #${cardId} Release Refund (${roomId})`,
        timestamp: new Date().toISOString(),
        reference: `ADB-REL-${cardId}`,
      });
      localTransactionsByUid.set(actor.uid, txList.slice(0, 50));
      broadcastWalletUpdate(actor.uid);
      broadcastRoomUpdate(roomId);
      persistLocalStateSnapshot();
      res.json({
        ok: true,
        action: 'released',
        roomId,
        cardId,
        cardIds: nextCards,
        updatedBalanceEtb: updatedBal,
        financials,
      });
      return;
    }

    if (action === 'release') {
      res.status(409).json({ ok: false, error: 'card_not_reserved', message: 'Card is not reserved by you.' });
      return;
    }

    if (myCards.length >= 4) {
      res.status(409).json({ ok: false, error: 'max_4_cards_reached', message: 'Maximum 4 cards per player.' });
      return;
    }

    const currentDistinctPlayers = new Set(roomCards.values()).size;
    if ((myCards.length === 0 && currentDistinctPlayers >= 600) || roomCards.size >= 600) {
      res.status(409).json({
        ok: false,
        error: 'room_full',
        message: 'Room has reached maximum capacity (600 players).',
      });
      return;
    }

    if (currentBal < cardPrice) {
      res.status(400).json({
        ok: false,
        error: 'insufficient_balance',
        message: `Insufficient balance (${currentBal.toFixed(2)} ETB). Each card costs ${cardPrice} ETB — invite friends (+20 ETB) or deposit to play.`,
      });
      return;
    }

    roomCards.set(cardId, actor.uid);
    const nextCards = [...myCards, cardId].sort((a, b) => a - b);
    const updatedBal = Number((currentBal - cardPrice).toFixed(2));
    if (player) player.demoBalanceEtb = updatedBal;
    const confirmedPlayers = new Set(roomCards.values()).size;
    const financials = calculateAuthoritativeGameFinancials(
      confirmedPlayers,
      roomCards.size,
      cardPrice
    );
    adminAuthority.syncLiveRoomFinancials({
      roomId,
      confirmedPlayersCount: financials.confirmedPlayersCount,
      totalCardsSold: financials.totalCardsSold,
      status: cycle.status,
    });
    const entryTxList = localTransactionsByUid.get(actor.uid) || [];
    entryTxList.unshift({
      id: `tx_ent_${roomId}_${cardId}_${Date.now()}`,
      type: 'card_entry',
      amount: -cardPrice,
      balanceBeforeEtb: currentBal,
      balanceAfterEtb: updatedBal,
      relatedId: roomId,
      status: 'demo_completed',
      labelAm: `የካርድ #${cardId} መግቢያ`,
      labelEn: `Card #${cardId} Entry (${roomId})`,
      timestamp: new Date().toISOString(),
      reference: `ADB-ENT-${cardId}`,
    });
    localTransactionsByUid.set(actor.uid, entryTxList.slice(0, 50));
    broadcastWalletUpdate(actor.uid);
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json({
      ok: true,
      action: 'reserved',
      roomId,
      cardId,
      cardIds: nextCards,
      updatedBalanceEtb: updatedBal,
      financials,
    });
  });

  app.post('/api/game/start', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid Bearer token is required to start a game.',
      });
      return;
    }
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : 'adey-main';
    const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId.trim() : `game_${roomId}_live`;
    const roomCards = localRoomCardOwnership.get(roomId);
    const myReservedCount = roomCards
      ? Array.from(roomCards.values()).filter((owner) => owner === actor.uid).length
      : 0;
    if (myReservedCount === 0) {
      res.status(400).json({
        ok: false,
        error: 'card_required_to_play',
        message: 'You cannot play without selecting at least 1 card (10 ETB). Join bonus is 15 ETB & inviting friends grants +20 ETB!',
      });
      return;
    }
    const cycle = ensureRoomCycle(roomId);
    const existing = localLiveGames.get(roomId);
    const allowForceStart = Boolean(req.body?.forceStart) && actor.role === 'admin';
    if (Boolean(req.body?.forceStart) && actor.role !== 'admin') {
      res.status(403).json({
        ok: false,
        error: 'admin_required',
        message: 'Only administrators may force-start a round early.',
      });
      return;
    }
    if (cycle.status === 'countdown' && !allowForceStart) {
      res.json({
        ok: true,
        serverNowMs: Date.now(),
        game: existing || {
          gameId,
          roomId,
          hostUid: actor.uid,
          roundNumber: cycle.roundNumber,
          status: 'countdown' as const,
          calledNumbers: [],
          latestBall: 0,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
        },
      });
      return;
    }
    if ((cycle.status === 'live' || cycle.status === 'completed') && existing && !allowForceStart) {
      res.json({ ok: true, serverNowMs: Date.now(), game: existing });
      return;
    }
    gameAuthority.resetRoomCalls(roomId, []);
    const drawRes = gameAuthority.drawNextBallAuthoritative({
      roomId,
      callerTelegramId: actor.telegramUserId,
    });
    cycle.status = 'live';
    cycle.phaseEndsAtMs = 0;
    cycle.lastDrawAtMs = Date.now();
    const nextGame = {
      gameId,
      roomId,
      hostUid: actor.uid,
      roundNumber: cycle.roundNumber,
      status: 'live' as const,
      calledNumbers: drawRes.calledNumbers || (drawRes.ball ? [drawRes.ball] : []),
      latestBall: drawRes.ball || 0,
      winnerUid: '',
      winnerName: '',
      winningCardId: 0,
      winningPattern: '',
    };
    localLiveGames.set(roomId, nextGame);
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json({
      ok: true,
      serverNowMs: Date.now(),
      game: nextGame,
    });
  });

  app.post('/api/game/reset-round', (req, res) => {
    const actor = extractPlayerSession(req);
    if (!actor) {
      res.status(401).json({
        ok: false,
        error: 'unauthenticated_request',
        message: 'A valid Bearer token is required to reset a round.',
      });
      return;
    }
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : 'adey-main';
    const existingGame = localLiveGames.get(roomId);
    const hostUid = existingGame?.hostUid || 'tg_8842109';
    if (actor.role !== 'admin' && actor.uid !== hostUid) {
      res.status(403).json({
        ok: false,
        error: 'unauthorized_caller',
        message: 'Only the room host or administrator may reset this round.',
      });
      return;
    }
    const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId.trim() : `game_${roomId}_live`;
    const cycle = ensureRoomCycle(roomId);
    cycle.roundNumber += 1;
    cycle.status = 'countdown';
    cycle.phaseEndsAtMs = Date.now() + ROUND_CARD_WINDOW_MS;
    cycle.lastDrawAtMs = 0;
    cycle.settledRoundNumber = undefined;
    localRoomCardOwnership.delete(roomId);
    gameAuthority.resetRoomCalls(roomId, []);
    localLiveGames.set(roomId, {
      gameId,
      roomId,
      hostUid: actor.uid,
      roundNumber: cycle.roundNumber,
      status: 'countdown',
      calledNumbers: [],
      latestBall: 0,
      winnerUid: '',
      winnerName: '',
      winningCardId: 0,
      winningPattern: '',
      prizePoolEtb: 0,
      winners: [],
    });
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json({
      ok: true,
      serverNowMs: Date.now(),
      roomId,
      gameId,
      status: 'countdown',
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Server-Side Admin Authorization & Protected /api/admin/* Endpoints
  // ---------------------------------------------------------------------------

  const extractAdminAuthFromRequest = (req: express.Request) => {
    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const headerSessionToken =
      typeof req.headers['x-adey-session-token'] === 'string'
        ? req.headers['x-adey-session-token'].trim()
        : undefined;
    const telegramInitData =
      typeof req.headers['x-telegram-init-data'] === 'string'
        ? req.headers['x-telegram-init-data'].trim()
        : undefined;

    return authorizeAdminRequest({
      sessionToken: bearerToken || headerSessionToken,
      telegramInitData,
      botToken: resolveConfiguredBotToken() || '',
      sessionSecret: resolveAdminSessionSecret(),
    });
  };

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const authRes = extractAdminAuthFromRequest(req);
    if (!authRes.authorized || !authRes.actor) {
      res.status(authRes.statusCode).json({
        ok: false,
        authorized: false,
        statusCode: authRes.statusCode,
        reason: authRes.reason,
        actor: authRes.actor
          ? {
              uid: authRes.actor.uid,
              telegramUserId: authRes.actor.telegramUserId,
              displayName: authRes.actor.displayName,
              role: authRes.actor.role,
            }
          : null,
        message:
          authRes.statusCode === 401
            ? 'HTTP 401 Unauthorized: Valid server-verified session token or Telegram initData required.'
            : 'HTTP 403 Forbidden: Normal player accounts are not authorized to access administrator endpoints.',
      });
      return;
    }

    (req as express.Request & { adminActor?: VerifiedSessionActor }).adminActor = authRes.actor;
    next();
  };

  // 9A. Exchange verified identity or Telegram initData for a server-signed session token
  // Priority 1: Preset identityMode ("admin" / "player") and client role overrides are strictly rejected!
  app.post('/api/admin/session/exchange', async (req, res) => {
    if (
      req.body?.identityMode !== undefined ||
      req.body?.role !== undefined ||
      req.body?.isAdmin !== undefined ||
      req.body?.requestedRole !== undefined
    ) {
      res.status(403).json({
        ok: false,
        authorized: false,
        statusCode: 403,
        error: 'preset_identity_bypass_removed',
        reason: 'preset_identity_bypass_removed',
        message:
          'Preset identity modes (identityMode: "admin" / "player") and client-supplied roles are strictly forbidden. Provide a cryptographically verified Firebase ID token or Telegram initData.',
      });
      return;
    }

    const sessionSecret = resolveAdminSessionSecret();
    const botToken = resolveConfiguredBotToken();
    const rawInitData = typeof req.body?.initData === 'string' ? req.body.initData.trim() : '';

    if (rawInitData) {
      if (!botToken) {
        res.status(503).json({
          ok: false,
          authorized: false,
          statusCode: 503,
          reason: 'missing_bot_token',
          message: 'TELEGRAM_BOT_TOKEN is not configured on the server environment.',
          diagnostics: {
            failureCategory: 'backend_environment_configuration',
            botTokenConfigured: false,
          },
        });
        return;
      }
      const check = validateTelegramWebAppInitData(rawInitData, botToken, {
        maxAgeSeconds: 3600,
      });
      if (!check.valid || !check.telegramUser) {
        console.warn('[server/admin-session-exchange] initData validation failed', {
          reason: check.reason,
          diagnostics: check.diagnostics,
        });
        res.status(401).json({
          ok: false,
          authorized: false,
          statusCode: 401,
          reason: check.reason || 'invalid_init_data',
          message: 'Telegram initData signature validation failed.',
          diagnostics: check.diagnostics,
        });
        return;
      }
      const tg = check.telegramUser;
      const minted = mintServerSessionToken(
        {
          telegramUserId: tg.id,
          displayName: `${tg.first_name} ${tg.last_name || ''}`.trim(),
          username: tg.username || `tg_${tg.id}`,
        },
        sessionSecret
      );
      const isAdmin = minted.actor.role === 'admin';
      res.status(isAdmin ? 200 : 403).json({
        ok: isAdmin,
        authorized: isAdmin,
        token: minted.token,
        actor: minted.actor,
        reason: isAdmin ? 'authorized_admin' : 'forbidden_not_admin',
        ...(isAdmin
          ? {}
          : {
              error: 'admin_privileges_required',
              message:
                'Your Telegram identity was verified, but this account is not on the administrator allowlist.',
            }),
      });
      return;
    }

    // Check Bearer token or body.idToken
    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : typeof req.body?.idToken === 'string'
        ? req.body.idToken.trim()
        : '';

    if (bearerToken) {
      const existingCheck = authorizeAdminRequest({
        sessionToken: bearerToken,
        botToken: botToken || '',
        sessionSecret,
      });
      if (existingCheck.actor) {
        const isAdmin = existingCheck.actor.role === 'admin';
        res.status(isAdmin ? 200 : 403).json({
          ok: isAdmin,
          authorized: isAdmin,
          token: bearerToken,
          actor: existingCheck.actor,
          reason: isAdmin ? 'authorized_admin' : 'forbidden_not_admin',
        });
        return;
      }

      try {
        const decoded = await getAdminAuth(getOrInitFirebaseAdminApp()).verifyIdToken(bearerToken);
        const tgId =
          typeof decoded.telegram_id === 'number'
            ? decoded.telegram_id
            : decoded.uid.startsWith('tg_')
              ? Number(decoded.uid.slice(3)) || 0
              : 0;
        const minted = mintServerSessionToken(
          {
            uid: decoded.uid,
            telegramUserId: tgId,
            displayName: decoded.name || decoded.email || decoded.uid,
            username: decoded.uid.replace(/^tg_/, ''),
            email: decoded.email,
          },
          sessionSecret
        );
        const isAdmin = minted.actor.role === 'admin';
        res.status(isAdmin ? 200 : 403).json({
          ok: isAdmin,
          authorized: isAdmin,
          token: minted.token,
          actor: minted.actor,
          reason: isAdmin ? 'authorized_admin' : 'forbidden_not_admin',
        });
        return;
      } catch {
        // Security invariant: NEVER trust an unverified base64-decoded JWT payload!
        res.status(401).json({
          ok: false,
          authorized: false,
          statusCode: 401,
          reason: 'invalid_or_expired_token',
          message: 'Cryptographic Firebase ID token or session token verification failed.',
        });
        return;
      }
    }

    res.status(401).json({
      ok: false,
      authorized: false,
      statusCode: 401,
      reason: 'unauthenticated',
      message: 'Cryptographically verified Firebase ID token or Telegram initData is required.',
    });
  });

  // 9A-2. Owner Session Endpoint — STRICTLY requires verified cryptographic identity (never unauthenticated!)
  app.post('/api/admin/owner-preview-session', async (req, res) => {
    const authRes = extractAdminAuthFromRequest(req);
    if (!authRes.authorized || !authRes.actor) {
      res.status(authRes.statusCode || 401).json({
        ok: false,
        authorized: false,
        statusCode: authRes.statusCode || 401,
        reason: authRes.reason || 'unauthenticated',
        message: 'Cryptographically verified owner credentials are required. Unauthenticated admin minting is disabled.',
      });
      return;
    }
    const minted = mintServerSessionToken(
      {
        uid: authRes.actor.uid,
        telegramUserId: authRes.actor.telegramUserId,
        displayName: authRes.actor.displayName,
        username: authRes.actor.username,
        email: authRes.actor.email,
      },
      resolveAdminSessionSecret()
    );
    res.status(200).json({
      ok: true,
      authorized: true,
      token: minted.token,
      actor: minted.actor,
      reason: 'authorized_admin',
    });
  });

  // 9B. Verify current session role against server authority
  app.get('/api/admin/session', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    res.json({
      ok: true,
      authorized: true,
      statusCode: 200,
      actor,
    });
  });

  // 9C. Section 1: Overview Metrics
  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      overview: adminAuthority.getOverviewMetrics(),
    });
  });

  // 9D. Section 2: User Management (Search + Account Status + Masked Phone + Wallet Ledger)
  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({
      ok: true,
      users: adminAuthority.searchUsers(q),
    });
  });

  app.post('/api/admin/users/:uid/status', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const uid = String(req.params.uid || '');
    const accountStatus = req.body?.accountStatus === 'suspended' ? 'suspended' : 'active';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

    // Block any attempt to modify user roles through this endpoint
    if (req.body?.role !== undefined || req.body?.isAdmin !== undefined) {
      const blocked = adminAuthority.blockRoleEscalationAttempt({
        actor,
        targetUid: uid,
        requestedRole: String(req.body.role ?? (req.body.isAdmin ? 'admin' : 'player')),
      });
      res.status(403).json(blocked);
      return;
    }

    const result = adminAuthority.updateUserStatus({
      uid,
      accountStatus,
      reason,
      adminActor: actor,
    });
    if (!result.ok) {
      const status = result.reason === 'self_suspension_forbidden' ? 403 : 404;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/api/admin/users/:uid/wallet', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const uid = String(req.params.uid || '');
    const deltaEtb = Number(req.body?.deltaEtb);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

    const result = adminAuthority.adjustUserWalletBalance({
      uid,
      deltaEtb,
      reason,
      adminActor: actor,
    });
    if (!result.ok || !result.user) {
      res.status(result.reason === 'user_not_found' ? 404 : 400).json(result);
      return;
    }

    const txList = localTransactionsByUid.get(uid) || [];
    txList.unshift({
      id: `tx_adm_${Date.now()}`,
      type: deltaEtb > 0 ? 'deposit_demo' : 'withdraw_demo',
      amount: deltaEtb,
      status: 'demo_completed',
      labelAm:
        deltaEtb > 0
          ? `የአስተዳዳሪ ሂሳብ ጭማሪ (+${deltaEtb} ETB)`
          : `የአስተዳዳሪ ክፍያ / ተቀናሽ (${deltaEtb} ETB)`,
      labelEn:
        reason.trim() ||
        (deltaEtb > 0 ? `Admin Balance Credit (+${deltaEtb} ETB)` : `Admin Payout / Debit (${deltaEtb} ETB)`),
      timestamp: new Date().toISOString(),
      reference: `ADM-ADJ-${Date.now().toString(36).toUpperCase()}`,
    });
    localTransactionsByUid.set(uid, txList.slice(0, 50));
    broadcastWalletUpdate(uid);
    persistLocalStateSnapshot();

    res.json(result);
  });

  // 9E. Section 3: Payout Orders (Demo-Only Payout Request Management)
  app.get('/api/admin/payouts', requireAdmin, (req, res) => {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    res.json({
      ok: true,
      payouts: adminAuthority.getPayoutOrders(statusFilter),
    });
  });

  app.post('/api/admin/payouts/:requestId/review', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const requestId = String(req.params.requestId || '');
    const nextStatus = req.body?.nextStatus as PayoutOrderStatus;
    const reviewNotes = typeof req.body?.reviewNotes === 'string' ? req.body.reviewNotes : '';

    const result = adminAuthority.reviewPayoutOrder({
      requestId,
      nextStatus,
      reviewNotes,
      adminActor: actor,
    });
    if (!result.ok || !result.payout) {
      res.status(400).json(result);
      return;
    }

    const targetUid = result.payout.uid;
    const userPayouts = localPayoutsByUid.get(targetUid);
    if (userPayouts) {
      for (const item of userPayouts) {
        if (item.requestId === requestId) {
          item.status = result.payout.status;
          item.reviewNotes = result.payout.reviewNotes;
        }
      }
    }

    if (result.payout.status === 'Rejected' && result.refundedBalanceEtb !== undefined) {
      const txList = localTransactionsByUid.get(targetUid) || [];
      txList.unshift({
        id: `tx_poref_${requestId}_${Date.now()}`,
        type: 'withdraw_demo',
        amount: result.payout.requestedAmountEtb,
        balanceBeforeEtb: Math.max(0, result.refundedBalanceEtb - result.payout.requestedAmountEtb),
        balanceAfterEtb: result.refundedBalanceEtb,
        relatedId: requestId,
        provider: result.payout.paymentMethod,
        status: 'demo_completed',
        labelAm: `የወጪ ጥያቄ ተመላሽ (${requestId})`,
        labelEn: `Withdrawal Rejected — Refunded (${requestId})`,
        timestamp: new Date().toISOString(),
        reference: `REFUND-${requestId}`,
      });
      localTransactionsByUid.set(targetUid, txList.slice(0, 50));
    } else if (result.payout.status === 'Completed' || result.payout.status === 'Approved') {
      const txList = localTransactionsByUid.get(targetUid) || [];
      for (const tx of txList) {
        if (tx.reference === requestId) {
          tx.status = 'demo_completed';
        }
      }
    }

    broadcastWalletUpdate(targetUid);
    persistLocalStateSnapshot();
    res.json(result);
  });

  // 9F. Section 4: Deposit Requests (Demo-Only)
  app.get('/api/admin/deposits', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      deposits: adminAuthority.getDepositRequests(),
    });
  });

  app.post('/api/admin/deposits/:depositId/review', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const depositId = String(req.params.depositId || '');
    const nextStatus = req.body?.nextStatus as DepositRequestStatus;
    const reviewNotes = typeof req.body?.reviewNotes === 'string' ? req.body.reviewNotes : '';

    const result = adminAuthority.reviewDepositRequest({
      depositId,
      nextStatus,
      reviewNotes,
      adminActor: actor,
    });
    if (!result.ok || !result.deposit) {
      const status =
        result.reason === 'already_finalized'
          ? 409
          : result.reason === 'deposit_not_found'
            ? 404
            : 400;
      res.status(status).json(result);
      return;
    }

    const targetUid = result.deposit.uid;
    const userDeposits = localDepositsByUid.get(targetUid);
    if (userDeposits) {
      for (const item of userDeposits) {
        if (item.depositId === depositId) {
          item.status = result.deposit.status;
          item.reviewNotes = result.deposit.reviewNotes;
        }
      }
    }

    if (result.deposit.status === 'Approved' && result.creditedBalanceEtb !== undefined) {
      const txList = localTransactionsByUid.get(targetUid) || [];
      txList.unshift({
        id: `tx_dep_${depositId}`,
        type: 'deposit_demo',
        amount: result.deposit.amountEtb,
        balanceBeforeEtb: Math.max(0, result.creditedBalanceEtb - result.deposit.amountEtb),
        balanceAfterEtb: result.creditedBalanceEtb,
        relatedId: depositId,
        provider: result.deposit.provider,
        status: 'demo_completed',
        labelAm: `የጸደቀ ${result.deposit.provider} ገቢ (${result.deposit.referenceCode})`,
        labelEn: `Verified Manual ${result.deposit.provider} Deposit (${result.deposit.referenceCode})`,
        timestamp: new Date().toISOString(),
        reference: result.deposit.referenceCode,
      });
      localTransactionsByUid.set(targetUid, txList.slice(0, 50));
    }

    broadcastWalletUpdate(targetUid);
    persistLocalStateSnapshot();
    res.json(result);
  });

  // 9F-2. Legacy Initial Credit Audit & Non-Destructive Reconciliation (Admin Only)
  app.get('/api/admin/audit/initial-credits', requireAdmin, (_req, res) => {
    const report = adminAuthority.auditLegacyInitialCredits((uid) =>
      (localTransactionsByUid.get(uid) || []).map((t) => ({ id: t.id, amount: t.amount }))
    );
    res.json({
      ok: true,
      ...report,
    });
  });

  app.post('/api/admin/audit/initial-credits/reconcile', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const uid = typeof req.body?.uid === 'string' ? req.body.uid.trim() : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined;
    if (!uid) {
      res.status(400).json({ ok: false, reason: 'missing_uid' });
      return;
    }
    const result = adminAuthority.reconcileLegacyInitialCredit({
      uid,
      adminActor: actor,
      notes,
      ledgerLookup: (targetUid) =>
        (localTransactionsByUid.get(targetUid) || []).map((t) => ({ id: t.id, amount: t.amount })),
    });
    if (!result.ok) {
      const status =
        result.reason === 'already_reconciled'
          ? 409
          : result.reason === 'user_not_found'
            ? 404
            : 400;
      res.status(status).json(result);
      return;
    }
    const txList = localTransactionsByUid.get(uid) || [];
    txList.unshift({
      id: result.transactionId || `tx_reconcile_init_${uid}`,
      type: 'admin_adjustment',
      amount: result.adjustedByEtb ?? 0,
      balanceBeforeEtb: result.previousBalanceEtb ?? 0,
      balanceAfterEtb: result.newBalanceEtb ?? 0,
      relatedId: `tx_init_${uid}`,
      status: 'demo_completed',
      labelAm: 'የመጀመሪያ 250 ብር ሂሳብ ማስተካከያ (ወደ 15 ብር)',
      labelEn: 'Auditable Initial Credit Reconciliation (250 ETB -> 15 ETB)',
      timestamp: new Date().toISOString(),
      reference: `RECONCILE-INIT-${uid}`,
    });
    localTransactionsByUid.set(uid, txList.slice(0, 50));
    broadcastWalletUpdate(uid);
    persistLocalStateSnapshot();
    res.json(result);
  });

  // 9G. Section 5: Game Room Management
  app.get('/api/admin/rooms', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      rooms: adminAuthority.getRooms(),
    });
  });

  app.post('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const roomId = String(req.params.roomId || '');
    const cardPriceEtb =
      typeof req.body?.cardPriceEtb === 'number' ? req.body.cardPriceEtb : undefined;
    const lobbyCountdownSeconds =
      typeof req.body?.lobbyCountdownSeconds === 'number'
        ? req.body.lobbyCountdownSeconds
        : undefined;
    const minPlayers =
      typeof req.body?.minPlayers === 'number' ? req.body.minPlayers : undefined;
    const status = req.body?.status;

    const result = adminAuthority.updateRoomConfig({
      roomId,
      cardPriceEtb,
      lobbyCountdownSeconds,
      minPlayers,
      status,
      adminActor: actor,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/api/admin/rooms/:roomId/round-action', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const roomId = String(req.params.roomId || 'adey-main');
    const action = req.body?.action === 'force_start' ? 'force_start' : 'reset';
    const cycle = ensureRoomCycle(roomId);

    if (action === 'force_start') {
      gameAuthority.resetRoomCalls(roomId, []);
      const drawRes = gameAuthority.drawNextBallAuthoritative({
        roomId,
        callerTelegramId: actor.telegramUserId,
      });
      cycle.status = 'live';
      cycle.phaseEndsAtMs = 0;
      cycle.lastDrawAtMs = Date.now();
      cycle.settledRoundNumber = undefined;
      const nextGame = {
        gameId: `game_${roomId}_live`,
        roomId,
        hostUid: actor.uid,
        roundNumber: cycle.roundNumber,
        status: 'live' as const,
        calledNumbers: drawRes.calledNumbers || (drawRes.ball ? [drawRes.ball] : []),
        latestBall: drawRes.ball || 0,
        winnerUid: '',
        winnerName: '',
        winningCardId: 0,
        winningPattern: '',
        prizePoolEtb: 0,
        winners: [],
      };
      localLiveGames.set(roomId, nextGame);
      broadcastRoomUpdate(roomId);
      persistLocalStateSnapshot();
      res.json({ ok: true, action: 'force_start', roomId, roundNumber: cycle.roundNumber, status: 'live' });
      return;
    }

    cycle.roundNumber += 1;
    cycle.status = 'countdown';
    cycle.phaseEndsAtMs = Date.now() + ROUND_CARD_WINDOW_MS;
    cycle.lastDrawAtMs = 0;
    cycle.settledRoundNumber = undefined;
    localRoomCardOwnership.delete(roomId);
    gameAuthority.resetRoomCalls(roomId, []);
    localLiveGames.set(roomId, {
      gameId: `game_${roomId}_live`,
      roomId,
      hostUid: actor.uid,
      roundNumber: cycle.roundNumber,
      status: 'countdown',
      calledNumbers: [],
      latestBall: 0,
      winnerUid: '',
      winnerName: '',
      winningCardId: 0,
      winningPattern: '',
      prizePoolEtb: 0,
      winners: [],
    });
    broadcastRoomUpdate(roomId);
    persistLocalStateSnapshot();
    res.json({ ok: true, action: 'reset', roomId, roundNumber: cycle.roundNumber, status: 'countdown' });
  });

  // 9H. Section 6: Referral Management
  app.get('/api/admin/referrals', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      referrals: adminAuthority.getReferrals(),
    });
  });

  // 9I. Section 7: Bot Management (Welcome messages, button labels/destinations, announcements, delivery stats)
  app.get('/api/admin/bot/config', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      botConfig: adminAuthority.getBotManagementState(),
    });
  });

  app.post('/api/admin/bot/config', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const result = adminAuthority.updateBotManagementConfig({
      miniAppUrl: typeof req.body?.miniAppUrl === 'string' ? req.body.miniAppUrl : undefined,
      customWelcomeAm:
        req.body?.customWelcomeAm !== undefined ? req.body.customWelcomeAm : undefined,
      customWelcomeEn:
        req.body?.customWelcomeEn !== undefined ? req.body.customWelcomeEn : undefined,
      buttonLabels:
        typeof req.body?.buttonLabels === 'object' && req.body.buttonLabels
          ? req.body.buttonLabels
          : undefined,
      adminActor: actor,
    });
    res.json(result);
  });

  app.post('/api/admin/bot/announce', requireAdmin, (req, res) => {
    const actor = (req as express.Request & { adminActor: VerifiedSessionActor }).adminActor;
    const result = adminAuthority.sendBotAnnouncement({
      titleAm: typeof req.body?.titleAm === 'string' ? req.body.titleAm : '',
      titleEn: typeof req.body?.titleEn === 'string' ? req.body.titleEn : '',
      bodyAm: typeof req.body?.bodyAm === 'string' ? req.body.bodyAm : '',
      bodyEn: typeof req.body?.bodyEn === 'string' ? req.body.bodyEn : '',
      targetAudience:
        req.body?.targetAudience === 'verified_players' ? 'verified_players' : 'all_players',
      adminActor: actor,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  // 9J. Section 8: Notifications Management
  app.get('/api/admin/notifications', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      outbox: botEngine.getNotificationOutbox(),
    });
  });

  app.post('/api/admin/notifications/send', requireAdmin, (req, res) => {
    const event = (req.body?.event || 'support_response') as NotificationEventType;
    const telegramUserId = Number(req.body?.telegramUserId || 8842109);
    const payload =
      typeof req.body?.payload === 'object' && req.body.payload ? req.body.payload : {};
    const notification = botEngine.queueNotification(event, telegramUserId, payload, false);
    res.json({
      ok: true,
      notification,
      outbox: botEngine.getNotificationOutbox().slice(0, 20),
    });
  });

  // 9K. Section 9: Admin Settings & Immutable SHA-256 Audit Log
  app.get('/api/admin/settings', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      settings: adminAuthority.getAdminSettings(),
    });
  });

  // 10. Server-Side Amharic / English Bingo Number Voice TTS Endpoint (cached)
  const ttsAudioCache = new Map<string, string>();
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
  const geminiClient = geminiApiKey
    ? new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      })
    : null;

  app.get('/api/tts/bingo-call', async (req, res) => {
    const ballNum = Number(req.query.number);
    const lang = req.query.lang === 'en' ? 'en' : 'am';

    if (!Number.isInteger(ballNum) || ballNum < 1 || ballNum > 75) {
      res.status(400).json({ ok: false, reason: 'invalid_bingo_number' });
      return;
    }

    const script = getBingoVoiceCallScript(ballNum, lang);
    const spokenText = lang === 'am' ? script.amharicText : script.englishText;
    const cacheKey = `female_v2_${lang}:${ballNum}`;
    const cached = ttsAudioCache.get(cacheKey);
    if (cached) {
      res.json({
        ok: true,
        audioBase64: cached,
        mimeType: 'audio/wav',
        spokenText,
        phoneticText: script.amharicPhonetic,
        source: 'gemini_tts_cache',
      });
      return;
    }

    if (!geminiClient) {
      res.json({
        ok: false,
        audioBase64: null,
        spokenText,
        phoneticText: script.amharicPhonetic,
        reason: 'gemini_api_key_not_configured',
      });
      return;
    }

    try {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: spokenText,
                speechMetadata: {
                  style:
                    lang === 'am'
                      ? 'Warm, clear, cheerful female Ethiopian Amharic Bingo announcer calling the Bingo letter and number with a natural female voice'
                      : 'Warm, clear, cheerful female Bingo announcer calling the Bingo letter and number with a bright female voice',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' },
            },
          },
        },
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        res.json({
          ok: false,
          audioBase64: null,
          spokenText,
          phoneticText: script.amharicPhonetic,
          reason: 'empty_tts_response',
        });
        return;
      }

      ttsAudioCache.set(cacheKey, base64Audio);
      res.json({
        ok: true,
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
        spokenText,
        phoneticText: script.amharicPhonetic,
        source: 'gemini_tts',
      });
    } catch {
      res.json({
        ok: false,
        audioBase64: null,
        spokenText,
        phoneticText: script.amharicPhonetic,
        reason: 'gemini_tts_error',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(process.env.DISABLE_HMR === 'true' ? { hmr: false } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ADEYBINGO server listening on http://localhost:${PORT}`);
    // Automatically configure AdeyBingo's default Telegram Mini App Menu Button once on startup
    void defaultMenuButtonConfigurator.ensureConfiguredOnce({
      botToken: resolveConfiguredBotToken(),
      miniAppUrl: miniAppLaunchUrl,
    });
  });
}

startServer();
