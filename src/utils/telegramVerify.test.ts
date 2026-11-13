import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  TelegramReplayGuard,
  validateTelegramWebAppInitData,
  verifyTelegramSharedContact,
} from './telegramVerify';

function buildSignedInitData(
  botToken: string,
  authDate: number,
  userObj: Record<string, unknown> = {
    id: 8842109,
    first_name: 'Abebe',
    last_name: 'Bikila',
    username: 'abebe_adey',
    language_code: 'am',
  },
  queryId = 'AAHdF6IQAAAAAN0XohDhrOrc'
): string {
  const userPayload = JSON.stringify(userObj);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', queryId);
  params.set('user', userPayload);

  const pairs: string[] = [];
  params.forEach((value, key) => {
    pairs.push(`${key}=${value}`);
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('validateTelegramWebAppInitData verifies authentic HMAC-SHA256 signatures and rejects tampering', () => {
  const testBotToken = '123456789:AAExampleTelegramBotSecretToken99';
  const nowSec = 1710000000;
  const signedInitData = buildSignedInitData(testBotToken, nowSec - 60);

  // 1. Valid signature & fresh auth_date
  const validRes = validateTelegramWebAppInitData(signedInitData, testBotToken, 3600, nowSec);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.telegramUser?.id, 8842109);
  assert.equal(validRes.telegramUser?.first_name, 'Abebe');

  // 2. Tampered user ID should fail signature verification
  const tampered = signedInitData.replace('8842109', '9999999');
  const tamperedRes = validateTelegramWebAppInitData(tampered, testBotToken, 3600, nowSec);
  assert.equal(tamperedRes.valid, false);
  assert.equal(tamperedRes.reason, 'signature_mismatch');

  // 3. Expired auth_date should fail
  const expiredRes = validateTelegramWebAppInitData(
    signedInitData,
    testBotToken,
    300,
    nowSec + 1000
  );
  assert.equal(expiredRes.valid, false);
  assert.equal(expiredRes.reason, 'expired_auth_date');

  // 4. Future-dated auth_date (> 60s skew) should fail
  const futureSigned = buildSignedInitData(testBotToken, nowSec + 300);
  const futureRes = validateTelegramWebAppInitData(futureSigned, testBotToken, 3600, nowSec);
  assert.equal(futureRes.valid, false);
  assert.equal(futureRes.reason, 'future_auth_date');

  // 5. Missing bot token should fail honestly
  const noTokenRes = validateTelegramWebAppInitData(signedInitData, '', 3600, nowSec);
  assert.equal(noTokenRes.valid, false);
  assert.equal(noTokenRes.reason, 'missing_bot_token');
});

test('validateTelegramWebAppInitData enforces replay protection and Telegram ID ownership binding', () => {
  const testBotToken = '123456789:AAExampleTelegramBotSecretToken99';
  const nowSec = 1710000000;
  const signedInitData = buildSignedInitData(testBotToken, nowSec - 10);
  const replayGuard = new TelegramReplayGuard();

  // First request with replayGuard succeeds
  const first = validateTelegramWebAppInitData(signedInitData, testBotToken, {
    maxAgeSeconds: 3600,
    nowUnixSeconds: nowSec,
    expectedTelegramUserId: 8842109,
    replayGuard,
    actionNonce: 'req-001',
  });
  assert.equal(first.valid, true);

  // Duplicate replay with same initData + actionNonce is rejected
  const duplicate = validateTelegramWebAppInitData(signedInitData, testBotToken, {
    maxAgeSeconds: 3600,
    nowUnixSeconds: nowSec + 1,
    expectedTelegramUserId: 8842109,
    replayGuard,
    actionNonce: 'req-001',
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.reason, 'replay_detected');

  // Mismatched expectedTelegramUserId (spoofed sender ID) is rejected
  const wrongOwner = validateTelegramWebAppInitData(signedInitData, testBotToken, {
    maxAgeSeconds: 3600,
    nowUnixSeconds: nowSec + 2,
    expectedTelegramUserId: 1111111,
  });
  assert.equal(wrongOwner.valid, false);
  assert.equal(wrongOwner.reason, 'telegram_id_mismatch');
});

test('verifyTelegramSharedContact enforces sender ownership and rejects plain text or forwarded contacts', () => {
  // 1. Authentic shared contact where contact.user_id === senderTelegramId
  const authentic = verifyTelegramSharedContact({
    senderTelegramId: 8842109,
    contact: {
      phone_number: '251911223344',
      first_name: 'Abebe',
      user_id: 8842109,
    },
  });
  assert.equal(authentic.valid, true);
  assert.equal(authentic.verifiedPhoneNumber, '+251911223344');

  // 2. Forwarded contact belonging to a different Telegram user is rejected
  const forwarded = verifyTelegramSharedContact({
    senderTelegramId: 8842109,
    contact: {
      phone_number: '+251922334455',
      first_name: 'OtherUser',
      user_id: 7777777,
    },
  });
  assert.equal(forwarded.valid, false);
  assert.equal(forwarded.reason, 'contact_owner_mismatch');

  // 3. Plain-text typed phone number without native Telegram contact object is rejected
  const plainText = verifyTelegramSharedContact({
    senderTelegramId: 8842109,
    messageText: '+251911223344',
    contact: null,
  });
  assert.equal(plainText.valid, false);
  assert.equal(plainText.reason, 'plain_text_phone_rejected');
});
