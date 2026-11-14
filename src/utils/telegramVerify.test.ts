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
  queryId = 'AAHdF6IQAAAAAN0XohDhrOrc',
  extraFields: Record<string, string> = {}
): string {
  const userPayload = JSON.stringify(userObj);
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', queryId);
  params.set('user', userPayload);
  for (const [k, v] of Object.entries(extraFields)) {
    params.set(k, v);
  }

  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    entries.push([key, value]);
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('validateTelegramWebAppInitData matches Telegram official HMAC-SHA256 specification test vector', () => {
  const officialVectorToken = '5768337691:AAGDaG6OkNN2VtGKQeLWnjIRONber111111';
  const officialVectorInitData =
    'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&chat_instance=8428209589180549439&chat_type=sender&hash=43c5695be8e64fd2e268891e43578c7919f4fe2d7e1b3c6c59752ddc9489f9d3';

  const result = validateTelegramWebAppInitData(officialVectorInitData, officialVectorToken, {
    maxAgeSeconds: 3600,
    nowUnixSeconds: 1662771648 + 30,
  });

  assert.equal(result.valid, true);
  assert.equal(result.telegramUser?.id, 279058397);
  assert.equal(result.telegramUser?.username, 'vdkfrost');
  assert.equal(
    result.dataCheckHash,
    '43c5695be8e64fd2e268891e43578c7919f4fe2d7e1b3c6c59752ddc9489f9d3'
  );
});

test('validateTelegramWebAppInitData sorts keys alphabetically by key (chat before chat_instance) and supports UTF-8 Amharic names', () => {
  const testBotToken = '123456789:AAExampleTelegramBotSecretToken99';
  const nowSec = 1710000000;
  // Previously, sorting `"key=value"` strings with localeCompare placed `chat_instance=...` before `chat=...`!
  const signedWithChatAndInstance = buildSignedInitData(
    testBotToken,
    nowSec - 15,
    {
      id: 8842109,
      first_name: 'አበበ',
      last_name: 'ቢቂላ',
      username: 'abebe_adey',
      language_code: 'am',
    },
    'AAHdF6IQAAAAAN0XohDhrOrc',
    {
      chat: JSON.stringify({ id: -1001234567890, type: 'supergroup', title: 'Adey Bingo' }),
      chat_instance: '8428209589180549439',
      chat_type: 'supergroup',
      signature: 'Ed25519ThirdPartySigExampleValue',
    }
  );

  const res = validateTelegramWebAppInitData(signedWithChatAndInstance, testBotToken, 3600, nowSec);
  assert.equal(res.valid, true);
  assert.equal(res.telegramUser?.id, 8842109);
  assert.equal(res.telegramUser?.first_name, 'አበበ');
});

test('validateTelegramWebAppInitData verifies valid initData and diagnoses modified initData, wrong bot token, missing hash, expired auth_date, and malformed query strings', () => {
  const testBotToken = '123456789:AAExampleTelegramBotSecretToken99';
  const wrongBotToken = '999999999:AAWrongTelegramBotSecretToken00';
  const nowSec = 1710000000;
  const signedInitData = buildSignedInitData(testBotToken, nowSec - 60);

  // 1. Valid signature & fresh auth_date
  const validRes = validateTelegramWebAppInitData(signedInitData, testBotToken, 3600, nowSec);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.telegramUser?.id, 8842109);
  assert.equal(validRes.telegramUser?.first_name, 'Abebe');

  // 2. Modified initData (tampered user ID)
  const tampered = signedInitData.replace('8842109', '9999999');
  const tamperedRes = validateTelegramWebAppInitData(tampered, testBotToken, 3600, nowSec);
  assert.equal(tamperedRes.valid, false);
  assert.equal(tamperedRes.reason, 'signature_mismatch');
  assert.equal(tamperedRes.diagnostics?.failureCategory, 'incorrect_bot_token_or_signature');
  assert.equal(tamperedRes.diagnostics?.botTokenConfigured, true);

  // 3. Wrong bot token
  const wrongTokenRes = validateTelegramWebAppInitData(signedInitData, wrongBotToken, 3600, nowSec);
  assert.equal(wrongTokenRes.valid, false);
  assert.equal(wrongTokenRes.reason, 'signature_mismatch');
  assert.equal(wrongTokenRes.diagnostics?.failureCategory, 'incorrect_bot_token_or_signature');
  assert.equal(wrongTokenRes.diagnostics?.botTokenFormatValid, true);

  // 4. Missing hash
  const withoutHash = signedInitData.replace(/&hash=[0-9a-f]+/i, '');
  const missingHashRes = validateTelegramWebAppInitData(withoutHash, testBotToken, 3600, nowSec);
  assert.equal(missingHashRes.valid, false);
  assert.equal(missingHashRes.reason, 'missing_hash');
  assert.equal(missingHashRes.diagnostics?.hasHash, false);
  assert.equal(missingHashRes.diagnostics?.failureCategory, 'missing_hash');

  // 5. Expired auth_date
  const expiredRes = validateTelegramWebAppInitData(
    signedInitData,
    testBotToken,
    300,
    nowSec + 1000
  );
  assert.equal(expiredRes.valid, false);
  assert.equal(expiredRes.reason, 'expired_auth_date');
  assert.equal(expiredRes.diagnostics?.failureCategory, 'expired_auth_date');
  assert.equal(expiredRes.diagnostics?.authDateAgeSeconds, 1060);

  // 6. Future-dated auth_date (> 60s skew)
  const futureSigned = buildSignedInitData(testBotToken, nowSec + 300);
  const futureRes = validateTelegramWebAppInitData(futureSigned, testBotToken, 3600, nowSec);
  assert.equal(futureRes.valid, false);
  assert.equal(futureRes.reason, 'future_auth_date');
  assert.equal(futureRes.diagnostics?.failureCategory, 'future_auth_date');

  // 7. Missing or placeholder bot token produces backend configuration failure, never signature_mismatch
  for (const badToken of ['', '   ', 'MY_TELEGRAM_BOT_TOKEN', 'adeybingo_server_initdata_hmac_key_v1']) {
    const noTokenRes = validateTelegramWebAppInitData(signedInitData, badToken, 3600, nowSec);
    assert.equal(noTokenRes.valid, false);
    assert.equal(noTokenRes.reason, 'missing_bot_token');
    assert.equal(noTokenRes.diagnostics?.failureCategory, 'backend_environment_configuration');
    assert.equal(noTokenRes.diagnostics?.botTokenConfigured, false);
  }

  // 8. Malformed query strings & frontend formatting mistakes
  const notAQuery = validateTelegramWebAppInitData('not_a_query_string', testBotToken, 3600, nowSec);
  assert.equal(notAQuery.valid, false);
  assert.equal(notAQuery.reason, 'malformed_init_data');
  assert.equal(notAQuery.diagnostics?.failureCategory, 'malformed_init_data');

  const jsonUnsafe = validateTelegramWebAppInitData(
    JSON.stringify({ user: { id: 8842109 }, auth_date: nowSec }),
    testBotToken,
    3600,
    nowSec
  );
  assert.equal(jsonUnsafe.valid, false);
  assert.equal(jsonUnsafe.reason, 'malformed_init_data');
  assert.equal(jsonUnsafe.diagnostics?.failureCategory, 'frontend_request_formatting');
  assert.equal(jsonUnsafe.diagnostics?.looksLikeInitDataUnsafe, true);

  const leadingQuestionMark = validateTelegramWebAppInitData(
    `?${signedInitData}`,
    testBotToken,
    3600,
    nowSec
  );
  assert.equal(leadingQuestionMark.valid, false);
  assert.equal(leadingQuestionMark.reason, 'malformed_init_data');
  assert.equal(leadingQuestionMark.diagnostics?.failureCategory, 'frontend_request_formatting');
  assert.equal(leadingQuestionMark.diagnostics?.hasLeadingQuestionMarkOrHashPrefix, true);

  const badPercentEncoding = validateTelegramWebAppInitData(
    'auth_date=1710000000&user=%ZZ&hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    testBotToken,
    3600,
    nowSec
  );
  assert.equal(badPercentEncoding.valid, false);
  assert.equal(badPercentEncoding.reason, 'malformed_init_data');

  const shortHash = validateTelegramWebAppInitData(
    'auth_date=1710000000&user=%7B%22id%22%3A1%7D&hash=deadbeef',
    testBotToken,
    3600,
    nowSec
  );
  assert.equal(shortHash.valid, false);
  assert.equal(shortHash.reason, 'malformed_init_data');
  assert.equal(shortHash.diagnostics?.hasHash, true);
  assert.equal(shortHash.diagnostics?.hashFormatValid, false);
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
