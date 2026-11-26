import test from 'node:test';
import assert from 'node:assert/strict';
import { AdeyBingoTelegramBotEngine } from './telegramBot.ts';
import {
  authorizeAdminRequest,
  mintServerSessionToken,
  ServerAdminAuthority,
} from './adminAuthority.ts';

const TEST_SESSION_SECRET = 'test_admin_session_secret_key_2026';
const TEST_BOT_TOKEN = '123456789:AAH_test_bot_token_for_unit_tests';

test('Milestone 4 Part B & C: Unauthenticated requests receive 401, Normal Players receive 403, and Verified Admins receive 200', () => {
  const prevAdmins = process.env.ADEY_ADMIN_TELEGRAM_IDS;
  try {
    // 0. Without ADEY_ADMIN_TELEGRAM_IDS configured, legacy ID 8842109 must NOT be granted admin privileges
    delete process.env.ADEY_ADMIN_TELEGRAM_IDS;
    const unconfiguredAdmin = mintServerSessionToken(
      {
        telegramUserId: 8842109,
        displayName: 'Unconfigured User',
        username: 'unconfigured',
      },
      TEST_SESSION_SECRET
    );
    assert.equal(unconfiguredAdmin.actor.role, 'player');

    // Configure explicit server admin allowlist via env
    process.env.ADEY_ADMIN_TELEGRAM_IDS = '8842109';

    // 1. Unauthenticated request -> HTTP 401
    const unauthRes = authorizeAdminRequest({
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
    });
    assert.equal(unauthRes.authorized, false);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.reason, 'unauthenticated');

    // 2. Normal player session (TG #7777777) -> HTTP 403 Forbidden
    const playerMinted = mintServerSessionToken(
      {
        telegramUserId: 7777777,
        displayName: 'Dawit Mekonnen',
        username: 'dawit_m',
      },
      TEST_SESSION_SECRET
    );
    assert.equal(playerMinted.actor.role, 'player');

    const playerAuthRes = authorizeAdminRequest({
      sessionToken: playerMinted.token,
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
    });
    assert.equal(playerAuthRes.authorized, false);
    assert.equal(playerAuthRes.statusCode, 403);
    assert.equal(playerAuthRes.reason, 'forbidden_not_admin');

    // 3. Verified Administrator session (TG #8842109 via ADEY_ADMIN_TELEGRAM_IDS) -> HTTP 200 Authorized
    const adminMinted = mintServerSessionToken(
      {
        telegramUserId: 8842109,
        displayName: 'Abebe Bikila (Lead Admin)',
        username: 'abebe_adey',
        email: 'abelbimrew868@gmail.com',
      },
      TEST_SESSION_SECRET
    );
    assert.equal(adminMinted.actor.role, 'admin');

    const adminAuthRes = authorizeAdminRequest({
      sessionToken: adminMinted.token,
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
    });
    assert.equal(adminAuthRes.authorized, true);
    assert.equal(adminAuthRes.statusCode, 200);
    assert.equal(adminAuthRes.reason, 'authorized_admin');
    assert.equal(adminAuthRes.actor?.role, 'admin');

    // 4. Tampered token is rejected with HTTP 401
    const tamperedRes = authorizeAdminRequest({
      sessionToken: `${adminMinted.token}tampered`,
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
    });
    assert.equal(tamperedRes.authorized, false);
    assert.equal(tamperedRes.statusCode, 401);
  } finally {
    if (prevAdmins === undefined) delete process.env.ADEY_ADMIN_TELEGRAM_IDS;
    else process.env.ADEY_ADMIN_TELEGRAM_IDS = prevAdmins;
  }
});

