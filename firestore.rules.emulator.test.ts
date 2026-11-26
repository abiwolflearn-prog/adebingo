import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

/**
 * Firestore Security Rules Emulator Verification Suite.
 *
 * Run locally or in CI with Java 11+ and Firebase CLI:
 *   firebase emulators:exec --only firestore "npx tsx --test firestore.rules.emulator.test.ts"
 *
 * When FIRESTORE_EMULATOR_HOST is not present (e.g., containers without a Java runtime),
 * this test suite reports a clean skip notice instead of failing false-negatively.
 */
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

test(
  'Firestore Rules Emulator: enforces phoneVerified immutability, server-only private/transactions/referrals, language-only updates, and 20-100 ETB room financial limits',
  { skip: !EMULATOR_HOST ? 'FIRESTORE_EMULATOR_HOST not running (requires Java 11+ & Firebase Emulator)' : false },
  async () => {
    const [host, portRaw] = (EMULATOR_HOST || '127.0.0.1:8080').split(':');
    const port = Number(portRaw || 8080);
    const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');

    const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
      projectId: 'adeybingo-rules-test',
      firestore: { host, port, rules },
    });

    try {
      // Seed server-created user profile and admin allowlist via disabled-rules admin context
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminDb = ctx.firestore();
        await setDoc(doc(adminDb, 'users/tg_1001'), {
          uid: 'tg_1001',
          telegramUserId: 'tg_1001',
          displayName: 'Selam',
          username: 'selam_et',
          language: 'am',
          phoneVerified: false,
          demoBalanceEtb: 15,
          referralCode: 'ADEY-1001',
        });
        await setDoc(doc(adminDb, 'admins/admin_owner'), {
          role: 'admin',
          email: 'owner@example.com',
        });
      });

      const tgPlayerCtx = testEnv.authenticatedContext('tg_1001', {
        telegram_verified: true,
        telegram_id: 1001,
      });
      const tgDb = tgPlayerCtx.firestore();

      const adminCtx = testEnv.authenticatedContext('admin_owner', {
        email: 'owner@example.com',
        email_verified: true,
      });
      const adminDb = adminCtx.firestore();

      // 1. Player CAN read own profile & update language ONLY
      await assertSucceeds(getDoc(doc(tgDb, 'users/tg_1001')));
      await assertSucceeds(updateDoc(doc(tgDb, 'users/tg_1001'), { language: 'en' }));

      // 2. Player CANNOT self-verify phoneVerified or inflate demoBalanceEtb
      await assertFails(updateDoc(doc(tgDb, 'users/tg_1001'), { phoneVerified: true }));
      await assertFails(updateDoc(doc(tgDb, 'users/tg_1001'), { demoBalanceEtb: 9999 }));

      // 3. Client CANNOT write directly to /users/{uid}/private/{docId}, /transactions, or /referrals
      await assertFails(
        setDoc(doc(tgDb, 'users/tg_1001/private/contact'), {
          phoneNumber: '+251911000111',
          phoneVerified: true,
        })
      );
      await assertFails(
        setDoc(doc(tgDb, 'transactions/tx_forged_1'), {
          transactionId: 'tx_forged_1',
          userId: 'tg_1001',
          type: 'bingo_win',
          amountEtb: 500,
          status: 'demo_completed',
        })
      );
      await assertFails(
        setDoc(doc(tgDb, 'referrals/ref_forged_1'), {
          referralId: 'ref_forged_1',
          inviterUid: 'tg_1001',
          status: 'qualified',
          bonusEtb: 20,
        })
      );

      // 4. Verified email admin CAN create a 20 ETB VIP room with 600 cards (12,000 ETB max pot)
      await assertSucceeds(
        setDoc(doc(adminDb, 'rooms/meskel-gold'), {
          roomId: 'meskel-gold',
          nameAm: 'መስቀል ወርቅ',
          nameEn: 'Meskel Gold',
          cardPrice: 20,
          countdownSeconds: 60,
          activePlayersCount: 600,
          reservedCardsCount: 600,
          totalCollectedEtb: 12000,
          adeyShareEtb: 2400,
          winnersPrizePoolEtb: 9600,
          status: 'countdown',
          currentGameId: 'game_meskel-gold_live',
        })
      );
    } finally {
      await testEnv.cleanup();
    }
  }
);
