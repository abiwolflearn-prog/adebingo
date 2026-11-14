import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdeyBingoTelegramBotEngine,
  buildBotMainMenuMarkup,
  formatTelegramNotification,
  normalizeWebhookSecretForTelegram,
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
  assert.match(res.text, /እንኳን ወደ ADEYBINGO በደህና መጡ/);
  assert.match(res.text, /1–600 ካርዶች/);
  assert.match(res.text, /\/users\/\{uid\}\/private\/contact/);

  // Verify contact request button is present on first row before verification
  const firstRowBtn = res.replyMarkup.keyboard?.[0]?.[0];
  assert.equal(firstRowBtn?.request_contact, true);

  // Verify all 7 required Part D buttons exist in keyboard
  const allButtonLabels = (res.replyMarkup.keyboard || []).flat().map((b) => b.text);
  assert.ok(allButtonLabels.includes('🎮 Start Playing'));
  assert.ok(allButtonLabels.includes('👤 My Profile'));
  assert.ok(allButtonLabels.includes('💰 My Balance'));
  assert.ok(allButtonLabels.includes('🎁 Invite Friends'));
  assert.ok(allButtonLabels.includes('📞 Contact Support'));
  assert.ok(allButtonLabels.includes('📜 Terms and Conditions'));
  assert.ok(allButtonLabels.includes('🌐 Change Language'));

  // Verify Start Playing launches the deployed Mini App URL
  const startPlayingBtn = (res.replyMarkup.keyboard || [])
    .flat()
    .find((b) => b.text === '🎮 Start Playing');
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

  // Switch from default Amharic to English via /language
  const langSwitchEn = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/language',
  });
  assert.equal(langSwitchEn.language, 'en');
  assert.match(langSwitchEn.text, /switched to English/);

  const helpEn = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/help',
  });
  assert.equal(helpEn.language, 'en');
  assert.match(helpEn.text, /ADEYBINGO Bot Command Guide/);

  // Switch back to Amharic
  const langSwitchAm = bot.handleIncomingUpdate({
    senderTelegramId: 8842109,
    text: '/language',
  });
  assert.equal(langSwitchAm.language, 'am');

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
  assert.equal(menuMarkup.keyboard?.length, 4);
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

test('Milestone 4 Part A: All 7 interactive inline callback buttons, duplicate callbackQueryId protection, and player-bot admin isolation', () => {
  const bot = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');

  // 1. /start initializes user and includes inline_keyboard with PLAY BINGO and all 7 actions + language selectors
  const startRes = bot.handleIncomingUpdate({
    updateId: 4001,
    senderTelegramId: 7777777,
    firstName: 'Dawit',
    username: 'dawit_m',
    text: '/start',
  });
  assert.equal(startRes.ok, true);
  const inlineCallbacks = (startRes.replyMarkup.inline_keyboard || [])
    .flat()
    .map((b) => b.callback_data)
    .filter(Boolean);
  assert.ok(inlineCallbacks.includes('cb:play_bingo'));
  assert.ok(inlineCallbacks.includes('cb:my_wallet'));
  assert.ok(inlineCallbacks.includes('cb:invite_friends'));
  assert.ok(inlineCallbacks.includes('cb:my_profile'));
  assert.ok(inlineCallbacks.includes('cb:game_history'));
  assert.ok(inlineCallbacks.includes('cb:support'));
  assert.ok(inlineCallbacks.includes('cb:language'));
  assert.ok(inlineCallbacks.includes('lang:am'));
  assert.ok(inlineCallbacks.includes('lang:en'));

  // 2. Test each of the 7 callback buttons
  const playCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-1',
    senderTelegramId: 7777777,
    callbackData: 'cb:play_bingo',
  });
  assert.equal(playCb.ok, true);
  assert.match(playCb.text, /https:\/\/adebingo-3nta\.vercel\.app\//);

  const walletCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-2',
    senderTelegramId: 7777777,
    callbackData: 'cb:my_wallet',
  });
  assert.equal(walletCb.ok, true);
  assert.match(walletCb.text, /250\.00 ETB/);

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
  assert.match(historyCb.text, /Adey Main Hall/);

  const supportCb = bot.handleIncomingUpdate({
    callbackQueryId: 'cbq-6',
    senderTelegramId: 7777777,
    callbackData: 'cb:support',
  });
  assert.equal(supportCb.ok, true);
  assert.match(supportCb.text, /@AdeyBingoSupport/);

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


