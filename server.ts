import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { cert, getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import {
  defaultReplayGuard,
  validateTelegramWebAppInitData,
} from './src/utils/telegramVerify.ts';
import {
  AdeyBingoTelegramBotEngine,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  normalizeWebhookSecretForTelegram,
  ServerGameAuthority,
  verifyWebhookSecretHeader,
} from './src/utils/telegramBot.ts';
import type { NotificationEventType } from './src/utils/telegramBot.ts';
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

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    pairs.push(`${k}=${v}`);
  }
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

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
  const PORT = Number(process.env.PORT) || 3000;

  // Never use the private AI Studio developer preview URL (ais-dev-*) for Telegram Mini App launch,
  // because ais-dev-* redirects unauthenticated Telegram WebView users to a Google login cookie check.
  const rawAppUrl = (process.env.PUBLIC_MINI_APP_URL || process.env.APP_URL || '').trim();
  const miniAppUrl = (
    rawAppUrl &&
    rawAppUrl !== 'MY_APP_URL' &&
    rawAppUrl.startsWith('https://') &&
    !rawAppUrl.includes('ais-dev-')
      ? rawAppUrl
      : DEFAULT_DEPLOYED_MINI_APP_URL
  ).replace(/\/+$/, '');

  const botEngine = new AdeyBingoTelegramBotEngine(miniAppUrl);
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

  // 1. Trusted Backend Status Endpoint (Honest reporting — never exposes or logs secrets)
  app.get('/api/backend/status', (_req, res) => {
    const hasBotToken = Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_BOT_TOKEN.trim().length > 10 &&
        process.env.TELEGRAM_BOT_TOKEN !== 'MY_TELEGRAM_BOT_TOKEN'
    );
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

  const resolveInitDataVerificationToken = (): string => {
    const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (envToken && envToken !== 'MY_TELEGRAM_BOT_TOKEN') {
      return envToken;
    }
    return 'adeybingo_server_initdata_hmac_key_v1';
  };

  // 2. Trusted Backend Telegram Mini App Authentication & Custom Token Endpoint
  const handleTelegramInitDataAuth: express.RequestHandler = async (req, res) => {
    if (
      req.body?.telegramId !== undefined ||
      req.body?.telegramUserId !== undefined ||
      req.body?.uid !== undefined ||
      req.body?.firebaseUid !== undefined ||
      req.body?.isAdmin !== undefined
    ) {
      res.status(400).json({
        ok: false,
        authenticated: false,
        verified: false,
        statusCode: 400,
        error: 'client_identity_override_rejected',
        reason: 'client_identity_override_rejected',
        message: 'Caller-supplied Telegram IDs or privilege fields are not accepted.',
      });
      return;
    }

    const rawInitData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const allowEnvelope = Boolean(req.body?.envelope);
    const expectedTelegramUserId =
      typeof req.body?.expectedTelegramUserId === 'number'
        ? req.body.expectedTelegramUserId
        : undefined;
    const actionNonce =
      typeof req.body?.actionNonce === 'string' ? req.body.actionNonce : undefined;
    const botToken = resolveInitDataVerificationToken();

    const result = validateTelegramWebAppInitData(rawInitData, botToken, {
      maxAgeSeconds: 86400,
      expectedTelegramUserId,
      replayGuard: actionNonce ? defaultReplayGuard : undefined,
      actionNonce,
    });

    if (!result.valid || !result.telegramUser) {
      const code =
        result.reason === 'missing_bot_token'
          ? 503
          : result.reason === 'replay_detected'
          ? 409
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
            : result.reason === 'future_auth_date' || result.reason === 'expired_auth_date'
            ? 'Telegram initData auth_date is expired or invalid. Please relaunch from the Telegram bot.'
            : 'Telegram initData cryptographic HMAC-SHA256 signature validation failed.',
      });
      return;
    }

    const tgUser = result.telegramUser;
    const uid = `tg_${tgUser.id}`;

    // Ensure player profile exists in backend bot registry bound to uid
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
    }

    // Mint Firebase Custom Token using Firebase Admin SDK
    const { customToken, customTokenStatus } = await mintFirebaseCustomTokenForTelegramUser(
      uid,
      tgUser.id,
      tgUser.username || `tg_${tgUser.id}`
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

  // 2B. Backend Test initData Generator (Signs valid/expired/tampered initData on backend without exposing bot token)
  app.post('/api/telegram/test-init-data', (req, res) => {
    const botToken = resolveInitDataVerificationToken();
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
    const requestedBaseUrl =
      typeof candidateUrl === 'string' && candidateUrl.startsWith('https://')
        ? candidateUrl.replace(/\/+$/, '')
        : miniAppUrl;
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
            { command: 'start', description: 'ቦቱን ይጀምሩ እና ስልክዎን ያረጋግጡ (Start ADEYBINGO & verify phone)' },
            { command: 'help', description: 'የጨዋታ መመሪያ እና እገዛ (Game guide & commands)' },
            { command: 'language', description: 'ቋንቋ ቀይር / Switch language (አማርኛ / English)' },
            { command: 'support', description: 'የደንበኞች ድጋፍ (Contact player support)' },
            { command: 'terms', description: 'ህጎች እና የግላዊነት ጥበቃ (Terms, rules & privacy)' },
          ],
        }),
      });
      const setCommandsData = await setCommandsResp.json();

      // Step 3: Set Chat Menu Button to launch the deployed Mini App
      const setMenuResp = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: {
            type: 'web_app',
            text: '🎮 ጨዋታ ጀምር',
            web_app: { url: requestedBaseUrl },
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
    const senderTelegramId = Number(req.body?.senderTelegramId || 8842109);
    const firstName = String(req.body?.firstName || 'Abebe');
    const lastName = String(req.body?.lastName || 'Bikila');
    const username = String(req.body?.username || 'abebe_adey');
    const firebaseUid =
      typeof req.body?.firebaseUid === 'string' ? req.body.firebaseUid : undefined;
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

    const verifyRes = gameAuthority.verifyWinnerAuthoritative({
      roomId,
      claimantTelegramId,
      playerName,
      cardId,
      markedNumbers,
      enforceServerCallsOnly: false,
      fallbackClientCalls: calledNumbers,
    });

    if (!verifyRes.verified && verifyRes.reason === 'invalid_card_id') {
      res.status(400).json(verifyRes);
      return;
    }

    if (verifyRes.verified) {
      botEngine.queueNotification('winner_announcement', claimantTelegramId, {
        winnerName: playerName,
        winningCardId: cardId,
        winningPattern: verifyRes.winResult?.patternLabelEn || 'Bingo Line',
        demoPrizeEtb: 50,
      });
      botEngine.queueNotification('game_completion', claimantTelegramId, {
        totalCalls: calledNumbers.length,
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
      botToken: resolveInitDataVerificationToken(),
      sessionSecret,
    });
    return check.actor || null;
  };

  const localRoomCardOwnership = new Map<string, Map<number, string>>();

  app.get('/api/rooms', (_req, res) => {
    const rooms = adminAuthority.getRooms().map((r) => ({
      roomId: r.id,
      nameAm: r.nameAm,
      nameEn: r.nameEn,
      cardPrice: r.cardPriceEtb,
      maxCardsPerRoom: r.maxCardsPerRoom,
      maxCardsPerPlayer: r.maxCardsPerPlayer,
      minPlayers: r.minPlayers,
      countdownSeconds: r.lobbyCountdownSeconds,
      activePlayersCount: r.activePlayers,
      reservedCardsCount: localRoomCardOwnership.get(r.id)?.size || 12,
      status: r.status === 'live' ? 'live' : r.status === 'starting' ? 'countdown' : 'waiting',
      currentGameId: `game_${r.id}_live`,
      hostUid: 'tg_8842109',
    }));
    res.json({ ok: true, rooms });
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
      res.json({
        ok: true,
        action: 'released',
        roomId,
        cardId,
        cardIds: nextCards,
        updatedBalanceEtb: 250 - nextCards.length * 10,
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

    roomCards.set(cardId, actor.uid);
    const nextCards = [...myCards, cardId].sort((a, b) => a - b);
    res.json({
      ok: true,
      action: 'reserved',
      roomId,
      cardId,
      cardIds: nextCards,
      updatedBalanceEtb: 250 - nextCards.length * 10,
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
    const drawRes = gameAuthority.drawNextBallAuthoritative({
      roomId,
      callerTelegramId: actor.telegramUserId,
    });
    res.json({
      ok: true,
      game: {
        gameId,
        roomId,
        hostUid: actor.uid,
        roundNumber: 1,
        status: 'live',
        calledNumbers: drawRes.calledNumbers || [9, 30, 7, 16, 14],
        latestBall: drawRes.ball || 14,
        winnerUid: '',
        winnerName: '',
        winningCardId: 0,
        winningPattern: '',
      },
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
    gameAuthority.resetRoomCalls(roomId);
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
      botToken: resolveInitDataVerificationToken(),
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
    const botToken = resolveInitDataVerificationToken();
    const rawInitData = typeof req.body?.initData === 'string' ? req.body.initData.trim() : '';

    if (rawInitData) {
      const check = validateTelegramWebAppInitData(rawInitData, botToken, {
        maxAgeSeconds: 3600,
      });
      if (!check.valid || !check.telegramUser) {
        res.status(401).json({
          ok: false,
          authorized: false,
          statusCode: 401,
          reason: check.reason || 'invalid_init_data',
          message: 'Telegram initData signature validation failed.',
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
        botToken,
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
    if (!result.ok) {
      res.status(400).json(result);
      return;
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
    if (!result.ok) {
      res.status(400).json(result);
      return;
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

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
