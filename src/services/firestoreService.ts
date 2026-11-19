import {
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Unsubscribe,
} from 'firebase/firestore';
import type { RoundWinnerShare } from '../game/roundSettlement';
import {
  calculateAuthoritativeGameFinancials,
  resolveGameLifecycleStage,
} from '../game/rules';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import {
  ConnectionState,
  GameLifecycleStage,
  Language,
  WinResult,
} from '../types/bingo';
import { TelegramUserProfile } from '../utils/telegram';

export interface FirestoreUserProfile {
  uid: string;
  telegramUserId: string;
  displayName: string;
  username: string;
  language: Language;
  phoneVerified: boolean;
  demoBalanceEtb: number;
}

export interface FirestorePrivateContact {
  uid: string;
  phoneNumber: string;
  phoneVerified: boolean;
  verificationMethod: 'telegram_contact' | 'sms_otp_demo';
}

export interface FirestoreCardReservation {
  cardId: number;
  roomId: string;
  ownerId: string;
  ownerName: string;
  serial: string;
}

export interface FirestoreRoomPlayer {
  playerId: string;
  roomId: string;
  displayName: string;
  telegramUserId: string;
  cardIds: number[];
}

export interface FirestoreLiveGameSession {
  gameId: string;
  roomId: string;
  hostUid: string;
  roundNumber?: number;
  status: 'countdown' | 'live' | 'completed';
  lifecycleStage?: GameLifecycleStage;
  calledNumbers: number[];
  latestBall: number;
  winnerUid: string;
  winnerName: string;
  winningCardId: number;
  winningPattern: string;
  confirmedPlayersCount?: number;
  availableSpaces?: number;
  totalCardsSold?: number;
  totalCollectedEtb?: number;
  adeyShareEtb?: number;
  winnersPrizePoolEtb?: number;
  prizePoolEtb?: number;
  winners?: RoundWinnerShare[];
}

let activeServerSessionToken = '';

/**
 * Stores the server-issued HMAC session token returned by `/api/telegram/auth`
 * so authenticated API calls work seamlessly alongside Firebase ID tokens.
 */
export function setSessionBearerToken(token: string | null | undefined): void {
  activeServerSessionToken = (token || '').trim();
}

/**
 * Resolves the active Bearer token for authenticated `/api/*` endpoints.
 * Prefers the live Firebase Auth ID token (`auth.currentUser.getIdToken()`) and
 * falls back to the cryptographically signed session token from `/api/telegram/auth`.
 */
export async function getActiveBearerToken(): Promise<string> {
  if (auth.currentUser) {
    try {
      const idToken = await auth.currentUser.getIdToken();
      if (idToken) return idToken;
    } catch {
      // Fall back to server session token if Firebase ID token refresh fails
    }
  }
  return activeServerSessionToken;
}

export async function buildAuthenticatedHeaders(): Promise<Record<string, string>> {
  const token = await getActiveBearerToken();
  return {
    'Content-Type': 'application/json',
    ...(token
      ? {
          Authorization: `Bearer ${token}`,
          'x-adey-session-token': token,
        }
      : {}),
  };
}

export async function signOutFromFirebase(): Promise<void> {
  activeServerSessionToken = '';
  await signOut(auth);
}

/**
 * Ensures the authenticated user's public profile document exists at /users/{uid}.
 * Enforces blueprint constraints and never allows client-side balance inflation.
 */
