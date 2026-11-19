import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdeyBingoTelegramBotEngine,
  buildBotMainMenuMarkup,
  buildContextualInlineKeyboard,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  formatTelegramNotification,
  normalizeWebhookSecretForTelegram,
  sanitizeProductionMiniAppUrl,
  ServerGameAuthority,
  verifyWebhookSecretHeader,
} from './telegramBot';
import { generateDeterministicCard } from '../game/rules';

test('Part B & C: /start command defaults to Amharic, explains ADEYBINGO & privacy, and requests phone contact', () => {
  const bot = new AdeyBingoTelegramBotEngine('https://adeybingo.example.app');

  const res = bot.handleIncomingUpdate({
    updateId: 1001,
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    lastName: 'Bikila',
    username: 'abebe_adey',
    text: '/start',
  });

  assert.equal(res.ok, true);
  assert.equal(res.language, 'am');
  assert.equal(res.registrationStatus, 'pending_contact');
  assert.match(res.text, /🎱 እንኳን ወደ ADEYBINGO በደህና መጡ!/);
  assert.match(res.text, /ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ/);

  // Verify contact request button is present before verification
  const allButtons = (res.replyMarkup.keyboard || []).flat();
  const contactBtn = allButtons.find((b) => b.request_contact === true);
  assert.ok(contactBtn, 'Unverified player keyboard should include contact share button');

  // Verify all 10 required Amharic-first Main Menu buttons exist in keyboard
  const allButtonLabels = allButtons.map((b) => b.text);
  assert.ok(allButtonLabels.includes('🎱 ቢንጎ ይጫወቱ'));
  assert.ok(allButtonLabels.includes('💰 የእኔ ቦርሳ'));
  assert.ok(allButtonLabels.includes('➕ ገንዘብ ያስገቡ'));
  assert.ok(allButtonLabels.includes('💸 ገንዘብ ያውጡ'));
  assert.ok(allButtonLabels.includes('🎁 ጓደኞችን ይጋብዙ'));
  assert.ok(allButtonLabels.includes('🏆 የደረጃ ሰንጠረዥ'));
  assert.ok(allButtonLabels.includes('📜 የጨዋታ ታሪክ'));
  assert.ok(allButtonLabels.includes('👤 የእኔ መገለጫ'));
  assert.ok(allButtonLabels.includes('🆘 እገዛ'));
  assert.ok(allButtonLabels.includes('🌐 ቋንቋ'));

  // Verify Play Bingo launches the deployed Mini App URL
  const startPlayingBtn = allButtons.find((b) => b.text === '🎱 ቢንጎ ይጫወቱ');
  assert.equal(startPlayingBtn?.web_app?.url, 'https://adeybingo.example.app');
});

test('Part C: Contact verification rejects plain text and forwarded contacts, accepts sender-owned contact, and blocks duplicate accounts', () => {
  const bot = new AdeyBingoTelegramBotEngine();

  // 1. Start bot as user 8842109 bound to uid_abebe
  bot.handleIncomingUpdate({
    updateId: 2001,
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    firebaseUid: 'uid_abebe',
    text: '/start',
  });

  // 2. Sending a typed phone number in chat must be rejected as unverified
  const typedPhoneRes = bot.handleIncomingUpdate({
    updateId: 2002,
    senderTelegramId: 8842109,
    text: '+251911223344',
  });
  assert.equal(typedPhoneRes.ok, false);
  assert.equal(typedPhoneRes.securityCode, 'plain_text_phone_rejected');
  assert.equal(typedPhoneRes.registrationStatus, 'pending_contact');

  // 3. Forwarding another person's contact (contact.user_id !== senderTelegramId) must be rejected
  const spoofedContactRes = bot.handleIncomingUpdate({
    updateId: 2003,
    senderTelegramId: 8842109,
    contact: {
      phone_number: '+251911223344',
      first_name: 'OtherPerson',
      user_id: 9999999,
    },
  });
  assert.equal(spoofedContactRes.ok, false);
  assert.equal(spoofedContactRes.securityCode, 'contact_owner_mismatch');
  assert.equal(spoofedContactRes.registrationStatus, 'pending_contact');

  // 4. Sharing authentic contact where contact.user_id === senderTelegramId succeeds
  const validContactRes = bot.handleIncomingUpdate({
    updateId: 2004,
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    firebaseUid: 'uid_abebe',
    contact: {
      phone_number: '+251911223344',
      first_name: 'Abebe',
      user_id: 8842109,
    },
  });
  assert.equal(validContactRes.ok, true);
  assert.equal(validContactRes.registrationStatus, 'verified');
  assert.equal(validContactRes.profile?.phoneVerified, true);
  assert.equal(validContactRes.notificationQueued?.event, 'registration_success');

  // 5. Duplicate Telegram account registration attempt by a different Firebase UID is blocked
  const duplicateAttempt = bot.handleIncomingUpdate({
    updateId: 2005,
    senderTelegramId: 8842109,
    firstName: 'Attacker',
    firebaseUid: 'uid_different_account',
    text: '/start',
  });
  assert.equal(duplicateAttempt.ok, false);
  assert.equal(duplicateAttempt.registrationStatus, 'duplicate_blocked');
  assert.equal(duplicateAttempt.securityCode, 'duplicate_telegram_account');

  // 6. Replaying updateId 2004 is blocked
  const replayAttempt = bot.handleIncomingUpdate({
    updateId: 2004,
    senderTelegramId: 8842109,
    text: '/help',
  });
  assert.equal(replayAttempt.ok, false);
  assert.equal(replayAttempt.securityCode, 'replay_detected');
});

