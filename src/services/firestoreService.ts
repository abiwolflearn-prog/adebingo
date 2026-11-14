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
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import { Language, WinResult } from '../types/bingo';
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
  calledNumbers: number[];
  latestBall: number;
  winnerUid: string;
  winnerName: string;
  winningCardId: number;
  winningPattern: string;
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
        demoBalanceEtb: Number(data.demoBalanceEtb ?? 250),
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
          demoBalanceEtb: Number(d.demoBalanceEtb ?? 250),
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
        demoBalanceEtb: Number(d.demoBalanceEtb ?? 250),
      });
    },
    () => {
      // Ignore transient listener permission errors when custom token is not active
    }
  );
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
 * Subscribes in real time to all Reserved Cards (/rooms/{roomId}/cards) and Players (/rooms/{roomId}/players).
 */
export function subscribeToRoomState(
  roomId: string,
  onCardsChange: (reservations: FirestoreCardReservation[]) => void,
  onPlayersChange: (players: FirestoreRoomPlayer[]) => void
): Unsubscribe {
  const cardsPath = `rooms/${roomId}/cards`;
  const playersPath = `rooms/${roomId}/players`;

  const qCards = query(
    collection(db, 'rooms', roomId, 'cards'),
    where('roomId', '==', roomId)
  );
  const unsubCards = onSnapshot(
    qCards,
    (snap) => {
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
      try {
        handleFirestoreError(err, OperationType.LIST, playersPath);
      } catch {
        // Handled by caller fallback
      }
    }
  );

  return () => {
    unsubCards();
    unsubPlayers();
  };
}

/**
 * Subscribes in real time to a live game session (/games/{gameId}) via Firestore onSnapshot.
 */
export function subscribeToGameState(
  gameId: string,
  onGameChange: (game: FirestoreLiveGameSession) => void
): Unsubscribe {
  const gameRef = doc(db, 'games', gameId);
  return onSnapshot(
    gameRef,
    (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      onGameChange({
        gameId: String(d.gameId || gameId),
        roomId: String(d.roomId || ''),
        hostUid: String(d.hostUid || ''),
        roundNumber: typeof d.roundNumber === 'number' ? d.roundNumber : 1,
        status:
          d.status === 'live' || d.status === 'completed' ? d.status : 'countdown',
        calledNumbers: Array.isArray(d.calledNumbers)
          ? d.calledNumbers.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 75)
          : [],
        latestBall: Number(d.latestBall ?? 0),
        winnerUid: String(d.winnerUid || ''),
        winnerName: String(d.winnerName || ''),
        winningCardId: Number(d.winningCardId ?? 0),
        winningPattern: String(d.winningPattern || ''),
      });
    },
    () => {
      // Ignore listener permission errors when unauthenticated
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