export async function ensureUserProfileInFirestore(
  user: User,
  tgProfile: TelegramUserProfile,
  lang: Language
): Promise<FirestoreUserProfile> {
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);

  try {
    const existingSnap = await getDoc(userRef);
    if (existingSnap.exists()) {
      const data = existingSnap.data();
      return {
        uid: data.uid,
        telegramUserId: data.telegramUserId,
        displayName: data.displayName,
        username: data.username,
        language: data.language === 'en' ? 'en' : 'am',
        phoneVerified: Boolean(data.phoneVerified),
        demoBalanceEtb: Number(data.demoBalanceEtb ?? 0),
      };
    }

    const safeTgId = tgProfile.isTelegramWebApp
      ? `tg_${tgProfile.id}`
      : `tg_${user.uid.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const safeDisplayName = (
      user.displayName || `${tgProfile.firstName} ${tgProfile.lastName || ''}`.trim() || 'Adey Player'
    ).slice(0, 80);
    const safeUsername = (
      tgProfile.username || `@${(user.email || 'player').split('@')[0]}`
    ).slice(0, 64);

    return await runTransaction(db, async (tx) => {
      const bindingRef = doc(db, 'telegramBindings', safeTgId);
      const [uSnap, bSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(bindingRef),
      ]);

      if (uSnap.exists()) {
        const d = uSnap.data();
        return {
          uid: d.uid,
          telegramUserId: d.telegramUserId,
          displayName: d.displayName,
          username: d.username,
          language: d.language === 'en' ? 'en' : 'am',
          phoneVerified: Boolean(d.phoneVerified),
          demoBalanceEtb: Number(d.demoBalanceEtb ?? 0),
        };
      }

      if (bSnap.exists() && bSnap.data().uid !== user.uid) {
        throw new Error(
          `Duplicate Telegram account registration blocked: ${safeTgId} is already bound to another account.`
        );
      }

      tx.set(bindingRef, {
        telegramUserId: safeTgId,
        uid: user.uid,
        boundAt: serverTimestamp(),
      });

      tx.set(userRef, {
        uid: user.uid,
        telegramUserId: safeTgId,
        displayName: safeDisplayName,
        username: safeUsername,
        language: lang,
        phoneVerified: false,
        demoBalanceEtb: 250,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      return {
        uid: user.uid,
        telegramUserId: safeTgId,
        displayName: safeDisplayName,
        username: safeUsername,
        language: lang,
        phoneVerified: false,
        demoBalanceEtb: 250,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Duplicate Telegram account')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

/**
 * Subscribes in real time to the authenticated user's profile (/users/{uid}) using Firestore onSnapshot.
 */
export function subscribeToUserProfile(
  uid: string,
  onProfileUpdate: (profile: FirestoreUserProfile) => void
): Unsubscribe {
  const userRef = doc(db, 'users', uid);
  return onSnapshot(
    userRef,
    (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      onProfileUpdate({
        uid: String(d.uid || uid),
        telegramUserId: String(d.telegramUserId || uid),
        displayName: String(d.displayName || 'Adey Player'),
        username: String(d.username || uid),
        language: d.language === 'en' ? 'en' : 'am',
        phoneVerified: Boolean(d.phoneVerified),
        demoBalanceEtb: Number(d.demoBalanceEtb ?? 0),
      });
    },
    () => {
      // Ignore transient listener permission errors when custom token is not active
    }
  );
}

/**
 * Updates the authenticated user's language preference in /users/{uid} (allowed by firestore.rules).
 */
export async function updateUserLanguageInFirestore(
  uid: string,
  language: Language
): Promise<void> {
  if (!uid || !auth.currentUser || auth.currentUser.uid !== uid) return;
  try {
    await updateDoc(doc(db, 'users', uid), {
      language,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore when running in offline/local preview without active Firestore profile
  }
}

/**
 * Synchronizes language preference across Mini App Firestore profile and Telegram Bot backend.
 */
export async function syncLanguagePreference(
  nextLang: Language,
  uid?: string | null,
  telegramUserId?: number
): Promise<void> {
  if (uid) {
    await updateUserLanguageInFirestore(uid, nextLang);
  }
  try {
    const token = await getActiveBearerToken();
    const headers = await buildAuthenticatedHeaders();
    const body: Record<string, unknown> = {
      callbackData: `lang:${nextLang}`,
    };
    if (!token && telegramUserId) {
      body.senderTelegramId = telegramUserId;
    }
    await fetch('/api/telegram/bot-command', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    // Ignore transient network errors when offline
  }
}

/**
 * Reads the owner's isolated PII phone contact from /users/{uid}/private/contact.
 */
export async function getPrivatePhoneContact(
  uid: string
): Promise<FirestorePrivateContact | null> {
  const contactPath = `users/${uid}/private/contact`;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'private', 'contact'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid: d.uid,
      phoneNumber: d.phoneNumber,
      phoneVerified: Boolean(d.phoneVerified),
      verificationMethod: d.verificationMethod,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, contactPath);
  }
}

/**
 * Requests server-side default rooms initialization via `/api/rooms` instead of direct client writes.
 */
export async function ensureDefaultRoomsInFirestore(): Promise<void> {
  const headers = await buildAuthenticatedHeaders();
  const resp = await fetch('/api/rooms', {
    method: 'GET',
    headers,
  });
  if (!resp.ok) {
    throw new Error(`Server /api/rooms returned HTTP ${resp.status}`);
  }
}

/**
 * Subscribes in real time to the parent room doc (/rooms/{roomId}),
 * all Reserved Cards (/rooms/{roomId}/cards), and Players (/rooms/{roomId}/players).
 */
export function subscribeToRoomState(
  roomId: string,
  onCardsChange: (reservations: FirestoreCardReservation[]) => void,
  onPlayersChange: (players: FirestoreRoomPlayer[]) => void,
  onRoomDocChange?: (room: ServerRoomSummary) => void,
  onConnectionStateChange?: (state: ConnectionState) => void
): Unsubscribe {
  const roomPath = `rooms/${roomId}`;
  const cardsPath = `rooms/${roomId}/cards`;
  const playersPath = `rooms/${roomId}/players`;

  const unsubRoomDoc = onSnapshot(
    doc(db, 'rooms', roomId),
    (snap) => {
      onConnectionStateChange?.('online');
      if (!snap.exists() || !onRoomDocChange) return;
      const d = snap.data();
      const rawStatus = String(d.status || 'countdown');
      const status: ServerRoomSummary['status'] =
        rawStatus === 'waiting' ||
        rawStatus === 'countdown' ||
        rawStatus === 'live' ||
        rawStatus === 'completed'
          ? rawStatus
          : 'countdown';
      const cardPrice = Number(d.cardPrice ?? 10);
      const minPlayers = Number(d.minPlayers ?? 3);
      const registrationDeadlineMs =
        typeof d.registrationDeadlineMs === 'number' && Number.isFinite(d.registrationDeadlineMs)
          ? d.registrationDeadlineMs
          : undefined;
      const roundStartedAtMs =
        typeof d.roundStartedAtMs === 'number' && Number.isFinite(d.roundStartedAtMs)
          ? d.roundStartedAtMs
          : undefined;
      const countdownSeconds =
        status === 'countdown' && registrationDeadlineMs && registrationDeadlineMs > 0
          ? Math.max(0, Math.ceil((registrationDeadlineMs - Date.now()) / 1000))
          : Number(d.countdownSeconds ?? 60);
      const activePlayersCount = Number(d.confirmedPlayersCount ?? d.activePlayersCount ?? 0);
      const reservedCardsCount = Number(d.totalCardsSold ?? d.reservedCardsCount ?? 0);
      const financials = calculateAuthoritativeGameFinancials(
        activePlayersCount,
        reservedCardsCount,
        cardPrice
      );
      const lifecycleStage = resolveGameLifecycleStage({
        status,
        confirmedPlayersCount: financials.confirmedPlayersCount,
        countdownSeconds,
        minPlayers,
        explicitStage:
          typeof d.lifecycleStage === 'string'
            ? (d.lifecycleStage as GameLifecycleStage)
            : undefined,
      });
      onRoomDocChange({
        roomId: String(d.roomId || roomId),
        nameAm: String(d.nameAm || ''),
        nameEn: String(d.nameEn || ''),
        cardPrice,
        maxPlayersPerRoom: financials.maxCapacityPlayers,
        maxCardsPerRoom: Number(d.maxCardsPerRoom ?? 600),
        maxCardsPerPlayer: Number(d.maxCardsPerPlayer ?? 4),
        minPlayers,
        countdownSeconds,
        registrationDeadlineMs,
        roundStartedAtMs,
        activePlayersCount: financials.confirmedPlayersCount,
        confirmedPlayersCount: financials.confirmedPlayersCount,
        verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
        availableSpaces: financials.availableSpaces,
        reservedCardsCount,
        totalCardsSold: financials.totalCardsSold,
        totalCollectedEtb: financials.totalCollectedEtb,
        adeyShareEtb: financials.adeyShareEtb,
        winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
        status,
        lifecycleStage,
        currentGameId: String(d.currentGameId || `game_${roomId}_live`),
        hostUid: String(d.hostUid || ''),
      });
    },
    (err) => {
      onConnectionStateChange?.('reconnecting');
      try {
        handleFirestoreError(err, OperationType.GET, roomPath);
      } catch {
        // Handled by caller fallback
      }
    }
  );

  const qCards = query(
    collection(db, 'rooms', roomId, 'cards'),
    where('roomId', '==', roomId)
  );
  const unsubCards = onSnapshot(
    qCards,
    (snap) => {
      onConnectionStateChange?.('online');
      const list: FirestoreCardReservation[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        list.push({
          cardId: Number(d.cardId),
          roomId: String(d.roomId),
          ownerId: String(d.ownerId),
          ownerName: String(d.ownerName),
          serial: String(d.serial),
        });
      });
      onCardsChange(list);
    },
    (err) => {
      onConnectionStateChange?.('reconnecting');
      try {
        handleFirestoreError(err, OperationType.LIST, cardsPath);
      } catch {
        // Handled by caller fallback
      }
    }
  );

  const qPlayers = query(
    collection(db, 'rooms', roomId, 'players'),
    where('roomId', '==', roomId)
  );
  const unsubPlayers = onSnapshot(
    qPlayers,
    (snap) => {
      onConnectionStateChange?.('online');
      const list: FirestoreRoomPlayer[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        list.push({
          playerId: String(d.playerId),
          roomId: String(d.roomId),
          displayName: String(d.displayName),
          telegramUserId: String(d.telegramUserId),
          cardIds: Array.isArray(d.cardIds) ? d.cardIds.map(Number) : [],
        });
      });
      onPlayersChange(list);
    },
    (err) => {
      onConnectionStateChange?.('reconnecting');
      try {
        handleFirestoreError(err, OperationType.LIST, playersPath);
      } catch {
        // Handled by caller fallback
      }
    }
  );

  return () => {
    unsubRoomDoc();
    unsubCards();
    unsubPlayers();
  };
}

/**
 * Subscribes in real time to a live game session (/games/{gameId}) via Firestore onSnapshot.
 */
export function subscribeToGameState(
  gameId: string,
  onGameChange: (game: FirestoreLiveGameSession) => void,
  onConnectionStateChange?: (state: ConnectionState) => void
): Unsubscribe {
  const gameRef = doc(db, 'games', gameId);
  return onSnapshot(
    gameRef,
    (snap) => {
      onConnectionStateChange?.('online');
      if (!snap.exists()) return;
      const d = snap.data();
      onGameChange({
        gameId: String(d.gameId || gameId),
        roomId: String(d.roomId || ''),
        hostUid: String(d.hostUid || ''),
        roundNumber: typeof d.roundNumber === 'number' ? d.roundNumber : 1,
        status:
          d.status === 'live' || d.status === 'completed' ? d.status : 'countdown',
        lifecycleStage:
          typeof d.lifecycleStage === 'string'
            ? (d.lifecycleStage as GameLifecycleStage)
            : undefined,
        calledNumbers: Array.isArray(d.calledNumbers)
          ? d.calledNumbers.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 75)
          : [],
        latestBall: Number(d.latestBall ?? 0),
        winnerUid: String(d.winnerUid || ''),
        winnerName: String(d.winnerName || ''),
        winningCardId: Number(d.winningCardId ?? 0),
        winningPattern: String(d.winningPattern || ''),
        confirmedPlayersCount:
          typeof d.confirmedPlayersCount === 'number' ? d.confirmedPlayersCount : undefined,
        availableSpaces:
          typeof d.availableSpaces === 'number' ? d.availableSpaces : undefined,
        totalCardsSold:
          typeof d.totalCardsSold === 'number' ? d.totalCardsSold : undefined,
        totalCollectedEtb:
          typeof d.totalCollectedEtb === 'number' ? d.totalCollectedEtb : undefined,
        adeyShareEtb:
          typeof d.adeyShareEtb === 'number' ? d.adeyShareEtb : undefined,
        winnersPrizePoolEtb:
          typeof d.winnersPrizePoolEtb === 'number' ? d.winnersPrizePoolEtb : undefined,
      });
    },
    () => {
      onConnectionStateChange?.('reconnecting');
    }
  );
}

/**
 * Atomically reserves or releases a card (1..600) through the server-authoritative
 * endpoint `POST /api/cards/reserve` with an authenticated Bearer token.
 * Never performs blocked direct client writes to `/rooms/{roomId}` or `/users/{uid}`.
 */
export async function toggleCardReservationAtomic(params: {
  roomId: string;
  cardId: number;
  uid?: string;
  displayName?: string;
  telegramUserId?: string;
  action?: 'reserve' | 'release' | 'toggle';
}): Promise<{
  action: 'reserved' | 'released';
  updatedCardIds: number[];
  updatedBalanceEtb?: number;
}> {
  const { roomId, cardId, action = 'toggle' } = params;
  if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
    throw new Error('Card ID must be an integer between 1 and 600.');
  }

  const headers = await buildAuthenticatedHeaders();
  const idempotencyKey = `card_${roomId}_${cardId}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  const resp = await fetch('/api/cards/reserve', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      roomId,
      cardId,
      action,
      idempotencyKey,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(
      data.message || data.error || `Card reservation rejected by server (HTTP ${resp.status}).`
    );
  }

  return {
    action: data.action === 'released' ? 'released' : 'reserved',
    updatedCardIds: Array.isArray(data.cardIds) ? data.cardIds.map(Number) : [],
    updatedBalanceEtb:
      typeof data.updatedBalanceEtb === 'number' ? data.updatedBalanceEtb : undefined,
  };
}