test('Part B & E: Bot commands (/help, /language, /support, /terms) and all 7 Amharic/English notification templates work accurately', () => {
  const bot = new AdeyBingoTelegramBotEngine();

  // Opening /language shows bilingual picker while keeping default 'am' until selected
  const langPrompt = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/language',
  });
  assert.equal(langPrompt.language, 'am');
  assert.match(langPrompt.text, /ቋንቋ ይምረጡ \/ Select Language/);
  const langOptions = (langPrompt.replyMarkup.inline_keyboard || [])
    .flat()
    .map((b) => b.callback_data);
  assert.ok(langOptions.includes('lang:am'));
  assert.ok(langOptions.includes('lang:en'));

  // Switch from default Amharic to English via lang:en callback
  const langSwitchEn = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    callbackData: 'lang:en',
  });
  assert.equal(langSwitchEn.language, 'en');
  assert.match(langSwitchEn.text, /switched to English/);
  const enMenuLabels = (langSwitchEn.replyMarkup.keyboard || []).flat().map((b) => b.text);
  assert.ok(enMenuLabels.includes('🎱 Play Bingo'));
  assert.ok(enMenuLabels.includes('💰 My Wallet'));
  assert.ok(enMenuLabels.includes('🌐 Language'));

  const helpEn = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/help',
  });
  assert.equal(helpEn.language, 'en');
  assert.match(helpEn.text, /ADEYBINGO Help & Command Guide/);

  // Switch back to Amharic via Amharic language button text
  const langSwitchAm = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '🇪🇹 አማርኛ',
  });
  assert.equal(langSwitchAm.language, 'am');
  assert.match(langSwitchAm.text, /ወደ አማርኛ ተቀይሯል/);

  const termsAm = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/terms',
  });
  assert.match(termsAm.text, /Demo Sandbox/);

  const supportAm = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/support',
  });
  assert.match(supportAm.text, /@AdeyBingoSupport/);

  // Verify all 7 notification templates in Amharic (default)
  const events = [
    'registration_success',
    'game_starting',
    'new_bingo_number',
    'game_completion',
    'winner_announcement',
    'referral_confirmation',
    'support_response',
  ] as const;

  for (const ev of events) {
    const formatted = formatTelegramNotification(ev, 'am', {
      playerName: 'አበበ',
      ballNumber: 14,
      winningCardId: 1,
    });
    assert.ok(formatted.title.length > 3, `Title for ${ev} should be non-empty`);
    assert.ok(formatted.body.length > 10, `Body for ${ev} should be non-empty`);
  }

  const menuMarkup = buildBotMainMenuMarkup('am', 'https://adeybingo.example.app', true);
  assert.equal(menuMarkup.keyboard?.length, 5);
});

