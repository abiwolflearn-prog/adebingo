import {
  signInWithPopup,
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
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import { INITIAL_ROOMS } from '../data/demoData';
import { Language } from '../types/bingo';
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

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutFromFirebase(): Promise<void> {
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
 * Saves and verifies the player's phone number into the isolated PII subcollection
 * /users/{uid}/private/contact and marks phoneVerified = true on /users/{uid}.
 */
export async function saveVerifiedPhoneNumber(
  uid: string,
  rawPhoneNumber: string,
  method: 'telegram_contact' | 'sms_otp_demo'
): Promise<FirestorePrivateContact> {
  const cleanedPhone = rawPhoneNumber.replace(/[\s\-()]/g, '');
  if (!/^\+?[0-9]{9,15}$/.test(cleanedPhone)) {
    throw new Error('Invalid phone number format. Use 9 to 15 digits (e.g. +251911223344).');
  }

  const contactPath = `users/${uid}/private/contact`;
  const userPath = `users/${uid}`;

  try {
    const contactRef = doc(db, 'users', uid, 'private', 'contact');
    await setDoc(contactRef, {
      uid,
      phoneNumber: cleanedPhone,
      phoneVerified: true,
      verificationMethod: method,
      updatedAt: serverTimestamp(),
    });

    const userRef = doc(db, 'users', uid);
    await updateDoc(userRef, {
      phoneVerified: true,
      updatedAt: serverTimestamp(),
    });

    return {
      uid,
      phoneNumber: cleanedPhone,
      phoneVerified: true,
      verificationMethod: method,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `${contactPath} | ${userPath}`);
  }
}

/**
 * Seeds the 3 default ADEYBINGO rooms into /rooms/{roomId} if they do not exist yet.
 */
export async function ensureDefaultRoomsInFirestore(): Promise<void> {
  for (const rm of INITIAL_ROOMS) {
    const roomPath = `rooms/${rm.id}`;
    try {
      const roomRef = doc(db, 'rooms', rm.id);
      const snap = await getDoc(roomRef);
      if (!snap.exists()) {
        await setDoc(roomRef, {
          roomId: rm.id,
          nameAm: rm.nameAm.slice(0, 100),
          nameEn: rm.nameEn.slice(0, 100),
          cardPrice: rm.cardPrice,
          maxCardsPerRoom: 600,
          maxCardsPerPlayer: 4,
          minPlayers: 3,
          countdownSeconds: 60,
          activePlayersCount: rm.activePlayers,
          reservedCardsCount: rm.takenCardIds.length,
          status: rm.status,
          currentGameId: `game_${rm.id}_live`,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, roomPath);
    }
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
      handleFirestoreError(err, OperationType.LIST, cardsPath);
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
      handleFirestoreError(err, OperationType.LIST, playersPath);
    }
  );

  return () => {
    unsubCards();
    unsubPlayers();
  };
}

/**
 * Atomically reserves or releases a card (1..600) in Firestore using runTransaction.
 * Guarantees:
 * - Card ID is strictly between 1 and 600.
 * - Prevents duplicate reservation or hijacking another user's card.
 * - Enforces max 4 cards per player both in client transaction and in Firestore Security Rules (getAfter).
 */
export async function toggleCardReservationAtomic(params: {
  roomId: string;
  cardId: number;
  uid: string;
  displayName: string;
  telegramUserId: string;
}): Promise<{
  action: 'reserved' | 'released';
  updatedCardIds: number[];
}> {
  const { roomId, cardId, uid, displayName, telegramUserId } = params;
  if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
    throw new Error('Card ID must be an integer between 1 and 600.');
  }

  const cardDocPath = `rooms/${roomId}/cards/${cardId}`;
  const playerDocPath = `rooms/${roomId}/players/${uid}`;

  try {
    return await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', roomId);
      const cardRef = doc(db, 'rooms', roomId, 'cards', String(cardId));
      const playerRef = doc(db, 'rooms', roomId, 'players', uid);

      const [roomSnap, cardSnap, playerSnap] = await Promise.all([
        tx.get(roomRef),
        tx.get(cardRef),
        tx.get(playerRef),
      ]);

      if (!roomSnap.exists()) {
        throw new Error(`Room ${roomId} does not exist.`);
      }

      const existingCardIds: number[] = playerSnap.exists()
        ? (playerSnap.data().cardIds || []).map(Number)
        : [];

      // Case 1: Card is already reserved
      if (cardSnap.exists()) {
        const cardOwner = cardSnap.data().ownerId;
        if (cardOwner !== uid) {
          throw new Error(`Card #${cardId} is already reserved by another player.`);
        }

        // Release card owned by current player
        const nextCardIds = existingCardIds.filter((id) => id !== cardId);
        tx.delete(cardRef);

        if (nextCardIds.length === 0) {
          tx.delete(playerRef);
        } else {
          tx.set(playerRef, {
            playerId: uid,
            roomId,
            displayName: displayName.slice(0, 80),
            telegramUserId: telegramUserId.slice(0, 64),
            cardIds: nextCardIds,
            updatedAt: serverTimestamp(),
          });
        }

        return { action: 'released' as const, updatedCardIds: nextCardIds };
      }

      // Case 2: Card is free -> Reserve it if player has < 4 cards
      if (existingCardIds.length >= 4) {
        throw new Error('Maximum 4 cards per player reached.');
      }

      const nextCardIds = [...existingCardIds, cardId].sort((a, b) => a - b);
      const serial = `ADB-${String(cardId).padStart(3, '0')}`;

      tx.set(playerRef, {
        playerId: uid,
        roomId,
        displayName: displayName.slice(0, 80),
        telegramUserId: telegramUserId.slice(0, 64),
        cardIds: nextCardIds,
        updatedAt: serverTimestamp(),
      });

      tx.set(cardRef, {
        cardId,
        roomId,
        ownerId: uid,
        ownerName: displayName.slice(0, 80),
        serial,
        reservedAt: serverTimestamp(),
      });

      return { action: 'reserved' as const, updatedCardIds: nextCardIds };
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Maximum 4 cards') ||
        error.message.includes('already reserved'))
    ) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `${cardDocPath} | ${playerDocPath}`);
  }
}

