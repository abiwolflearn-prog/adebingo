import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const rulesContent = fs.readFileSync(rulesPath, 'utf8');

test('Phase 0 Dirty Dozen & Eight Pillars Audit on Firestore Security Rules', () => {
  // 1. Global Safety Net (Default-Deny Catch-All)
  assert.match(
    rulesContent,
    /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/,
    'Must enforce default-deny catch-all at root'
  );

  // 2. Verified User & Email Spoofing Protection
  assert.match(
    rulesContent,
    /request\.auth\.token\.email_verified == true/,
    'Must enforce email_verified == true to block email spoofing'
  );

  // 3. Wallet Balance Immutability on /users/{userId}
  assert.match(
    rulesContent,
    /incoming\(\)\.demoBalanceEtb == 15/,
    'Must lock initial balance to 15 ETB on creation'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.demoBalanceEtb == existing\(\)\.demoBalanceEtb/,
    'Must prevent users from modifying their own demoBalanceEtb on update'
  );

  // 4. PII Split Collection Isolation (/users/{userId}/private/{docId}) - server-only writes
  assert.match(
    rulesContent,
    /match \/private\/\{docId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must isolate phone numbers in /users/{userId}/private/{docId} and lock writes strictly to server Admin SDK'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.phoneVerified == false/,
    'Must lock phoneVerified to false on client profile creation'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.phoneVerified == existing\(\)\.phoneVerified/,
    'Must forbid clients from self-verifying phoneVerified on /users/{userId} updates'
  );

  // 5. Server-Only Telegram Bindings & Anti-Pre-Hijacking (/telegramBindings/{telegramUserId} & /users/{userId})
  assert.match(
    rulesContent,
    /match \/telegramBindings\/\{telegramUserId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must lock /telegramBindings writes strictly to server Admin SDK'
  );
  assert.match(
    rulesContent,
    /match \/users\/\{userId\}[\s\S]*?allow create: if isVerifiedTelegramUser\(\) &&[\s\S]*?incoming\(\)\.telegramUserId == request\.auth\.uid/,
    'Must block email-authenticated users from claiming Telegram IDs or creating Telegram profiles'
  );

  // 6. Server-Only Card & Player Reservations (Blocks Direct Client Bypass of 4-Card Limit)
  assert.match(
    rulesContent,
    /match \/players\/\{playerId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must forbid direct client writes to /rooms/{roomId}/players/{playerId}'
  );
  assert.match(
    rulesContent,
    /match \/cards\/\{cardId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must forbid direct client writes to /rooms/{roomId}/cards/{cardId}'
  );

  // 7. Server-Only Game Sessions (/games/{gameId}) & Server-Only Referrals (/referrals/{referralId})
  assert.match(
    rulesContent,
    /match \/games\/\{gameId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must forbid client game creation, hostUid assignment, calledNumbers rewriting, and winner claims'
  );
  assert.match(
    rulesContent,
    /match \/referrals\/\{referralId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must lock /referrals writes strictly to server Admin SDK to prevent self-referral and forged payouts'
  );

  // 8. Telegram Verified Custom Claims (Integer ID Match) & Email-Only Admin Gate
  assert.match(
    rulesContent,
    /request\.auth\.token\.telegram_verified == true\s*&&\s*request\.auth\.token\.telegram_id is int\s*&&\s*request\.auth\.uid == 'tg_' \+ string\(request\.auth\.token\.telegram_id\)/,
    'Must require telegram_verified == true, integer telegram_id, and exact tg_<id> UID match'
  );
  assert.match(
    rulesContent,
    /function isAdmin\(\) \{\s*return isVerifiedEmailUser\(\)/,
    'Must restrict admin access strictly to email-verified admins, never Telegram custom claims'
  );

  // 9. Lock Client Mutation of Room Creation/Pricing, Transactions, and Referral Payouts
  assert.match(
    rulesContent,
    /match \/rooms\/\{roomId\}[\s\S]*?allow create: if isAdmin\(\)[\s\S]*?allow update: if isAdmin\(\)/,
    'Must restrict room creation and updates strictly to admins/server Admin SDK'
  );
  assert.match(
    rulesContent,
    /totalCollectedEtb <= 60000/,
    'Must allow 20 ETB to 100 ETB rooms up to 600 cards (60,000 ETB max pot)'
  );
  assert.match(
    rulesContent,
    /match \/transactions\/\{transactionId\}[\s\S]*?allow create, update, delete: if false;/,
    'Must lock /transactions writes strictly to server Admin SDK'
  );

  // 10. Server-Only Collections Explicitly Locked
  for (const col of ['admins', 'replayGuards', 'botPlayers', 'botOutbox', 'roomReconciliationBackups']) {
    assert.match(
      rulesContent,
      new RegExp(`match \\/${col}\\/\\{[^}]+\\} \\{\\s*allow read, write: if false;\\s*\\}`),
      `Must deny all client access to server-only /${col} collection`
    );
  }
});