test('Part A: ServerGameAuthority enforces host-only ball drawing, max 4 cards, card ownership, and server-authoritative winner verification', () => {
  const authority = new ServerGameAuthority();

  // 1. Unauthorized player (not host) cannot draw a ball
  const unauthDraw = authority.drawNextBallAuthoritative({
    roomId: 'adey-main',
    callerTelegramId: 5555555,
    requestNonce: 'draw-unauth-1',
  });
  assert.equal(unauthDraw.ok, false);
  assert.equal(unauthDraw.reason, 'unauthorized_caller');

  // 2. Host can draw a ball, and replaying the same nonce is rejected
  const validDraw = authority.drawNextBallAuthoritative({
    roomId: 'adey-main',
    callerTelegramId: 8842109,
    requestNonce: 'draw-host-1',
  });
  assert.equal(validDraw.ok, true);
  assert.ok(validDraw.ball && validDraw.ball >= 1 && validDraw.ball <= 75);

  const replayDraw = authority.drawNextBallAuthoritative({
    roomId: 'adey-main',
    callerTelegramId: 8842109,
    requestNonce: 'draw-host-1',
  });
  assert.equal(replayDraw.ok, false);
  assert.equal(replayDraw.reason, 'replay_detected');

  // 3. Another player cannot claim a win on Card #1 (owned by 8842109)
  const hijackWin = authority.verifyWinnerAuthoritative({
    roomId: 'adey-main',
    claimantTelegramId: 7777777,
    playerName: 'Spoofer',
    cardId: 1,
    markedNumbers: [9, 30, 7, 16, 14],
  });
  assert.equal(hijackWin.verified, false);
  assert.equal(hijackWin.reason, 'card_not_owned_by_claimant');

  // 4. Owner cannot claim a win with uncalled numbers even if marked on client
  const card1 = generateDeterministicCard(1);
  const topRow = card1.grid[0];
  const fakeWin = authority.verifyWinnerAuthoritative({
    roomId: 'adey-main',
    claimantTelegramId: 8842109,
    playerName: 'Abebe',
    cardId: 1,
    markedNumbers: topRow,
    enforceServerCallsOnly: true,
  });
  assert.equal(fakeWin.verified, false);
  assert.equal(fakeWin.reason, 'pattern_not_satisfied');
});

test('Webhook secret normalization and constant-time header verification', () => {
  const sampleBase64Secret = 'abc+def/ghi==';
  const normalized = normalizeWebhookSecretForTelegram(sampleBase64Secret);
  assert.match(normalized, /^[A-Za-z0-9_-]{1,256}$/);
  assert.equal(normalized, 'abc-def_ghi');

  // Accepts both normalized and raw header values in constant time
  assert.equal(verifyWebhookSecretHeader(normalized, sampleBase64Secret), true);
  assert.equal(verifyWebhookSecretHeader(sampleBase64Secret, sampleBase64Secret), true);
  assert.equal(verifyWebhookSecretHeader('wrong_secret', sampleBase64Secret), false);
  assert.equal(verifyWebhookSecretHeader(undefined, sampleBase64Secret), false);
});

test('Milestone 4 & 5: Contextual inline callbacks, duplicate callbackQueryId protection, and player-bot admin isolation', () => {
  const bot = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');

  // 1. /start initializes user and includes contextual welcome inline_keyboard
  const startRes = bot.handleIncomingUpdate({
    updateId: 4001,
    senderTelegramId: 7777777,
    firstName: 'Dawit',
    username: 'dawit_m',
    text: '/start',
  });
  assert.equal(startRes.ok, true);
  const inlineFlat = (startRes.replyMarkup.inline_keyboard || []).flat();
  const inlineCallbacks = inlineFlat.map((b) => b.callback_data).filter(Boolean);
  assert.ok(inlineFlat.some((b) => b.web_app?.url === 'https://adebingo-3nta.vercel.app/'));
  assert.ok(inlineCallbacks.includes('cb:my_wallet'));
  assert.ok(inlineCallbacks.includes('cb:invite_friends'));
  assert.ok(inlineCallbacks.includes('cb:leaderboard'));
  assert.ok(inlineCallbacks.includes('cb:language'));

  // 2. Test interactive callbacks
  const playCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-1',
    senderTelegramId: 7777777,
    callbackData: 'cb:play_bingo',
  });
  assert.equal(playCb.ok, true);
  assert.ok(
    (playCb.replyMarkup.inline_keyboard || [])
      .flat()
      .some((b) => b.web_app?.url === 'https://adebingo-3nta.vercel.app/')
  );

  const walletCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-2',
    senderTelegramId: 7777777,
    callbackData: 'cb:my_wallet',
  });
  assert.equal(walletCb.ok, true);
  assert.match(walletCb.text, /15\.00 ETB/);

  const inviteCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-3',
    senderTelegramId: 7777777,
    callbackData: 'cb:invite_friends',
  });
  assert.equal(inviteCb.ok, true);
  assert.match(inviteCb.text, /ADEY-7777777/);

  const profileCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-4',
    senderTelegramId: 7777777,
    callbackData: 'cb:my_profile',
  });
  assert.equal(profileCb.ok, true);
  assert.match(profileCb.text, /Dawit/);

  const historyCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-5',
    senderTelegramId: 7777777,
    callbackData: 'cb:game_history',
  });
  assert.equal(historyCb.ok, true);
  assert.match(historyCb.text, /የጨዋታ ታሪክ|Game History/);
  assert.doesNotMatch(historyCb.text, /#G-4821/);

  const supportCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-6',
    senderTelegramId: 7777777,
    callbackData: 'cb:support',
  });
  assert.equal(supportCb.ok, true);
  assert.match(supportCb.text, /@AdeyBingoSupport/);

  const langPromptCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-6b',
    senderTelegramId: 7777777,
    callbackData: 'cb:language',
  });
  assert.equal(langPromptCb.ok, true);
  assert.match(langPromptCb.text, /ቋንቋ ይምረጡ/);

  const langCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-7',
    senderTelegramId: 7777777,
    callbackData: 'lang:en',
  });
  assert.equal(langCb.ok, true);
  assert.equal(langCb.language, 'en');
  assert.equal(bot.getLanguage(7777777), 'en');

  // 3. Duplicate callback query protection (replaying cbq-2 must be rejected)
  const duplicateCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-2',
    senderTelegramId: 7777777,
    callbackData: 'cb:my_wallet',
  });
  assert.equal(duplicateCb.ok, false);
  assert.equal(duplicateCb.securityCode, 'duplicate_callback_query');

  // 4. Normal users cannot invoke admin functions in the player bot
  const adminAttempt = bot.handleIncomingUpdate({
    senderTelegramId: 7777777,
    text: '/admin',
  });
  assert.equal(adminAttempt.ok, false);
  assert.equal(adminAttempt.securityCode, 'admin_command_forbidden_in_player_bot');
});