test('Milestone 4 Part C & D: Self-role escalation is blocked (403) and logged; Payout orders, User suspension, and Bot welcome updates create immutable SHA-256 audit records', () => {
  const prevAdmins = process.env.ADEY_ADMIN_TELEGRAM_IDS;
  process.env.ADEY_ADMIN_TELEGRAM_IDS = '8842109';
  try {
    const bot = new AdeyBingoTelegramBotEngine('https://adebingo-3nta.vercel.app/');
    const authority = new ServerAdminAuthority(bot);

    const adminActor = mintServerSessionToken(
      {
        telegramUserId: 8842109,
        displayName: 'Abebe Bikila (Lead Admin)',
        username: 'abebe_adey',
        email: 'abelbimrew868@gmail.com',
      },
      TEST_SESSION_SECRET
    ).actor;

    const playerActor = mintServerSessionToken(
      {
        telegramUserId: 7777777,
        displayName: 'Dawit Mekonnen',
        username: 'dawit_m',
      },
      TEST_SESSION_SECRET
    ).actor;

    // 1. Normal player attempting to grant themselves an admin role is blocked with 403 and audited
    const escalationAttempt = authority.blockRoleEscalationAttempt({
      actor: playerActor,
      targetUid: playerActor.uid,
      requestedRole: 'admin',
    });
    assert.equal(escalationAttempt.ok, false);
    assert.equal(escalationAttempt.statusCode, 403);
    assert.equal(escalationAttempt.reason, 'self_role_escalation_forbidden');
    assert.equal(escalationAttempt.auditRecord.action, 'ROLE_ESCALATION_BLOCKED');

    // 2. Payout order status transitions (Pending -> Under Review -> Approved -> Completed) & Rejected
    const underReviewRes = authority.reviewPayoutOrder({
      requestId: 'PO-2026-901',
      nextStatus: 'Under Review',
      reviewNotes: 'Verifying game win ledger in Demo Sandbox',
      adminActor,
    });
    assert.equal(underReviewRes.ok, true);
    assert.equal(underReviewRes.payout?.status, 'Under Review');

    const approvedRes = authority.reviewPayoutOrder({
      requestId: 'PO-2026-901',
      nextStatus: 'Approved',
      reviewNotes: 'Approved in Demo Sandbox mode',
      adminActor,
    });
    assert.equal(approvedRes.ok, true);
    assert.equal(approvedRes.payout?.status, 'Approved');

    const completedRes = authority.reviewPayoutOrder({
      requestId: 'PO-2026-901',
      nextStatus: 'Completed',
      reviewNotes: 'Completed demo payout simulation',
      adminActor,
    });
    assert.equal(completedRes.ok, true);
    assert.equal(completedRes.payout?.status, 'Completed');
    assert.equal(completedRes.payout?.auditTrail.length, 4);

    const rejectedRes = authority.reviewPayoutOrder({
      requestId: 'PO-2026-902',
      nextStatus: 'Rejected',
      reviewNotes: 'Rejected in demo review test',
      adminActor,
    });
    assert.equal(rejectedRes.ok, true);
    assert.equal(rejectedRes.payout?.status, 'Rejected');

    // 3. User management search, masked phone PII check, and suspend/reactivate with audit trail
    const foundUsers = authority.searchUsers('7777777');
    assert.equal(foundUsers.length, 1);
    assert.equal(foundUsers[0].uid, 'tg_7777777');
    assert.match(foundUsers[0].maskedPhone, /\*\*\*\*/); // Masked phone PII

    const suspendRes = authority.updateUserStatus({
      uid: 'tg_7777777',
      accountStatus: 'suspended',
      reason: 'Suspicious multi-card script test',
      adminActor,
    });
    assert.equal(suspendRes.ok, true);
    assert.equal(suspendRes.user?.accountStatus, 'suspended');
    assert.equal(suspendRes.auditRecord?.action, 'USER_STATUS_CHANGED');

    const reactivateRes = authority.updateUserStatus({
      uid: 'tg_7777777',
      accountStatus: 'active',
      reason: 'Account cleared after review',
      adminActor,
    });
    assert.equal(reactivateRes.ok, true);
    assert.equal(reactivateRes.user?.accountStatus, 'active');

    // 4. Bot welcome message updates from Admin Dashboard take effect in /start for verified users
    const botUpdateRes = authority.updateBotManagementConfig({
      customWelcomeAm: '🌟 እንኳን ወደ ልዩ የአደይ ቢንጎ ውድድር በደህና መጡ!',
      customWelcomeEn: '🌟 Welcome to the Special ADEYBINGO Championship!',
      adminActor,
    });
    assert.equal(botUpdateRes.ok, true);
    assert.equal(botUpdateRes.auditRecord.action, 'BOT_CONFIG_UPDATED');

    // Complete 3-step verification for user 9001001, then verify /start displays updated welcome
    bot.handleIncomingUpdate({ senderTelegramId: 9001001, firstName: 'Selam', text: '/start' });
    bot.handleIncomingUpdate({ senderTelegramId: 9001001, firstName: 'Selam', callbackData: 'cb:onboarding_start' });
    bot.handleIncomingUpdate({
      senderTelegramId: 9001001,
      firstName: 'Selam',
      contact: { phone_number: '+251911009901', first_name: 'Selam', user_id: 9001001 },
    });
    const startAm = bot.handleIncomingUpdate({
      senderTelegramId: 9001001,
      firstName: 'Selam',
      text: '/start',
    });
    assert.match(startAm.text, /እንኳን ወደ ልዩ የአደይ ቢንጎ ውድድር በደህና መጡ/);

    // 5. Verify SHA-256 hash chain integrity across all recorded admin actions
    const integrity = authority.verifyAuditChainIntegrity();
    assert.equal(integrity.valid, true);
    assert.ok(integrity.totalEntries >= 8);
  } finally {
    if (prevAdmins === undefined) delete process.env.ADEY_ADMIN_TELEGRAM_IDS;
    else process.env.ADEY_ADMIN_TELEGRAM_IDS = prevAdmins;
  }
});
