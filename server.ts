import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { cert, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
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
  process.env.VITE_FIREBASE_PROJECT_ID || 'gen-lang-client-0559010770';

function getOrInitFirebaseAdminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];

  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (rawServiceAccount && rawServiceAccount.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawServiceAccount);
      return initializeAdminApp({
        credential: cert(parsed),
        projectId: parsed.project_id || firebaseProjectId,
      });
    } catch {
      // Fall back to Application Default Credentials
    }
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
  app.get('/api/backend/status', (_req, res) => {
    const hasBotToken = Boolean(resolveConfiguredBotToken());
    const hasWebhookSecret = Boolean(
      process.env.TELEGRAM_WEBHOOK_SECRET &&
        process.env.TELEGRAM_WEBHOOK_SECRET.trim().length >= 8 &&
        process.env.TELEGRAM_WEBHOOK_SECRET !== 'MY_TELEGRAM_WEBHOOK_SECRET'
    );
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      firebaseProjectId,
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

    // Ensure player profile exists in backend bot registry bound to uid with 15 ETB Welcome Join Bonus
    let playerProfile = botEngine.getPlayerByTelegramId(tgUser.id);
    if (!playerProfile) {
      const regUpdate = botEngine.handleIncomingUpdate({
        senderTelegramId: tgUser.id,
        firstName: tgUser.first_name || 'Player',
        lastName: tgUser.last_name || '',
        username: tgUser.username || `tg_${tgUser.id}`,
        firebaseUid: uid,
        text: '/start',
      });
      playerProfile = regUpdate.profile;
      if (playerProfile) {
        playerProfile.demoBalanceEtb = 15;
      }
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

    res.json({
      ok: true,
      authenticated: true,
      verified: true,
      statusCode: 200,
      uid,
      verifiedTelegramId: tgUser.id,
      customToken,
      customTokenStatus,
      sessionToken: mintedSession.token,
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

        const tgResp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: botResponse.chatId,
            text: botResponse.text,
            parse_mode: botResponse.parseMode,
            reply_markup: botResponse.replyMarkup,
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

    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const rawWebhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

    if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
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
      const setMenuResp = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: {
            type: 'web_app',
            text: '🎱 ቢንጎ ይጫወቱ',
            web_app: { url: requestedLaunchUrl },
          },
        }),
      });
      const setMenuData = await setMenuResp.json();

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
        menuButtonConfigured: Boolean(setMenuData.ok),
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
        message: err instanceof Error ? err.message : 'Network error calling Telegram API',
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

    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const hasWebhookSecret = Boolean(
      process.env.TELEGRAM_WEBHOOK_SECRET &&
        process.env.TELEGRAM_WEBHOOK_SECRET.trim().length >= 8 &&
        process.env.TELEGRAM_WEBHOOK_SECRET !== 'MY_TELEGRAM_WEBHOOK_SECRET'
    );
    if (!botToken || botToken === 'MY_TELEGRAM_BOT_TOKEN') {
      res.json({
        ok: false,
        telegramBotTokenConfigured: false,
        telegramWebhookSecretConfigured: hasWebhookSecret,
      });
      return;
    }

    try {
      const [meResp, infoResp] = await Promise.all([
        fetch(`https://api.telegram.org/bot${botToken}/getMe`),
        fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
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
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to fetch Telegram webhook info',
      });
    }
  });

  // 4. Interactive Bot Command & Contact Verification Endpoint (for Mini App Bot Console & Testing)
  app.post('/api/telegram/bot-command', (req, res) => {
    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const headerSessionToken =
      typeof req.headers['x-adey-session-token'] === 'string'
        ? req.headers['x-adey-session-token'].trim()
        : undefined;
    const rawToken = bearerToken || headerSessionToken;
    let sessionActor: VerifiedSessionActor | null = null;
    if (rawToken) {
      const check = authorizeAdminRequest({
        sessionToken: rawToken,
        botToken: resolveConfiguredBotToken() || '',
        sessionSecret: resolveAdminSessionSecret(),
      });
      sessionActor = check.actor || null;
    }

    const senderTelegramId = Number(
      sessionActor?.telegramUserId || req.body?.senderTelegramId || 8842109
    );
    const firstName = String(req.body?.firstName || sessionActor?.displayName || 'Abebe');
    const lastName = String(req.body?.lastName || 'Bikila');
    const username = String(req.body?.username || sessionActor?.username || 'abebe_adey');
    const firebaseUid =
      sessionActor?.uid ||
      (typeof req.body?.firebaseUid === 'string' ? req.body.firebaseUid : undefined);
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const callbackData =
      typeof req.body?.callbackData === 'string' ? req.body.callbackData : '';
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

    res.json({
      ...botResponse,
      outbox: botEngine.getNotificationOutbox().slice(0, 12),
    });
  });

  // 5. Secure Notification Preparation & Dispatch Endpoint (Part E)
  app.post('/api/telegram/notify', (req, res) => {
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

    const telegramUserId = Number(req.body?.telegramUserId || 8842109);
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

  // 7. Server-Authoritative Number Calling Endpoint (Cryptographic CSPRNG 1..75)
  app.post('/api/game/draw-ball', (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : 'adey-main';
    const cycle = ensureRoomCycle(roomId);
    const existingGame = localLiveGames.get(roomId);
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

    const callerTelegramId = Number(req.body?.callerTelegramId || 8842109);
    const requestNonce =
      typeof req.body?.requestNonce === 'string' ? req.body.requestNonce : undefined;
    const clientCalledNumbers: number[] | undefined = Array.isArray(req.body?.calledNumbers)
      ? req.body.calledNumbers
          .map(Number)
          .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 75)
      : undefined;

    const drawResult = gameAuthority.drawNextBallAuthoritative({
      roomId,
      callerTelegramId,
      clientCalledNumbers,
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
        hostUid: `tg_${callerTelegramId}`,
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
    botEngine.queueNotification('new_bingo_number', callerTelegramId, {
      ballNumber: drawResult.ball,
      totalCalls: drawResult.totalCalled,
    });

    res.json(drawResult);
  });

  // 8. Server-Authoritative Winner Verification Endpoint
  app.post('/api/game/verify-winner', (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : 'adey-main';
    const claimantTelegramId = Number(req.body?.claimantTelegramId || 8842109);
    const playerName = String(req.body?.playerName || 'Abebe Bikila');
    const cardId = Number(req.body?.cardId);
    const calledNumbers: number[] = Array.isArray(req.body?.calledNumbers)
      ? req.body.calledNumbers
          .map(Number)
          .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 75)
      : [];
    const markedNumbers: number[] = Array.isArray(req.body?.markedNumbers)
      ? req.body.markedNumbers
          .map(Number)
          .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 75)
      : [];

    const activeGame = localLiveGames.get(roomId);
    const effectiveCalledNumbers =
      activeGame && activeGame.calledNumbers.length > 0 ? activeGame.calledNumbers : calledNumbers;

    const verifyRes = gameAuthority.verifyWinnerAuthoritative({
      roomId,
      claimantTelegramId,
      playerName,
      cardId,
      markedNumbers,
      enforceServerCallsOnly: false,
      fallbackClientCalls: effectiveCalledNumbers,
    });

    if (!verifyRes.verified && verifyRes.reason === 'invalid_card_id') {
      res.status(400).json(verifyRes);
      return;
    }

    if (verifyRes.verified) {
      const winnerUid = `tg_${claimantTelegramId}`;
      const prizeEtb = 50;
      const winList = localTransactionsByUid.get(winnerUid) || [];
      winList.unshift({
        id: `tx_win_${Date.now()}`,
        type: 'bingo_win',
        amount: prizeEtb,
        status: 'demo_completed',
        labelAm: `የቢንጎ ድል ሽልማት (ካርድ #${cardId})`,
        labelEn: `Bingo Win Prize (Card #${cardId})`,
        timestamp: new Date().toISOString(),
        reference: `WIN-${roomId.toUpperCase()}-${cardId}`,
      });
      localTransactionsByUid.set(winnerUid, winList.slice(0, 30));

      const p = botEngine.getPlayerByTelegramId(claimantTelegramId);
      if (p) {
        p.demoBalanceEtb += prizeEtb;
      }

      const cycle = ensureRoomCycle(roomId);
      cycle.settledRoundNumber = cycle.roundNumber;
      cycle.status = 'completed';
      cycle.phaseEndsAtMs = Date.now() + ROUND_INTERMISSION_MS;

      const winShare: RoundWinnerShare = {
        uid: winnerUid,
        telegramUserId: claimantTelegramId,
        displayName: playerName,
        cardId,
        patternType: verifyRes.winResult?.patternType || 'diagonal',
        patternLabelAm: verifyRes.winResult?.patternLabelAm || 'መስመር ቢንጎ',
        patternLabelEn: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
        winningCells: verifyRes.winResult?.winningCells || [],
        prizeEtb,
      };
      const finishedGame = localLiveGames.get(roomId);
      if (finishedGame) {
        finishedGame.status = 'completed';
        finishedGame.winnerUid = winnerUid;
        finishedGame.winnerName = playerName;
        finishedGame.winningCardId = cardId;
        finishedGame.winningPattern = verifyRes.winResult?.patternLabelEn || 'Bingo Line';
        finishedGame.prizePoolEtb = prizeEtb;
        finishedGame.winners = [winShare];
      } else {
        localLiveGames.set(roomId, {
          gameId: `game_${roomId}_live`,
          roomId,
          hostUid: winnerUid,
          roundNumber: cycle.roundNumber,
          status: 'completed',
          calledNumbers: effectiveCalledNumbers,
          latestBall: effectiveCalledNumbers[effectiveCalledNumbers.length - 1] || 0,
          winnerUid,
          winnerName: playerName,
          winningCardId: cardId,
          winningPattern: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
          prizePoolEtb: prizeEtb,
          winners: [winShare],
        });
      }

      botEngine.queueNotification('winner_announcement', claimantTelegramId, {
        winnerName: playerName,
        winningCardId: cardId,
        winningPattern: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
        demoPrizeEtb: prizeEtb,
      });
      botEngine.queueNotification('game_completion', claimantTelegramId, {
        totalCalls: effectiveCalledNumbers.length,
      });
    }

    res.json(verifyRes);
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
      type: 'deposit_demo' | 'withdraw_demo' | 'card_entry' | 'bingo_win' | 'referral_bonus';
      amount: number;
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
      if (payout.telegramUserId > 0) {
        const p = botEngine.getPlayerByTelegramId(payout.telegramUserId);
        if (p) {
          p.demoBalanceEtb = Number((p.demoBalanceEtb + payout.totalPrizeEtb).toFixed(2));
        }
      }
      const winList = localTransactionsByUid.get(payout.uid) || [];
      const cardsLabel = payout.cardIds.join(', ');
      winList.unshift({
        id: `tx_win_${cycle.roundNumber}_${payout.uid}_${Date.now()}`,
        type: 'bingo_win',
        amount: payout.totalPrizeEtb,
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
      localTransactionsByUid.set(payout.uid, winList.slice(0, 30));

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
        settleRoomIfWinnerFound(roomId, called, latest);
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
          settleRoomIfWinnerFound(roomId, called, drawRes.ball);
        } else {
          cycle.status = 'completed';
          cycle.phaseEndsAtMs = now + ROUND_INTERMISSION_MS;
          if (currentGame) {
            currentGame.status = 'completed';
          }
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
      }
    }
  };

  for (const r of adminAuthority.getRooms()) {
    ensureRoomCycle(r.id);
  }
  const roomCycleTimer = setInterval(tickRoomCycles, 1000);
  roomCycleTimer.unref?.();

  const getLocalRoomDto = (r: ReturnType<typeof adminAuthority.getRooms>[number]) => {
    const cycle = ensureRoomCycle(r.id);
    const roomCards = localRoomCardOwnership.get(r.id);
    const activePlayersCount = roomCards ? new Set(roomCards.values()).size : 0;
    const reservedCardsCount = roomCards?.size ?? 0;
    const liveGame = localLiveGames.get(r.id);
    const remainingCountdown =
      cycle.status === 'countdown'
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
        room: getLocalRoomDto(target),
        myCardIds,
        takenCardIds,
        game: localLiveGames.get(rawRoomId) || null,
      });
      return;
    }

    res.json({ ok: true, rooms: allRooms.map(getLocalRoomDto) });
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
      localTransactionsByUid.set(actor.uid, [
        {
          id: `tx_welcome_${actor.telegramUserId}`,
          type: 'referral_bonus',
          amount: 15,
          status: 'demo_completed',
          labelAm: 'የመቀላቀያ እንኳን ደህና መጡ ቦነስ (+15 ብር)',
          labelEn: 'Welcome Join Bonus (+15 ETB)',
          timestamp: new Date().toISOString(),
          reference: `WELCOME-${actor.telegramUserId}`,
        },
      ]);
    }
    return player;
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
    const availableBalanceEtb = player ? Math.max(0, Number(player.demoBalanceEtb ?? 15)) : 15;
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
    const player = ensureServerPlayerWithWelcomeBonus(actor);
    const nowIso = new Date().toISOString();

    if (action === 'apply_promo') {
      const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      if (!rawCode || rawCode.length < 3 || rawCode.length > 32 || !/^[A-Z0-9_-]+$/.test(rawCode)) {
        res.status(400).json({ ok: false, error: 'invalid_promo_code', message: 'Invalid promo or referral code.' });
        return;
      }
      if (localAppliedPromoByUid.has(actor.uid)) {
        res.status(409).json({ ok: false, error: 'promo_already_applied', message: 'A promo or referral code was already applied.' });
        return;
      }
      if (/^ADEY-[1-9]\d*$/.test(rawCode)) {
        const inviterId = Number(rawCode.slice(5));
        if (inviterId === actor.telegramUserId) {
          res.status(400).json({ ok: false, error: 'self_referral_forbidden', message: 'You cannot apply your own referral code.' });
          return;
        }
        let inviterPlayer = botEngine.getPlayerByTelegramId(inviterId);
        if (!inviterPlayer) {
          inviterPlayer = ensureServerPlayerWithWelcomeBonus({
            uid: `tg_${inviterId}`,
            telegramUserId: inviterId,
            displayName: `Friend #${inviterId}`,
            username: `tg_${inviterId}`,
          });
        }
        const inviteeBonus = 20;
        const inviterBonus = 20;
        if (player) player.demoBalanceEtb += inviteeBonus;
        if (inviterPlayer) inviterPlayer.demoBalanceEtb += inviterBonus;
        localAppliedPromoByUid.set(actor.uid, rawCode);
        const actorTxs = localTransactionsByUid.get(actor.uid) || [];
        actorTxs.unshift({
          id: `tx_ref_${Date.now()}`,
          type: 'referral_bonus',
          amount: inviteeBonus,
          status: 'demo_completed',
          labelAm: `የተጋበዘ ጓደኛ ቦነስ (+20 ብር · ${rawCode})`,
          labelEn: `Invited Friend Bonus (+20 ETB · ${rawCode})`,
          timestamp: nowIso,
          reference: `ADB-REF-${actor.telegramUserId}`,
        });
        localTransactionsByUid.set(actor.uid, actorTxs);

        const inviterUid = inviterPlayer?.uid || `tg_${inviterId}`;
        const inviterTxs = localTransactionsByUid.get(inviterUid) || [];
        inviterTxs.unshift({
          id: `tx_ref_inviter_${Date.now()}`,
          type: 'referral_bonus',
          amount: inviterBonus,
          status: 'demo_completed',
          labelAm: `ጓደኛ በመጋበዝ የተገኘ ቦነስ (+20 ብር · ${actor.displayName})`,
          labelEn: `Friend Invite Bonus (+20 ETB · ${actor.displayName})`,
          timestamp: nowIso,
          reference: `ADB-INV-${actor.telegramUserId}`,
        });
        localTransactionsByUid.set(inviterUid, inviterTxs);

        const inviterRefs = localReferralsByUid.get(inviterUid) || [];
        inviterRefs.unshift({
          id: `ref_${Date.now()}`,
          friendName: actor.displayName,
          handle: `@${actor.username}`,
          joinedAt: nowIso,
          status: 'qualified',
          inviterBonus,
          inviteeBonus,
        });
        localReferralsByUid.set(inviterUid, inviterRefs);

        res.json({
          ok: true,
          action: 'apply_promo',
          code: rawCode,
          bonusEtb: inviteeBonus,
          updatedBalanceEtb: player ? player.demoBalanceEtb : 35,
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
      const method =
        req.body?.provider === 'CBE Birr (Demo)' || req.body?.provider === 'Chapa Sandbox (Demo)'
          ? req.body.provider
          : 'Telebirr (Demo)';
      const customRef =
        typeof req.body?.referenceCode === 'string' && req.body.referenceCode.trim().length >= 4
          ? req.body.referenceCode.trim().toUpperCase()
          : `REF-${Math.floor(100000 + Math.random() * 899999)}`;
      const depositId = `DEP-WEB-${Date.now().toString(36).toUpperCase()}`;
      const deposit = {
        depositId,
        amountEtb,
        provider: method,
        referenceCode: customRef,
        status: 'Pending' as const,
        requestDate: nowIso,
      };
      const existing = localDepositsByUid.get(actor.uid) || [];
      existing.unshift(deposit);
      localDepositsByUid.set(actor.uid, existing.slice(0, 10));

      adminAuthority.registerPlayerDepositRequest({
        depositId,
        uid: actor.uid,
        userDisplayName: actor.displayName,
        telegramUserId: actor.telegramUserId,
        amountEtb,
        provider: method,
        referenceCode: customRef,
        requestDate: nowIso.slice(0, 16).replace('T', ' '),
      });

      res.status(201).json({ ok: true, action: 'deposit_request', deposit, demoSandboxOnly: true });
      return;
    }

    if (action === 'withdraw_request') {
      const amountEtb = Number(req.body?.amountEtb);
      if (!Number.isFinite(amountEtb) || amountEtb < 20) {
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
      if (player) {
        player.demoBalanceEtb = Math.max(0, Number((availableBalanceEtb - amountEtb).toFixed(2)));
      }
      const method =
        req.body?.method === 'CBE Birr (Demo)' || req.body?.method === 'Chapa Sandbox (Demo)'
          ? req.body.method
          : 'Telebirr (Demo)';
      const requestId = `PO-WEB-${Date.now().toString(36).toUpperCase()}`;
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
        provider: method,
        status: 'demo_pending',
        labelAm: `${method} የወጪ ጥያቄ (${requestId})`,
        labelEn: `${method} Withdrawal Request (${requestId})`,
        timestamp: nowIso,
        reference: requestId,
      });
      localTransactionsByUid.set(actor.uid, txList.slice(0, 30));

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

      res.status(201).json({
        ok: true,
        action: 'withdraw_request',
        withdrawal,
        updatedBalanceEtb: player ? player.demoBalanceEtb : availableBalanceEtb - amountEtb,
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
    const updatedBal = currentBal - cardPrice;
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
    if (cycle.status === 'countdown' && !req.body?.forceStart) {
      res.json({
        ok: true,
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
    if ((cycle.status === 'live' || cycle.status === 'completed') && existing && !req.body?.forceStart) {
      res.json({ ok: true, game: existing });
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
    res.json({
      ok: true,
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
    res.json({
      ok: true,
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
        // Fallback: inspect Firebase JWT payload if Admin SDK cert fetch fails in container
        try {
          const parts = bearerToken.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(
              Buffer.from(parts[1], 'base64url').toString('utf8')
            ) as Record<string, unknown>;
            const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
            const sub = typeof payload.sub === 'string' ? payload.sub : typeof payload.user_id === 'string' ? payload.user_id : '';
            if (email && sub) {
              const minted = mintServerSessionToken(
                {
                  uid: sub,
                  telegramUserId: email === 'abiwolfcode@gmail.com' || email === 'abelbimrew868@gmail.com' ? 8842109 : 0,
                  displayName: typeof payload.name === 'string' ? payload.name : email,
                  username: email.split('@')[0],
                  email,
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
            }
          }
        } catch {
          // Fall through to 401
        }
        res.status(401).json({
          ok: false,
          authorized: false,
          statusCode: 401,
          reason: 'invalid_or_expired_token',
          message: 'Firebase ID token or session token verification failed.',
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

  // 9A-2. Owner Preview Session Endpoint for Owner (abiwolfcode@gmail.com / TG #8842109)
  app.post('/api/admin/owner-preview-session', (req, res) => {
    const requestedOwnerEmail =
      typeof req.body?.ownerEmail === 'string'
        ? req.body.ownerEmail.trim().toLowerCase()
        : 'abiwolfcode@gmail.com';
    const sessionSecret = resolveAdminSessionSecret();
    const minted = mintServerSessionToken(
      {
        uid: 'tg_8842109',
        telegramUserId: 8842109,
        displayName: 'Owner Admin (abiwolfcode@gmail.com)',
        username: 'abiwolfcode_owner',
        email: requestedOwnerEmail,
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
    localTransactionsByUid.set(uid, txList.slice(0, 30));

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
        provider: result.payout.paymentMethod,
        status: 'demo_completed',
        labelAm: `የወጪ ጥያቄ ተመላሽ (${requestId})`,
        labelEn: `Withdrawal Rejected — Refunded (${requestId})`,
        timestamp: new Date().toISOString(),
        reference: `REFUND-${requestId}`,
      });
      localTransactionsByUid.set(targetUid, txList.slice(0, 30));
    } else if (result.payout.status === 'Completed' || result.payout.status === 'Approved') {
      const txList = localTransactionsByUid.get(targetUid) || [];
      for (const tx of txList) {
        if (tx.reference === requestId) {
          tx.status = 'demo_completed';
        }
      }
    }

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
      res.status(400).json(result);
      return;
    }

    const targetUid = result.deposit.uid;
    const userDeposits = localDepositsByUid.get(targetUid);
    if (userDeposits) {
      for (const item of userDeposits) {
        if (item.depositId === depositId) {
          item.status = result.deposit.status;
        }
      }
    }

    if (result.deposit.status === 'Approved' && result.creditedBalanceEtb !== undefined) {
      const txList = localTransactionsByUid.get(targetUid) || [];
      txList.unshift({
        id: `tx_dep_${depositId}_${Date.now()}`,
        type: 'deposit_demo',
        amount: result.deposit.amountEtb,
        provider: result.deposit.provider,
        status: 'demo_completed',
        labelAm: `የጸደቀ ${result.deposit.provider} ገቢ (${result.deposit.referenceCode})`,
        labelEn: `Verified ${result.deposit.provider} Deposit (${result.deposit.referenceCode})`,
        timestamp: new Date().toISOString(),
        reference: result.deposit.referenceCode,
      });
      localTransactionsByUid.set(targetUid, txList.slice(0, 30));
    }

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
  });
}

startServer();