test('Milestone 5: Deposit, Withdraw, Referral deep-link, Leaderboard, and persistent language across /start', () => {
  const bot = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');

  // 1. Inviter starts first
  bot.handleIncomingUpdate({
    updateId: 5001,
    senderTelegramId: 8842109,
    firstName: 'Abebe',
    text: '/start',
  });

  // 2. Invitee joins using /start ADEY-8842109 -> starts in Amharic with 15 ETB initial credit; inviter earns +20 ETB (35 ETB)
  const inviteeStart = bot.handleIncomingUpdate({
    updateId: 5002,
    senderTelegramId: 999111,
    firstName: 'Meron',
    text: '/start ADEY-8842109',
  });
  assert.equal(inviteeStart.language, 'am');
  assert.equal(inviteeStart.profile?.demoBalanceEtb, 15);
  assert.equal(bot.getPlayerByTelegramId(8842109)?.demoBalanceEtb, 35);

  // Self-referral or duplicate referral claim does not grant extra bonus
  const dupRefStart = bot.handleIncomingUpdate({
    updateId: 5003,
    senderTelegramId: 999111,
    text: '/start ADEY-8842109',
  });
  assert.equal(dupRefStart.profile?.demoBalanceEtb, 15);
  assert.equal(bot.getPlayerByTelegramId(8842109)?.demoBalanceEtb, 35);

  const selfRefStart = bot.handleIncomingUpdate({
    updateId: 5004,
    senderTelegramId: 555222,
    firstName: 'Kaleb',
    text: '/start ADEY-555222',
  });
  assert.equal(selfRefStart.profile?.demoBalanceEtb, 15);

  // 3. Deposit flow: select method & quick amount -> request status
  bot.handleIncomingUpdate({
    updateId: 5005,
    senderTelegramId: 999111,
    text: '➕ ገንዘብ ያስገቡ',
  });
  bot.handleIncomingUpdate({
    updateId: 5006,
    senderTelegramId: 999111,
    callbackData: 'cb:deposit_method:telebirr',
  });
  const depConfirm = bot.handleIncomingUpdate({
    updateId: 5007,
    senderTelegramId: 999111,
    callbackData: 'cb:deposit_amount:200',
  });
  assert.equal(depConfirm.ok, true);
  assert.equal(depConfirm.securityCode, 'deposit_request_created');
  assert.match(depConfirm.text, /Telebirr \(Demo\)/);

  // 4. Withdraw flow: blocks amount exceeding balance, accepts valid amount
  bot.handleIncomingUpdate({
    updateId: 5008,
    senderTelegramId: 999111,
    callbackData: 'cb:withdraw_method:cbe_birr',
  });
  const overWithdraw = bot.handleIncomingUpdate({
    updateId: 5009,
    senderTelegramId: 999111,
    text: '9999',
  });
  assert.equal(overWithdraw.ok, false);
  assert.equal(overWithdraw.securityCode, 'insufficient_demo_balance');

  // Credit verified deposit before testing 100 ETB withdrawal (new account starts with 15 ETB)
  const p999 = bot.getPlayerByTelegramId(999111);
  if (p999) p999.demoBalanceEtb = 215;

  const validWithdraw = bot.handleIncomingUpdate({
    updateId: 5010,
    senderTelegramId: 999111,
    callbackData: 'cb:withdraw_amount:100',
  });
  assert.equal(validWithdraw.ok, true);
  assert.equal(validWithdraw.securityCode, 'withdraw_request_created');

  // 5. Leaderboard reflects real recorded wins (empty first, then ranked)
  const emptyLb = bot.handleIncomingUpdate({
    updateId: 5011,
    senderTelegramId: 999111,
    text: '🏆 የደረጃ ሰንጠረዥ',
  });
  assert.equal(emptyLb.ok, true);
  assert.equal(emptyLb.securityCode, 'callback_leaderboard');

  bot.recordCompletedGameWin({
    telegramUserId: 999111,
    gameId: 'game-m5-lb-1',
    roomNameAm: 'አደይ ዋና አዳራሽ',
    roomNameEn: 'Adey Main Hall',
    prizeEtb: 120,
    cardId: 7,
    pattern: 'Diagonal',
  });
  const populatedLb = bot.handleIncomingUpdate({
    updateId: 5012,
    senderTelegramId: 999111,
    callbackData: 'cb:leaderboard',
  });
  assert.match(populatedLb.text, /Meron/);
  assert.match(populatedLb.text, /120/);

  // 6. Language choice persists across subsequent /start
  bot.handleIncomingUpdate({
    updateId: 5013,
    senderTelegramId: 999111,
    callbackData: 'lang:en',
  });
  const restartEn = bot.handleIncomingUpdate({
    updateId: 5014,
    senderTelegramId: 999111,
    text: '/start',
  });
  assert.equal(restartEn.language, 'en');
  assert.match(restartEn.text, /Welcome to ADEYBINGO/);
});