/**
 * Records an immutable demo transaction entry in /transactions/{transactionId}.
 */
export async function recordDemoTransactionInFirestore(params: {
  uid: string;
  type: 'deposit_demo' | 'withdraw_demo' | 'card_entry' | 'bingo_win' | 'referral_bonus';
  amountEtb: number;
  status: 'demo_completed' | 'demo_pending';
  description: string;
  reference: string;
}): Promise<void> {
  const txId = `tx_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
  const txPath = `transactions/${txId}`;
  try {
    await setDoc(doc(db, 'transactions', txId), {
      transactionId: txId,
      userId: params.uid,
      type: params.type,
      amountEtb: Math.max(-5000, Math.min(5000, params.amountEtb)),
      status: params.status,
      description: params.description.slice(0, 160),
      reference: params.reference.slice(0, 64),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, txPath);
  }
}

/**
 * Records an immutable demo referral entry in /referrals/{referralId}.
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
      status: 'qualified',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, refPath);
  }
}

/**
 * Syncs or creates a live game session document in /games/{gameId}.
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
  const gamePath = `games/${params.gameId}`;
  const gameRef = doc(db, 'games', params.gameId);
  try {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) {
      await setDoc(gameRef, {
        gameId: params.gameId,
        roomId: params.roomId,
        hostUid: params.hostUid,
        status: params.status,
        calledNumbers: params.calledNumbers.slice(0, 75),
        latestBall: params.latestBall,
        winnerUid: params.winnerUid || '',
        winnerName: (params.winnerName || '').slice(0, 80),
        winningCardId: params.winningCardId || 0,
        winningPattern: (params.winningPattern || '').slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (snap.data().status !== 'completed') {
      if (params.status === 'completed' && params.winnerUid) {
        await updateDoc(gameRef, {
          status: 'completed',
          winnerUid: params.winnerUid,
          winnerName: (params.winnerName || '').slice(0, 80),
          winningCardId: params.winningCardId || 1,
          winningPattern: (params.winningPattern || '').slice(0, 64),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(gameRef, {
          status: 'live',
          calledNumbers: params.calledNumbers.slice(0, 75),
          latestBall: params.latestBall,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, gamePath);
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