/**
 * Starts a game round through the server-authoritative endpoint `POST /api/game/start`.
 */
export async function startGameViaServerApi(params: {
  roomId: string;
  gameId?: string;
}): Promise<FirestoreLiveGameSession> {
  const headers = await buildAuthenticatedHeaders();
  const idempotencyKey = `start_${params.roomId}_${Date.now()}`;
  const resp = await fetch('/api/game/start', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      roomId: params.roomId,
      gameId: params.gameId,
      idempotencyKey,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok || !data.game) {
    throw new Error(
      data.message || data.error || `Start game failed on server (HTTP ${resp.status}).`
    );
  }

  return data.game as FirestoreLiveGameSession;
}

/**
 * Draws the next Bingo ball through the server-authoritative endpoint `POST /api/game/draw-ball`.
 */
export async function drawBallViaServerApi(params: {
  roomId: string;
  gameId?: string;
  requestNonce?: string;
  callerTelegramId?: number;
}): Promise<{
  ok: boolean;
  ball: number;
  calledNumbers: number[];
  totalCalled: number;
}> {
  const headers = await buildAuthenticatedHeaders();
  const nonce = params.requestNonce || `draw_${params.roomId}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const resp = await fetch('/api/game/draw-ball', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': nonce,
    },
    body: JSON.stringify({
      roomId: params.roomId,
      gameId: params.gameId,
      requestNonce: nonce,
      ...(params.callerTelegramId ? { callerTelegramId: params.callerTelegramId } : {}),
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok || typeof data.ball !== 'number') {
    throw new Error(
      data.message || data.error || data.reason || `Ball draw rejected by server (HTTP ${resp.status}).`
    );
  }

  return {
    ok: true,
    ball: Number(data.ball),
    calledNumbers: Array.isArray(data.calledNumbers)
      ? data.calledNumbers.map(Number)
      : [Number(data.ball)],
    totalCalled: Number(data.totalCalled ?? 1),
  };
}

/**
 * Verifies a winning card claim and credits the Demo prize atomically via `POST /api/game/verify-winner`.
 */
export async function verifyWinnerViaServerApi(params: {
  roomId: string;
  gameId?: string;
  cardId: number;
  markedNumbers: number[];
  calledNumbers?: number[];
  claimantTelegramId?: number;
  playerName?: string;
}): Promise<{
  verified: boolean;
  reason?: string;
  message?: string;
  cardId: number;
  winResult?: WinResult;
  demoPrizeEtb?: number;
}> {
  const headers = await buildAuthenticatedHeaders();
  const idempotencyKey = `win_${params.roomId}_${params.cardId}_${Date.now()}`;
  const resp = await fetch('/api/game/verify-winner', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      roomId: params.roomId,
      gameId: params.gameId,
      cardId: params.cardId,
      markedNumbers: params.markedNumbers,
      idempotencyKey,
      ...(params.calledNumbers ? { calledNumbers: params.calledNumbers } : {}),
      ...(params.claimantTelegramId ? { claimantTelegramId: params.claimantTelegramId } : {}),
      ...(params.playerName ? { playerName: params.playerName } : {}),
    }),
  });

  const data = await resp.json().catch(() => ({}));
  return {
    verified: Boolean(resp.ok && data.verified),
    reason: data.reason || data.error,
    message: data.message,
    cardId: params.cardId,
    winResult: data.winResult,
    demoPrizeEtb: typeof data.demoPrizeEtb === 'number' ? data.demoPrizeEtb : undefined,
  };
}

/**
 * Resets a completed game round via `POST /api/game/reset-round`.
 */
export async function resetRoundViaServerApi(params: {
  roomId: string;
  gameId?: string;
}): Promise<{ ok: boolean; status: string }> {
  const headers = await buildAuthenticatedHeaders();
  const idempotencyKey = `reset_${params.roomId}_${Date.now()}`;
  const resp = await fetch('/api/game/reset-round', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      roomId: params.roomId,
      gameId: params.gameId,
      idempotencyKey,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(
      data.message || data.error || `Round reset rejected by server (HTTP ${resp.status}).`
    );
  }

  return {
    ok: true,
    status: String(data.status || 'countdown'),
  };
}

/**
 * Records an immutable demo referral entry in /referrals/{referralId}.
 * Complies with `firestore.rules`: status must be `'pending'` on client creation.
 */
export async function recordDemoReferralInFirestore(params: {
  inviterUid: string;
  friendName: string;
  friendHandle: string;
}): Promise<void> {
  const refId = `ref_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
  const refPath = `referrals/${refId}`;
  try {
    await setDoc(doc(db, 'referrals', refId), {
      referralId: refId,
      inviterUid: params.inviterUid,
      friendName: params.friendName.slice(0, 80),
      friendHandle: params.friendHandle.slice(0, 64),
      inviterBonusEtb: 20,
      inviteeBonusEtb: 15,
      status: 'pending',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, refPath);
  }
}

/**
 * Delegates game session synchronization to the server-authoritative game endpoints
 * (`/api/game/start`, `/api/game/reset-round`) instead of blocked client-side Firestore writes.
 */
export async function syncGameSessionInFirestore(params: {
  gameId: string;
  roomId: string;
  hostUid: string;
  status: 'countdown' | 'live' | 'completed';
  calledNumbers: number[];
  latestBall: number;
  winnerUid?: string;
  winnerName?: string;
  winningCardId?: number;
  winningPattern?: string;
}): Promise<void> {
  if (params.status === 'countdown') {
    await resetRoundViaServerApi({
      roomId: params.roomId,
      gameId: params.gameId,
    });
  } else if (params.status === 'live' && params.calledNumbers.length <= 1) {
    await startGameViaServerApi({
      roomId: params.roomId,
      gameId: params.gameId,
    });
  }
}

/**
 * Loads the authenticated user's persisted transactions from Firestore.
 */
export async function fetchUserTransactionsFromFirestore(uid: string) {
  const path = 'transactions';
  try {
    const q = query(collection(db, 'transactions'), where('userId', '==', uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export interface ServerRoomSummary {
  roomId: string;
  nameAm: string;
  nameEn: string;
  cardPrice: number;
  maxPlayersPerRoom?: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  minPlayers: number;
  countdownSeconds: number;
  registrationDeadlineMs?: number;
  roundStartedAtMs?: number;
  roundNumber?: number;
  activePlayersCount: number;
  confirmedPlayersCount?: number;
  verifiedPaidEntriesCount?: number;
  availableSpaces?: number;
  reservedCardsCount: number;
  totalCardsSold?: number;
  totalCollectedEtb?: number;
  adeyShareEtb?: number;
  winnersPrizePoolEtb?: number;
  status: 'countdown' | 'live' | 'waiting' | 'completed';
  lifecycleStage?: GameLifecycleStage;
  currentGameId: string;
  hostUid: string;
}

export async function fetchRoomsFromServerApi(): Promise<ServerRoomSummary[]> {
  const headers = await buildAuthenticatedHeaders();
  const resp = await fetch('/api/rooms', { method: 'GET', headers });
  if (!resp.ok) {
    throw new Error(`GET /api/rooms failed (${resp.status})`);
  }
  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data.rooms) ? (data.rooms as ServerRoomSummary[]) : [];
}

export async function fetchRoomDetailFromServerApi(roomId: string): Promise<{
  room: ServerRoomSummary;
  myCardIds: number[];
  takenCardIds: number[];
  game: FirestoreLiveGameSession | null;
  serverNowMs?: number;
} | null> {
  const headers = await buildAuthenticatedHeaders();
  const resp = await fetch(`/api/rooms?roomId=${encodeURIComponent(roomId)}`, {
    method: 'GET',
    headers,
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  if (!data.ok || !data.room) return null;
  return {
    room: data.room as ServerRoomSummary,
    myCardIds: Array.isArray(data.myCardIds) ? data.myCardIds.map(Number) : [],
    takenCardIds: Array.isArray(data.takenCardIds) ? data.takenCardIds.map(Number) : [],
    game: data.game ? (data.game as FirestoreLiveGameSession) : null,
    serverNowMs: typeof data.serverNowMs === 'number' ? data.serverNowMs : undefined,
  };
}

export async function fetchPlayerStateFromApi(): Promise<
  import('../types/bingo').PlayerStateResponse | null
> {
  const token = await getActiveBearerToken();
  if (!token) return null;
  const headers = await buildAuthenticatedHeaders();
  const resp = await fetch('/api/player/state', { method: 'GET', headers });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) return null;
  return data as import('../types/bingo').PlayerStateResponse;
}

export async function submitPlayerWalletAction(
  payload:
    | { action: 'apply_promo'; code: string }
    | { action: 'deposit_request'; amountEtb: number; provider: string }
    | { action: 'withdraw_request'; amountEtb: number; method: string }
    | { action: 'support_ticket'; category: string; subject: string; message: string }
): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
  bonusEtb?: number;
  updatedBalanceEtb?: number;
  availableBalanceEtb?: number;
  deposit?: import('../types/bingo').DepositRequestSummary;
  withdrawal?: import('../types/bingo').PayoutRequestSummary;
  ticket?: import('../types/bingo').SupportTicket;
}> {
  const token = await getActiveBearerToken();
  if (!token) {
    return {
      ok: false,
      error: 'unauthenticated_demo_mode',
      message: 'Please authenticate inside Telegram Mini App to perform account transactions.',
    };
  }
  const headers = await buildAuthenticatedHeaders();
  const idempotencyKey = `wallet_${payload.action}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const resp = await fetch('/api/player/wallet', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      ...payload,
      idempotencyKey,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return {
      ok: false,
      error: data.error || data.reason || `http_${resp.status}`,
      message: data.message || `Request failed (${resp.status})`,
      availableBalanceEtb:
        typeof data.availableBalanceEtb === 'number' ? data.availableBalanceEtb : undefined,
    };
  }
  return {
    ok: true,
    bonusEtb: typeof data.bonusEtb === 'number' ? data.bonusEtb : undefined,
    updatedBalanceEtb:
      typeof data.updatedBalanceEtb === 'number' ? data.updatedBalanceEtb : undefined,
    deposit: data.deposit,
    withdrawal: data.withdrawal,
    ticket: data.ticket,
  };
}