test('Security Fix: Google AI Studio preview URLs (ais-pre-*, ais-dev-*, *.run.app) are rejected and replaced with https://adebingo-3nta.vercel.app/', () => {
  const leakedPreviewUrl = 'https://ais-pre-evydgg3zevudzz52jzdy5u-529287111346.europe-west1.run.app';
  const leakedDevUrl = 'https://ais-dev-evydgg3zevudzz52jzdy5u-529287111346.europe-west1.run.app';
  const staleVercelPreviewUrl = 'https://adebingo-git-old-branch-preview.vercel.app';

  assert.equal(sanitizeProductionMiniAppUrl(leakedPreviewUrl), DEFAULT_DEPLOYED_MINI_APP_URL);
  assert.equal(sanitizeProductionMiniAppUrl(leakedDevUrl), DEFAULT_DEPLOYED_MINI_APP_URL);
  assert.equal(sanitizeProductionMiniAppUrl(staleVercelPreviewUrl), DEFAULT_DEPLOYED_MINI_APP_URL);
  assert.equal(sanitizeProductionMiniAppUrl('https://accounts.google.com/v3/signin'), DEFAULT_DEPLOYED_MINI_APP_URL);
  assert.equal(sanitizeProductionMiniAppUrl('https://adebingo-3nta.vercel.app/'), 'https://adebingo-3nta.vercel.app/');
  assert.equal(sanitizeProductionMiniAppUrl('https://adebingo-3nta.vercel.app'), 'https://adebingo-3nta.vercel.app/');

  const botWithLeakedUrl = new AdeyBingoTelegramBotEngine(leakedPreviewUrl);

  const startRes = botWithLeakedUrl.handleIncomingUpdate({
    updateId: 6001,
    senderTelegramId: 444555,
    firstName: 'Selam',
    text: '/start',
  });

  const replyKbButtons = (startRes.replyMarkup.keyboard || []).flat();
  const playBingoReplyBtn = replyKbButtons.find((b) => b.web_app);
  assert.equal(playBingoReplyBtn?.web_app?.url, 'https://adebingo-3nta.vercel.app/');

  const inlineKbButtons = (startRes.replyMarkup.inline_keyboard || []).flat();
  const playBingoInlineBtn = inlineKbButtons.find((b) => b.web_app);
  assert.equal(playBingoInlineBtn?.web_app?.url, 'https://adebingo-3nta.vercel.app/');

  const directInline = buildContextualInlineKeyboard('welcome', 'am', leakedPreviewUrl).flat();
  assert.equal(directInline.find((b) => b.web_app)?.web_app?.url, 'https://adebingo-3nta.vercel.app/');
});



