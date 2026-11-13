import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { INITIAL_ROOMS } from '../../src/data/demoData.ts';
import {
  checkCardWin,
  formatBallCall,
  generateDeterministicCard,
  getLetterForNumber,
  isRoomEligibleToStart,
} from '../../src/game/rules.ts';
import type { WinResult } from '../../src/types/bingo.ts';
import { PersistentReplayGuard } from './replayGuard.ts';

export interface PersistentGameSessionDoc {
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

export interface RoomSummary {
  roomId: string;
  nameAm: string;
  nameEn: string;
  cardPrice: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  minPlayers: number;
  countdownSeconds: number;
  activePlayersCount: number;
  reservedCardsCount: number;
  status: 'waiting' | 'countdown' | 'live' | 'completed';
  currentGameId: string;
  hostUid: string;
}

export interface RoomDetailResult {
  ok: boolean;
  reason?: 'room_not_found';
  room?: RoomSummary;
  myCardIds?: number[];
  takenCardIds?: number[];
  game?: PersistentGameSessionDoc | null;
}

export interface CreateRoomResult {
  ok: boolean;
  reason?: 'invalid_room_input' | 'room_already_exists';
  room?: RoomSummary;
}

export interface StartGameResult {
  ok: boolean;
  reason?:
    | 'replay_detected'
    | 'room_not_found'
    | 'unauthorized_caller'
    | 'game_already_live'
    | 'game_already_completed'
    | 'eligibility_not_met';
  game?: PersistentGameSessionDoc;
}

export interface PersistentCardToggleResult {
  ok: boolean;
  reason?:
    | 'duplicate_request'
    | 'invalid_card_id'
    | 'room_not_found'
    | 'room_already_live'
    | 'room_completed'
    | 'room_full'
    | 'user_not_found'
    | 'insufficient_balance'
    | 'card_already_taken'
    | 'card_already_reserved'
    | 'card_not_reserved'
    | 'max_4_cards_reached';
  action?: 'reserved' | 'released';
  cardIds?: number[];
  updatedBalanceEtb?: number;
}

export interface PersistentDrawBallResult {
  ok: boolean;
  reason?:
    | 'replay_detected'
    | 'room_not_found'
    | 'unauthorized_caller'
    | 'game_already_completed'
    | 'all_75_numbers_called';
  ball?: number;
  letter?: ReturnType<typeof getLetterForNumber>;
  formatted?: string;
  calledNumbers?: number[];
  totalCalled?: number;
  serverTimestamp?: string;
}

export interface PersistentVerifyWinnerResult {
  verified: boolean;
  reason?:
    | 'duplicate_request'
    | 'invalid_card_id'
    | 'room_not_found'
    | 'game_not_found'
    | 'game_already_completed'
    | 'winner_profile_not_found'
    | 'card_not_owned_by_claimant'
    | 'pattern_not_satisfied';
  cardId: number;
  winResult?: WinResult;
  demoPrizeEtb?: number;
  serverVerifiedAt: string;
}

/**
 * Abstract store interface for Bingo room, card ownership, game session, and demo ledger persistence.
 */
export interface GamePersistenceStore {
  ensureDefaultRooms(): Promise<void>;
  listRooms(): Promise<RoomSummary[]>;
  getRoomDetail(roomId: string, viewerUid: string): Promise<RoomDetailResult>;
  createRoomAtomic(params: {
    roomId: string;
    nameAm: string;
    nameEn: string;
    cardPrice: number;
    countdownSeconds?: number;
    hostUid: string;
  }): Promise<CreateRoomResult>;
  startGameAtomic(params: {
    roomId: string;
    gameId: string;
    callerUid: string;
    isAdmin?: boolean;
  }): Promise<StartGameResult>;
  toggleCardReservation(params: {
    roomId: string;
    cardId: number;
    uid: string;
    displayName: string;
    telegramUserId: string;
    expectedAction?: 'reserve' | 'release' | 'toggle';
  }): Promise<PersistentCardToggleResult>;
  drawNextBallAtomic(params: {
    roomId: string;
    gameId: string;
    callerUid: string;
    isAdmin?: boolean;
    requireExplicitHostOrAdmin?: boolean;
  }): Promise<PersistentDrawBallResult>;
  verifyWinnerAndCreditAtomic(params: {
    roomId: string;
    gameId: string;
    claimantUid: string;
    playerName: string;
    cardId: number;
    markedNumbers: number[];
  }): Promise<PersistentVerifyWinnerResult>;
  resetGameRoundAtomic(params: {
    roomId: string;
    gameId: string;
    callerUid: string;
    isAdmin?: boolean;
    requireExplicitHostOrAdmin?: boolean;
  }): Promise<{ ok: boolean; reason?: 'unauthorized_caller' | 'room_not_found' | 'replay_detected' }>;
}

export function createFirestoreGameStore(db: Firestore): GamePersistenceStore {
  const roomsCol = db.collection('rooms');
  const gamesCol = db.collection('games');
  const usersCol = db.collection('users');
  const transactionsCol = db.collection('transactions');

  function mapRoomDoc(docId: string, data: Record<string, unknown>): RoomSummary {
    const rawStatus = String(data.status || 'countdown');
    const status: RoomSummary['status'] =
      rawStatus === 'waiting' ||
      rawStatus === 'countdown' ||
      rawStatus === 'live' ||
      rawStatus === 'completed'
        ? rawStatus
        : 'countdown';
    return {
      roomId: String(data.roomId || docId),
      nameAm: String(data.nameAm || ''),
      nameEn: String(data.nameEn || ''),
      cardPrice: Number(data.cardPrice ?? 10),
      maxCardsPerRoom: Number(data.maxCardsPerRoom ?? 600),
      maxCardsPerPlayer: Number(data.maxCardsPerPlayer ?? 4),
      minPlayers: Number(data.minPlayers ?? 3),
      countdownSeconds: Number(data.countdownSeconds ?? 60),
      activePlayersCount: Number(data.activePlayersCount ?? 0),
      reservedCardsCount: Number(data.reservedCardsCount ?? 0),
      status,
      currentGameId: String(data.currentGameId || `game_${docId}_live`),
      hostUid: String(data.hostUid || ''),
    };
  }

  return {
    async ensureDefaultRooms(): Promise<void> {
      for (const rm of INITIAL_ROOMS) {
        const roomRef = roomsCol.doc(rm.id);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(roomRef);
          if (!snap.exists) {
            tx.set(roomRef, {
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
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        });
      }
    },

    async listRooms(): Promise<RoomSummary[]> {
      const snap = await roomsCol.get();
      return snap.docs.map((d) => mapRoomDoc(d.id, (d.data() || {}) as Record<string, unknown>));
    },

    async getRoomDetail(roomId: string, viewerUid: string): Promise<RoomDetailResult> {
      const roomRef = roomsCol.doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) {
        return { ok: false, reason: 'room_not_found' };
      }

      const room = mapRoomDoc(roomSnap.id, (roomSnap.data() || {}) as Record<string, unknown>);
      const [playerSnap, cardsSnap, gameSnap] = await Promise.all([
        roomRef.collection('players').doc(viewerUid).get(),
        roomRef.collection('cards').get(),
        room.currentGameId ? gamesCol.doc(room.currentGameId).get() : Promise.resolve(null),
      ]);

      const myCardIds: number[] = playerSnap.exists
        ? Array.isArray(playerSnap.get('cardIds'))
          ? (playerSnap.get('cardIds') as unknown[]).map(Number).filter(Number.isInteger)
          : []
        : [];
      const takenCardIds: number[] = cardsSnap.docs
        .map((d) => Number(d.get('cardId') ?? d.id))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 600)
        .sort((a, b) => a - b);

      const game = gameSnap && gameSnap.exists
        ? (gameSnap.data() as PersistentGameSessionDoc)
        : null;

      return {
        ok: true,
        room,
        myCardIds,
        takenCardIds,
        game,
      };
    },

    async createRoomAtomic({
      roomId,
      nameAm,
      nameEn,
      cardPrice,
      countdownSeconds = 60,
      hostUid,
    }): Promise<CreateRoomResult> {
      const cleanRoomId = roomId.trim();
      const cleanNameAm = nameAm.trim();
      const cleanNameEn = nameEn.trim();
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(cleanRoomId) ||
        cleanNameAm.length < 1 ||
        cleanNameAm.length > 100 ||
        cleanNameEn.length < 1 ||
        cleanNameEn.length > 100 ||
        !Number.isInteger(cardPrice) ||
        cardPrice < 5 ||
        cardPrice > 100 ||
        !Number.isInteger(countdownSeconds) ||
        countdownSeconds < 0 ||
        countdownSeconds > 60 ||
        !hostUid.trim()
      ) {
        return { ok: false, reason: 'invalid_room_input' };
      }

      const roomRef = roomsCol.doc(cleanRoomId);
      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (snap.exists) {
          return { ok: false, reason: 'room_already_exists' };
        }

        const docData = {
          roomId: cleanRoomId,
          nameAm: cleanNameAm,
          nameEn: cleanNameEn,
          cardPrice,
          maxCardsPerRoom: 600,
          maxCardsPerPlayer: 4,
          minPlayers: 3,
          countdownSeconds,
          activePlayersCount: 0,
          reservedCardsCount: 0,
          status: 'countdown' as const,
          currentGameId: `game_${cleanRoomId}_live`,
          hostUid: hostUid.trim().slice(0, 128),
          updatedAt: FieldValue.serverTimestamp(),
        };
        tx.set(roomRef, docData);
        return {
          ok: true,
          room: mapRoomDoc(cleanRoomId, docData),
        };
      });
    },

    async startGameAtomic({
      roomId,
      gameId,
      callerUid,
      isAdmin = false,
    }): Promise<StartGameResult> {
      const roomRef = roomsCol.doc(roomId);
      const gameRef = gamesCol.doc(gameId);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, gameSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
        ]);

        if (!roomSnap.exists) {
          return { ok: false, reason: 'room_not_found' };
        }

        const roomHostUid = String(roomSnap.get('hostUid') || '').trim();
        const gameHostUid = gameSnap.exists ? String(gameSnap.get('hostUid') || '').trim() : '';
        const existingHost = roomHostUid || gameHostUid;

        if (existingHost) {
          if (callerUid !== existingHost && !isAdmin) {
            return { ok: false, reason: 'unauthorized_caller' };
          }
        } else if (!isAdmin) {
          return { ok: false, reason: 'unauthorized_caller' };
        }

        const roomStatus = String(roomSnap.get('status') || 'countdown');
        const gameStatus = gameSnap.exists ? String(gameSnap.get('status') || '') : '';

        if (roomStatus === 'completed' || gameStatus === 'completed') {
          return { ok: false, reason: 'game_already_completed' };
        }
        if (roomStatus === 'live' || gameStatus === 'live') {
          return { ok: false, reason: 'game_already_live' };
        }

        const activePlayersCount = Number(roomSnap.get('activePlayersCount') ?? 0);
        const reservedCardsCount = Number(roomSnap.get('reservedCardsCount') ?? 0);
        const minPlayers = Number(roomSnap.get('minPlayers') ?? 3);

        if (!isRoomEligibleToStart(activePlayersCount, reservedCardsCount, minPlayers)) {
          return { ok: false, reason: 'eligibility_not_met' };
        }

        const openingBall = crypto.randomInt(1, 76);
        const resolvedHost = existingHost || callerUid;
        const roundNumber = gameSnap.exists ? Number(gameSnap.get('roundNumber') ?? 1) : 1;

        const sessionDoc: PersistentGameSessionDoc = {
          gameId,
          roomId,
          hostUid: resolvedHost,
          roundNumber,
          status: 'live',
          calledNumbers: [openingBall],
          latestBall: openingBall,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
        };

        if (gameSnap.exists) {
          tx.update(gameRef, {
            ...sessionDoc,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(gameRef, {
            ...sessionDoc,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.update(roomRef, {
          status: 'live',
          currentGameId: gameId,
          hostUid: resolvedHost,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return { ok: true, game: sessionDoc };
      });
    },

    async toggleCardReservation({
      roomId,
      cardId,
      uid,
      displayName,
      telegramUserId,
      expectedAction = 'toggle',
    }): Promise<PersistentCardToggleResult> {
      if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
        return { ok: false, reason: 'invalid_card_id' };
      }

      const roomRef = roomsCol.doc(roomId);
      const cardRef = roomRef.collection('cards').doc(String(cardId));
      const playerRef = roomRef.collection('players').doc(uid);
      const userRef = usersCol.doc(uid);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, cardSnap, playerSnap, userSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(cardRef),
          tx.get(playerRef),
          tx.get(userRef),
        ]);

        if (!roomSnap.exists) {
          return { ok: false, reason: 'room_not_found' };
        }

        const currentGameId = String(roomSnap.get('currentGameId') || '');
        const gameSnap = currentGameId
          ? await tx.get(gamesCol.doc(currentGameId))
          : null;

        const roomStatus = String(roomSnap.get('status') || 'waiting');
        const gameStatus = gameSnap?.exists ? String(gameSnap.get('status') || '') : '';

        if (roomStatus === 'completed' || gameStatus === 'completed') {
          return { ok: false, reason: 'room_completed' };
        }
        if (roomStatus === 'live' || gameStatus === 'live') {
          return { ok: false, reason: 'room_already_live' };
        }

        if (!userSnap.exists) {
          return { ok: false, reason: 'user_not_found' };
        }

        const cardPrice = Number(roomSnap.get('cardPrice') ?? 10);
        const currentBalance = Number(userSnap.get('demoBalanceEtb') ?? 0);
        const existingCardIds: number[] = playerSnap.exists
          ? Array.isArray(playerSnap.get('cardIds'))
            ? (playerSnap.get('cardIds') as unknown[]).map(Number)
            : []
          : [];
        const currentReservedCount = Number(roomSnap.get('reservedCardsCount') ?? 0);
        const currentPlayersCount = Number(roomSnap.get('activePlayersCount') ?? 0);

        if (cardSnap.exists) {
          if (cardSnap.get('ownerId') !== uid) {
            return { ok: false, reason: 'card_already_taken' };
          }
          if (expectedAction === 'reserve') {
            return { ok: false, reason: 'card_already_reserved' };
          }
          const nextCardIds = existingCardIds.filter((id) => id !== cardId);
          const updatedBalance = Math.min(100000, currentBalance + cardPrice);
          const txId = `tx_rel_${crypto.randomUUID()}`;

          tx.delete(cardRef);
          if (nextCardIds.length === 0) {
            tx.delete(playerRef);
            tx.update(roomRef, {
              reservedCardsCount: Math.max(0, currentReservedCount - 1),
              activePlayersCount: Math.max(0, currentPlayersCount - 1),
              updatedAt: FieldValue.serverTimestamp(),
            });
          } else {
            tx.set(playerRef, {
              playerId: uid,
              roomId,
              displayName: displayName.slice(0, 80),
              telegramUserId: telegramUserId.slice(0, 64),
              cardIds: nextCardIds,
              updatedAt: FieldValue.serverTimestamp(),
            });
            tx.update(roomRef, {
              reservedCardsCount: Math.max(0, currentReservedCount - 1),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }

          tx.update(userRef, {
            demoBalanceEtb: updatedBalance,
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.set(transactionsCol.doc(txId), {
            transactionId: txId,
            userId: uid,
            type: 'card_entry',
            amountEtb: cardPrice,
            status: 'demo_completed',
            description: `Card #${cardId} Release Refund (${roomId})`.slice(0, 160),
            reference: `ADB-REL-${cardId}`,
            createdAt: FieldValue.serverTimestamp(),
          });

          return {
            ok: true,
            action: 'released',
            cardIds: nextCardIds,
            updatedBalanceEtb: updatedBalance,
          };
        }

        if (expectedAction === 'release') {
          return { ok: false, reason: 'card_not_reserved' };
        }

        if (existingCardIds.length >= 4) {
          return { ok: false, reason: 'max_4_cards_reached' };
        }
        if (currentReservedCount >= 600) {
          return { ok: false, reason: 'room_full' };
        }
        if (currentBalance < cardPrice) {
          return { ok: false, reason: 'insufficient_balance' };
        }

        const nextCardIds = [...existingCardIds, cardId].sort((a, b) => a - b);
        const serial = `ADB-${String(cardId).padStart(3, '0')}`;
        const updatedBalance = Math.max(0, currentBalance - cardPrice);
        const txId = `tx_ent_${crypto.randomUUID()}`;

        tx.set(playerRef, {
          playerId: uid,
          roomId,
          displayName: displayName.slice(0, 80),
          telegramUserId: telegramUserId.slice(0, 64),
          cardIds: nextCardIds,
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(cardRef, {
          cardId,
          roomId,
          ownerId: uid,
          ownerName: displayName.slice(0, 80),
          serial,
          reservedAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          reservedCardsCount: currentReservedCount + 1,
          activePlayersCount: playerSnap.exists
            ? currentPlayersCount
            : Math.min(600, currentPlayersCount + 1),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(userRef, {
          demoBalanceEtb: updatedBalance,
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: uid,
          type: 'card_entry',
          amountEtb: -cardPrice,
          status: 'demo_completed',
          description: `Card #${cardId} Entry (${roomId})`.slice(0, 160),
          reference: `ADB-ENT-${cardId}`,
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          action: 'reserved',
          cardIds: nextCardIds,
          updatedBalanceEtb: updatedBalance,
        };
      });
    },

    async drawNextBallAtomic({
      roomId,
      gameId,
      callerUid,
      isAdmin = false,
      requireExplicitHostOrAdmin = false,
    }): Promise<PersistentDrawBallResult> {
      const roomRef = roomsCol.doc(roomId);
      const gameRef = gamesCol.doc(gameId);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, gameSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
        ]);

        if (!roomSnap.exists) {
          return { ok: false, reason: 'room_not_found' };
        }

        let calledNumbers: number[] = [];
        const roomHostUid = String(roomSnap.get('hostUid') || '').trim();
        let hostUid = roomHostUid || callerUid;
        let roundNumber = 1;
        let isNewGame = false;

        if (gameSnap.exists) {
          const data = gameSnap.data() as PersistentGameSessionDoc;
          if (data.status === 'completed') {
            return { ok: false, reason: 'game_already_completed' };
          }
          hostUid = String(data.hostUid || roomHostUid || '').trim();
          const authorized =
            callerUid === 'server' ||
            isAdmin ||
            (hostUid !== '' && hostUid === callerUid);
          if (!authorized) {
            return { ok: false, reason: 'unauthorized_caller' };
          }
          roundNumber = Number(data.roundNumber ?? 1);
          calledNumbers = Array.isArray(data.calledNumbers)
            ? data.calledNumbers
                .map(Number)
                .filter((n) => Number.isInteger(n) && n >= 1 && n <= 75)
            : [];
        } else {
          if (roomHostUid) {
            if (roomHostUid !== callerUid && callerUid !== 'server' && !isAdmin) {
              return { ok: false, reason: 'unauthorized_caller' };
            }
          } else if (requireExplicitHostOrAdmin && callerUid !== 'server' && !isAdmin) {
            return { ok: false, reason: 'unauthorized_caller' };
          }
          isNewGame = true;
          calledNumbers = [9, 30, 7, 16, 14];
        }

        const calledSet = new Set<number>(calledNumbers);
        const remaining: number[] = [];
        for (let n = 1; n <= 75; n++) {
          if (!calledSet.has(n)) {
            remaining.push(n);
          }
        }

        if (remaining.length === 0) {
          return { ok: false, reason: 'all_75_numbers_called' };
        }

        const drawnBall = remaining[crypto.randomInt(0, remaining.length)];
        const updatedCalls = [...calledNumbers, drawnBall];

        if (isNewGame) {
          tx.set(gameRef, {
            gameId,
            roomId,
            hostUid,
            roundNumber,
            status: 'live',
            calledNumbers: updatedCalls,
            latestBall: drawnBall,
            winnerUid: '',
            winnerName: '',
            winningCardId: 0,
            winningPattern: '',
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(gameRef, {
            status: 'live',
            calledNumbers: updatedCalls,
            latestBall: drawnBall,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        if (roomSnap.get('status') !== 'live') {
          tx.update(roomRef, {
            status: 'live',
            currentGameId: gameId,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        return {
          ok: true,
          ball: drawnBall,
          letter: getLetterForNumber(drawnBall),
          formatted: formatBallCall(drawnBall),
          calledNumbers: updatedCalls,
          totalCalled: updatedCalls.length,
          serverTimestamp: new Date().toISOString(),
        };
      });
    },

    async verifyWinnerAndCreditAtomic({
      roomId,
      gameId,
      claimantUid,
      playerName,
      cardId,
      markedNumbers,
    }): Promise<PersistentVerifyWinnerResult> {
      const nowIso = new Date().toISOString();
      if (!Number.isInteger(cardId) || cardId < 1 || cardId > 600) {
        return { verified: false, reason: 'invalid_card_id', cardId, serverVerifiedAt: nowIso };
      }

      const roomRef = roomsCol.doc(roomId);
      const gameRef = gamesCol.doc(gameId);
      const cardRef = roomRef.collection('cards').doc(String(cardId));
      const playerRef = roomRef.collection('players').doc(claimantUid);
      const userRef = usersCol.doc(claimantUid);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, gameSnap, cardSnap, playerSnap, userSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
          tx.get(cardRef),
          tx.get(playerRef),
          tx.get(userRef),
        ]);

        if (!roomSnap.exists) {
          return {
            verified: false,
            reason: 'room_not_found',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        if (!gameSnap.exists) {
          return {
            verified: false,
            reason: 'game_not_found',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        const gameData = gameSnap.data() as PersistentGameSessionDoc;
        if (gameData.status === 'completed') {
          return {
            verified: false,
            reason: 'game_already_completed',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        if (!userSnap.exists) {
          return {
            verified: false,
            reason: 'winner_profile_not_found',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        const playerCardIds: number[] = playerSnap.exists
          ? Array.isArray(playerSnap.get('cardIds'))
            ? (playerSnap.get('cardIds') as unknown[]).map(Number)
            : []
          : [];
        const ownsCard =
          cardSnap.exists &&
          cardSnap.get('ownerId') === claimantUid &&
          playerCardIds.includes(cardId);

        if (!ownsCard) {
          return {
            verified: false,
            reason: 'card_not_owned_by_claimant',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        const authoritativeCalls = Array.isArray(gameData.calledNumbers)
          ? gameData.calledNumbers.map(Number)
          : [];
        const card = generateDeterministicCard(cardId);
        const winResult = checkCardWin(card, markedNumbers, authoritativeCalls, true);

        if (!winResult.won) {
          return {
            verified: false,
            reason: 'pattern_not_satisfied',
            cardId,
            winResult,
            serverVerifiedAt: nowIso,
          };
        }

        const cardPrice = Number(roomSnap.get('cardPrice') ?? 10);
        const demoPrizeEtb = Math.max(50, playerCardIds.length * cardPrice * 4);
        const patternLabel = (winResult.patternLabelEn || 'Bingo Line').slice(0, 64);
        const roundNumber = Number(gameData.roundNumber ?? 1);
        const currentBal = Number(userSnap.get('demoBalanceEtb') ?? 250);
        const txId = `tx_win_${gameId}_r${roundNumber}`;

        tx.update(gameRef, {
          status: 'completed',
          winnerUid: claimantUid,
          winnerName: playerName.slice(0, 80),
          winningCardId: cardId,
          winningPattern: patternLabel,
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          status: 'completed',
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(userRef, {
          demoBalanceEtb: Math.min(100000, currentBal + demoPrizeEtb),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: claimantUid,
          type: 'bingo_win',
          amountEtb: demoPrizeEtb,
          status: 'demo_completed',
          description: `Server-verified Bingo Win (Card #${cardId} · ${patternLabel})`.slice(
            0,
            160
          ),
          reference: `ADB-WIN-${gameId}-R${roundNumber}`.slice(0, 64),
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          verified: true,
          cardId,
          winResult,
          demoPrizeEtb,
          serverVerifiedAt: nowIso,
        };
      });
    },

    async resetGameRoundAtomic({
      roomId,
      gameId,
      callerUid,
      isAdmin = false,
      requireExplicitHostOrAdmin = false,
    }) {
      const roomRef = roomsCol.doc(roomId);
      const gameRef = gamesCol.doc(gameId);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, gameSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
        ]);

        if (!roomSnap.exists) {
          return { ok: false, reason: 'room_not_found' as const };
        }

        const roomHostUid = String(roomSnap.get('hostUid') || '').trim();
        const gameHostUid = gameSnap.exists ? String(gameSnap.get('hostUid') || '').trim() : '';
        const existingHost = gameHostUid || roomHostUid;

        if (existingHost) {
          if (existingHost !== callerUid && callerUid !== 'server' && !isAdmin) {
            return { ok: false, reason: 'unauthorized_caller' as const };
          }
        } else if (requireExplicitHostOrAdmin && callerUid !== 'server' && !isAdmin) {
          return { ok: false, reason: 'unauthorized_caller' as const };
        }

        const nextRound = gameSnap.exists
          ? Number(gameSnap.get('roundNumber') ?? 1) + 1
          : 1;
        const hostUid = existingHost || callerUid;

        tx.set(gameRef, {
          gameId,
          roomId,
          hostUid,
          roundNumber: nextRound,
          status: 'countdown',
          calledNumbers: [9, 30, 7, 16, 14],
          latestBall: 14,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          status: 'countdown',
          currentGameId: gameId,
          hostUid,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return { ok: true };
      });
    },
  };
}

/**
 * Server-authoritative game service backed by Firestore transactions and persistent replay protection.
 */
export class PersistentGameAuthorityService {
  private readonly store: GamePersistenceStore;
  private readonly replayGuard: PersistentReplayGuard;

  constructor(store: GamePersistenceStore, replayGuard: PersistentReplayGuard) {
    this.store = store;
    this.replayGuard = replayGuard;
  }

  public async listAvailableRooms(): Promise<RoomSummary[]> {
    await this.store.ensureDefaultRooms();
    return await this.store.listRooms();
  }

  public async getRoomDetail(roomId: string, viewerUid: string): Promise<RoomDetailResult> {
    await this.store.ensureDefaultRooms();
    return await this.store.getRoomDetail(roomId, viewerUid);
  }

  public async createRoom(params: {
    roomId: string;
    nameAm: string;
    nameEn: string;
    cardPrice: number;
    countdownSeconds?: number;
    hostUid: string;
  }): Promise<CreateRoomResult> {
    return await this.store.createRoomAtomic(params);
  }

  public async initializeDefaultRooms(): Promise<RoomSummary[]> {
    await this.store.ensureDefaultRooms();
    return await this.store.listRooms();
  }

  public async startGame(params: {
    roomId: string;
    gameId?: string;
    callerUid: string;
    isAdmin?: boolean;
    idempotencyKey?: string;
  }): Promise<StartGameResult> {
    if (params.idempotencyKey) {
      const fresh = await this.replayGuard.consumeOnce(
        'game_draw',
        `start:${params.callerUid}:${params.roomId}:${params.idempotencyKey}`,
        { ttlSeconds: 300 }
      );
      if (!fresh.fresh) {
        return { ok: false, reason: 'replay_detected' };
      }
    }
    await this.store.ensureDefaultRooms();
    return await this.store.startGameAtomic({
      roomId: params.roomId,
      gameId: params.gameId || `game_${params.roomId}_live`,
      callerUid: params.callerUid,
      isAdmin: params.isAdmin,
    });
  }

  public async reserveOrReleaseCard(params: {
    roomId: string;
    cardId: number;
    uid: string;
    displayName: string;
    telegramUserId: string;
    expectedAction?: 'reserve' | 'release' | 'toggle';
    idempotencyKey?: string;
  }): Promise<PersistentCardToggleResult> {
    if (params.idempotencyKey) {
      const fresh = await this.replayGuard.consumeOnce(
        'card_tx',
        `${params.uid}:${params.roomId}:${params.idempotencyKey}`,
        { ttlSeconds: 3600 }
      );
      if (!fresh.fresh) {
        return { ok: false, reason: 'duplicate_request' };
      }
    }
    await this.store.ensureDefaultRooms();
    return await this.store.toggleCardReservation(params);
  }

  public async drawNextBall(params: {
    roomId: string;
    gameId?: string;
    callerUid: string;
    requestNonce?: string;
    isAdmin?: boolean;
    requireExplicitHostOrAdmin?: boolean;
  }): Promise<PersistentDrawBallResult> {
    if (params.requestNonce) {
      const fresh = await this.replayGuard.consumeOnce(
        'game_draw',
        `${params.roomId}:${params.requestNonce}`,
        { ttlSeconds: 300 }
      );
      if (!fresh.fresh) {
        return { ok: false, reason: 'replay_detected' };
      }
    }
    await this.store.ensureDefaultRooms();
    return await this.store.drawNextBallAtomic({
      roomId: params.roomId,
      gameId: params.gameId || `game_${params.roomId}_live`,
      callerUid: params.callerUid,
      isAdmin: params.isAdmin,
      requireExplicitHostOrAdmin: params.requireExplicitHostOrAdmin,
    });
  }

  public async verifyWinner(params: {
    roomId: string;
    gameId?: string;
    claimantUid: string;
    playerName: string;
    cardId: number;
    markedNumbers: number[];
    idempotencyKey?: string;
  }): Promise<PersistentVerifyWinnerResult> {
    if (params.idempotencyKey) {
      const fresh = await this.replayGuard.consumeOnce(
        'card_tx',
        `win:${params.claimantUid}:${params.roomId}:${params.idempotencyKey}`,
        { ttlSeconds: 3600 }
      );
      if (!fresh.fresh) {
        return {
          verified: false,
          reason: 'duplicate_request',
          cardId: params.cardId,
          serverVerifiedAt: new Date().toISOString(),
        };
      }
    }
    return await this.store.verifyWinnerAndCreditAtomic({
      roomId: params.roomId,
      gameId: params.gameId || `game_${params.roomId}_live`,
      claimantUid: params.claimantUid,
      playerName: params.playerName,
      cardId: params.cardId,
      markedNumbers: params.markedNumbers,
    });
  }

  public async resetRound(params: {
    roomId: string;
    gameId?: string;
    callerUid: string;
    isAdmin?: boolean;
    requireExplicitHostOrAdmin?: boolean;
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; reason?: 'unauthorized_caller' | 'room_not_found' | 'replay_detected' }> {
    if (params.idempotencyKey) {
      const fresh = await this.replayGuard.consumeOnce(
        'game_draw',
        `reset:${params.callerUid}:${params.roomId}:${params.idempotencyKey}`,
        { ttlSeconds: 300 }
      );
      if (!fresh.fresh) {
        return { ok: false, reason: 'replay_detected' };
      }
    }
    await this.store.ensureDefaultRooms();
    return await this.store.resetGameRoundAtomic({
      roomId: params.roomId,
      gameId: params.gameId || `game_${params.roomId}_live`,
      callerUid: params.callerUid,
      isAdmin: params.isAdmin,
      requireExplicitHostOrAdmin: params.requireExplicitHostOrAdmin,
    });
  }
}
