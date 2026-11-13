import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCliOption(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  const prefix = `${flag}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function startServer() {
  const app = express();
  const cliPortRaw = parseCliOption('--port');
  const cliPort = cliPortRaw ? Number(cliPortRaw) : NaN;
  const PORT =
    Number.isFinite(cliPort) && cliPort > 0
      ? cliPort
      : process.env.NODE_ENV === 'production'
        ? Number(process.env.PORT) || 3000
        : Number(process.env.DEFAULT_APP_PORT) || 3000;
  const HOST = parseCliOption('--host') || '0.0.0.0';

  const publicBaseUrl = (
    [process.env.PUBLIC_MINI_APP_URL, process.env.APP_URL].find(
      (candidate) =>
        typeof candidate === 'string' &&
        candidate.startsWith('https://') &&
        candidate !== 'MY_APP_URL' &&
        !candidate.includes('ais-dev-') &&
        !candidate.includes('ais-pre-')
    ) || DEFAULT_DEPLOYED_MINI_APP_URL
  ).replace(/\/+$/, '');
  const miniAppUrl = `${publicBaseUrl}/`;

  const botEngine = new AdeyBingoTelegramBotEngine(miniAppUrl);
  const gameAuthority = new ServerGameAuthority();

  // Seed default demo player profile in bot engine so outbox & profile queries work out of the box
  botEngine.handleIncomingUpdate({
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    lastName: 'Bikila',
    username: 'abebe_adey',
    firebaseUid: 'tg_uid_8842109',
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
      firebaseProjectId: process.env.VITE_FIREBASE_PROJECT_ID || 'gen-lang-client-0559010770',
      telegramBotTokenConfigured: hasBotToken,
      telegramWebhookSecretConfigured: hasWebhookSecret,
      miniAppUrl,
      webhookEndpointUrl: `${publicBaseUrl}/api/telegram/webhook`,
      mode: 'demo_sandbox',
    });
  });

  // 2. Trusted Backend Telegram Mini App initData Validator (HMAC-SHA256 + Replay Guard + Ownership)
  app.post('/api/telegram/validate-init-data', (req, res) => {
    const rawInitData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const allowEnvelope = Boolean(req.body?.envelope);
    const expectedTelegramUserId =
      typeof req.body?.expectedTelegramUserId === 'number'
        ? req.body.expectedTelegramUserId
        : undefined;
    const actionNonce =
      typeof req.body?.actionNonce === 'string' ? req.body.actionNonce : undefined;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

    const result = validateTelegramWebAppInitData(rawInitData, botToken, {
      maxAgeSeconds: 3600,
      expectedTelegramUserId,
      replayGuard: actionNonce ? defaultReplayGuard : undefined,
      actionNonce,
    });

    if (!result.valid) {
      const code =
        result.reason === 'missing_bot_token'
          ? 503
          : result.reason === 'replay_detected'
          ? 409
          : 401;
      res.status(allowEnvelope ? 200 : code).json({
        verified: false,
        statusCode: code,
        reason: result.reason,
        message:
          result.reason === 'missing_bot_token'
            ? 'TELEGRAM_BOT_TOKEN is not configured on the server environment.'
            : result.reason === 'missing_init_data'
            ? 'No Telegram WebApp initData was provided by the client.'
            : result.reason === 'replay_detected'
            ? 'Duplicate/replayed Telegram initData request blocked.'
            : result.reason === 'future_auth_date' || result.reason === 'expired_auth_date'
            ? 'Telegram initData auth_date is expired or invalid.'
            : 'Telegram initData cryptographic signature validation failed.',
      });
      return;
    }

    res.json({
      verified: true,
      statusCode: 200,
      telegramUser: result.telegramUser,
      authDate: result.authDate,
      dataCheckHash: result.dataCheckHash,
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

    const botResponse = botEngine.handleIncomingUpdate({
      updateId,
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
        : publicBaseUrl;
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

    const botResponse = botEngine.handleIncomingUpdate({
      updateId,
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

  app.listen(PORT, HOST, () => {
    console.log(`ADEYBINGO server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ADEYBINGO server:', err);
  process.exit(1);
});
