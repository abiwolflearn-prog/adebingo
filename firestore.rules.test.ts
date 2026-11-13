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
    /incoming\(\)\.demoBalanceEtb == 250/,
    'Must lock initial demo balance to 250 ETB on creation'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.demoBalanceEtb == existing\(\)\.demoBalanceEtb/,
    'Must prevent users from modifying their own demoBalanceEtb on update'
  );

  // 4. PII Split Collection Isolation (/users/{userId}/private/{docId})
  assert.match(
    rulesContent,
    /match \/private\/\{docId\}/,
    'Must isolate phone numbers in /users/{userId}/private/{docId}'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.phoneVerified == true/,
    'Must forbid storing unverified phone numbers as verified in /users/{userId}/private/contact'
  );

  // 5. Duplicate Telegram Account Registration Prevention (/telegramBindings/{telegramUserId})
  assert.match(
    rulesContent,
    /match \/telegramBindings\/\{telegramUserId\}/,
    'Must enforce unique Telegram ID binding collection'
  );
  assert.match(
    rulesContent,
    /existsAfter\(\/databases\/\$\(database\)\/documents\/telegramBindings\/\$\(incoming\(\)\.telegramUserId\)\)/,
    'Must require atomic creation of /telegramBindings/{telegramUserId} when creating /users/{userId}'
  );

  // 6. Card Bounds (1..600) & Atomic Max-4-Cards Enforcement (getAfter)
  assert.match(
    rulesContent,
    /data\.cardId >= 1 && data\.cardId <= 600/,
    'Must enforce 1..600 card ID bounds'
  );
  assert.match(
    rulesContent,
    /getAfter\(\/databases\/\$\(database\)\/documents\/rooms\/\$\(roomId\)\/players\/\$\(request\.auth\.uid\)\)\.data\.cardIds\.size\(\) <= 4/,
    'Must enforce max 4 cards per player atomically via getAfter()'
  );

  // 7. Terminal State Locking, Host-Authorized Monotonic Ball Call, and Self-Referral Prevention
  assert.match(
    rulesContent,
    /existing\(\)\.status != 'completed'/,
    'Must lock terminal completed game sessions against further mutation'
  );
  assert.match(
    rulesContent,
    /existing\(\)\.hostUid == request\.auth\.uid/,
    'Must restrict ball-calling updates on /games/{gameId} to the session host or admin'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.calledNumbers\.size\(\) == existing\(\)\.calledNumbers\.size\(\) \+ 1/,
    'Must enforce monotonic single-ball increments on /games/{gameId}'
  );
  assert.match(
    rulesContent,
    /incoming\(\)\.friendHandle != get\(\/databases\/\$\(database\)\/documents\/users\/\$\(request\.auth\.uid\)\)\.data\.username/,
    'Must block self-referral abuse on /referrals/{referralId}'
  );
});
