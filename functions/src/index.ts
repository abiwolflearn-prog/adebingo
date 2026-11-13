/**
 * ADEYBINGO — Firebase Cloud Functions Architecture (Milestone 2 & 3)
 *
 * Deployable Cloud Functions module for privileged server-side operations:
 * 1. verifyTelegramInitDataHandler: Cryptographically verifies Telegram Mini App initData (HMAC-SHA256 + replay guard).
 * 2. telegramBotWebhookHandler: Handles Telegram Bot commands (/start, /help, /language, /support, /terms),
 *    shared phone contact ownership verification, duplicate account blocking, and Mini App launch keyboard.
 * 3. prepareTelegramNotificationHandler: Formats Amharic/English notifications for registration, game start,
 *    ball calls, game completion, winner announcements, referrals, and support replies.
 * 4. serverDrawBallHandler & serverVerifyWinnerHandler: Server-authoritative game operations.
 */

import crypto from 'node:crypto';
import {
  checkCardWin,
  formatBallCall,
  generateDeterministicCard,
  getLetterForNumber,
} from '../../src/game/rules';
import {
  defaultReplayGuard,
  validateTelegramWebAppInitData,
  verifyTelegramSharedContact,
} from '../../src/utils/telegramVerify';
import {
  AdeyBingoTelegramBotEngine,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  formatTelegramNotification,
  NotificationEventType,
  ServerGameAuthority,
} from '../../src/utils/telegramBot';
import { Language } from '../../src/types/bingo';

export interface CloudFunctionContext {
  uid?: string;
  emailVerified?: boolean;
}

const cloudBotEngine = new AdeyBingoTelegramBotEngine(DEFAULT_DEPLOYED_MINI_APP_URL);
const cloudGameAuthority = new ServerGameAuthority();

export function verifyTelegramInitDataHandler(
  rawInitData: string,
  botToken: string,
  actionNonce?: string,
  expectedTelegramUserId?: number
) {
  return validateTelegramWebAppInitData(rawInitData, botToken, {
    maxAgeSeconds: 3600,
    expectedTelegramUserId,
    replayGuard: actionNonce ? defaultReplayGuard : undefined,
    actionNonce,
  });
}

export function verifyTelegramContactOwnershipHandler(params: {
  senderTelegramId: number;
  messageText?: string;
  contact?: {
    phone_number?: string;
    first_name?: string;
    last_name?: string;
    user_id?: number;
  } | null;
}) {
  return verifyTelegramSharedContact(params);
}

export function telegramBotWebhookHandler(params: {
  updateId?: number;
  senderTelegramId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  firebaseUid?: string;
  text?: string;
  callbackData?: string;
  contact?: {
    phone_number?: string;
    first_name?: string;
    last_name?: string;
    user_id?: number;
  } | null;
}) {
  return cloudBotEngine.handleIncomingUpdate(params);
}

export function prepareTelegramNotificationHandler(
  event: NotificationEventType,
  lang: Language = 'am',
  payload: Parameters<typeof formatTelegramNotification>[2] = {}
) {
  return formatTelegramNotification(event, lang, payload);
}

export function serverDrawBallHandler(calledNumbers: number[]) {
  const calledSet = new Set(calledNumbers);
  const remaining: number[] = [];
  for (let n = 1; n <= 75; n++) {
    if (!calledSet.has(n)) remaining.push(n);
  }
  if (remaining.length === 0) {
    return null;
  }
  const ball = remaining[crypto.randomInt(0, remaining.length)];
  return {
    ball,
    letter: getLetterForNumber(ball),
    formatted: formatBallCall(ball),
  };
}

export function serverVerifyWinnerHandler(
  cardId: number,
  markedNumbers: number[],
  calledNumbers: number[]
) {
  const card = generateDeterministicCard(cardId);
  return checkCardWin(card, markedNumbers, calledNumbers, true);
}

export { cloudGameAuthority };
