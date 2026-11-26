import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { AUTHORITATIVE_PRODUCTION_ROOMS } from '../../src/game/roomCatalog.ts';
import {
  type AuthoritativeGameFinancials,
  calculateAuthoritativeGameFinancials,
  checkCardWin,
  formatBallCall,
  generateDeterministicCard,
  getLetterForNumber,
  isRoomEligibleToStart,
  resolveGameLifecycleStage,
} from '../../src/game/rules.ts';
import {
  evaluateRoundWinners,
  type RoomCardOwnerEntry,
  type RoundSettlementResult,
  type RoundWinnerShare,
} from '../../src/game/roundSettlement.ts';
import type { GameLifecycleStage, WinResult } from '../../src/types/bingo.ts';
import { PersistentReplayGuard } from './replayGuard.ts';

export const SCHEDULER_LEASES_COLLECTION = 'schedulerLeases';
export const SCHEDULER_AUDIT_LOGS_COLLECTION = 'schedulerAuditLogs';
export const DEFAULT_REGISTRATION_WINDOW_MS = 60_000;
export const DEFAULT_BALL_DRAW_INTERVAL_MS = 3_000;
export const DEFAULT_INTERMISSION_MS = 6_000;
export const DEFAULT_STUCK_SESSION_TIMEOUT_MS = 30_000;

export type SchedulerActionType =
  | 'noop'
  | 'lease_busy_skipped'
  | 'countdown_synced'
  | 'registration_extended'
  | 'game_auto_started'
  | 'ball_auto_drawn'
  | 'winner_auto_settled'
  | 'next_game_auto_created'
  | 'stuck_session_recovered';

export interface SchedulerAuditLogEntry {
  logId: string;
  roomId: string;
  gameId: string;
  roundNumber: number;
  action: SchedulerActionType;
  confirmedPlayersCount: number;
  totalCardsSold: number;
  totalCollectedEtb: number;
  adeyShareEtb: number;
  winnersPrizePoolEtb: number;
  details: string;
  workerId: string;
  timestampMs: number;
}

export interface SchedulerTickResult {
  ok: boolean;
  roomId: string;
  gameId: string;
  roundNumber: number;
  action: SchedulerActionType;
  status: 'waiting' | 'countdown' | 'live' | 'completed';
  lifecycleStage: GameLifecycleStage;
  confirmedPlayersCount: number;
  availableSpaces: number;
  totalCardsSold: number;
  totalCollectedEtb: number;
  adeyShareEtb: number;
  winnersPrizePoolEtb: number;
  registrationDeadlineMs: number;
  nextBallDrawAtMs: number;
  intermissionEndsAtMs: number;
  extendedRegistrationCount: number;
  drawnBall?: number;
  calledNumbers?: number[];
  settlement?: RoundSettlementResult;
  scheduleNoticeAm?: string;
  scheduleNoticeEn?: string;
  reason?: string;
}

export interface PersistentGameSessionDoc {
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
  winners?: RoundWinnerShare[];
  nextBallDrawAtMs?: number;
  intermissionEndsAtMs?: number;
}

export interface RoomSummary {
  roomId: string;
  nameAm: string;
  nameEn: string;
  cardPrice: number;
  maxPlayersPerRoom?: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  minPlayers: number;
  countdownSeconds: number;
  roundNumber?: number;
  roundStartedAtMs?: number;
  registrationDeadlineMs?: number;
  nextBallDrawAtMs?: number;
  intermissionEndsAtMs?: number;
  extendedRegistrationCount?: number;
  scheduleNoticeAm?: string;
  scheduleNoticeEn?: string;
  activePlayersCount: number;
  confirmedPlayersCount?: number;
  verifiedPaidEntriesCount?: number;
  availableSpaces?: number;
  reservedCardsCount: number;
  totalCardsSold?: number;
  totalCollectedEtb?: number;
  adeyShareEtb?: number;
  winnersPrizePoolEtb?: number;
  status: 'waiting' | 'countdown' | 'live' | 'completed';
  lifecycleStage?: GameLifecycleStage;
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
    | 'account_suspended'
    | 'insufficient_balance'
    | 'card_already_taken'
    | 'card_already_reserved'
    | 'card_not_reserved'
    | 'max_4_cards_reached';
  action?: 'reserved' | 'released';
  cardIds?: number[];
  updatedBalanceEtb?: number;
  financials?: AuthoritativeGameFinancials;
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
  winners?: RoundWinnerShare[];
  winnersPrizePoolEtb?: number;
  adeyShareEtb?: number;
  totalCollectedEtb?: number;
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
  tickRoomSchedulerAtomic(params: {
    roomId: string;
    nowMs?: number;
    workerId?: string;
    registrationWindowMs?: number;
    ballDrawIntervalMs?: number;
    intermissionMs?: number;
    stuckSessionTimeoutMs?: number;
    skipCountdownSync?: boolean;
  }): Promise<SchedulerTickResult>;
  ensureSharedRegistrationDeadline(roomId: string, nowMs?: number): Promise<number>;
  validateRoomIntegrity(roomId: string): Promise<RoomIntegrityReport>;
  reconcileRoomStateAtomic(
    roomId: string,
    nowMs?: number,
    options?: ReconcileRoomOptions
  ): Promise<RoomReconcileResult>;
  listSchedulerAuditLogs(roomId?: string, limitCount?: number): Promise<SchedulerAuditLogEntry[]>;
}

export interface RoomIntegrityDiscrepancy {
  field: string;
  stored: unknown;
  expected: unknown;
  severity: 'warning' | 'error';
  message: string;
}

export interface RoomIntegrityReport {
  ok: boolean;
  roomId: string;
  exists: boolean;
  valid: boolean;
  discrepancies: RoomIntegrityDiscrepancy[];
  stored?: {
    status: string;
    cardPrice: number;
    activePlayersCount: number;
    confirmedPlayersCount: number;
    reservedCardsCount: number;
    totalCardsSold: number;
    totalCollectedEtb: number;
    adeyShareEtb: number;
    winnersPrizePoolEtb: number;
    registrationDeadlineMs: number;
  };
  computed?: {
    cardPrice: number;
    confirmedPlayersCount: number;
    totalCardsSold: number;
    totalCollectedEtb: number;
    adeyShareEtb: number;
    winnersPrizePoolEtb: number;
    availableSpaces: number;
    playerDocsCount: number;
    cardDocsCount: number;
    gameStatus?: string;
  };
}

export interface ReconcileRoomOptions {
  dryRun?: boolean;
  confirmApply?: boolean;
  requestedByUid?: string;
  requestedByName?: string;
}

export interface RoomReconcileResult {
  ok: boolean;
  roomId: string;
  dryRun?: boolean;
  reconciled: boolean;
  changes: string[];
  backupId?: string;
  beforeSnapshot?: Record<string, unknown>;
  proposedPatch?: Record<string, unknown>;
  report?: RoomIntegrityReport;
  reason?: 'room_not_found' | 'approval_required';
}

/**
 * Pure server-side predicate: returns true when a room's authoritative Firestore
 * deadline is missing/uninitialized (<= 0) or has expired and requires a server scheduler transition.
 */
export function isRoomDueForSchedulerTick(
  room: Pick<
    RoomSummary,
    'status' | 'registrationDeadlineMs' | 'nextBallDrawAtMs' | 'intermissionEndsAtMs'
  >,
  nowMs: number = Date.now()
): boolean {
  if (room.status === 'countdown' || room.status === 'waiting') {
    const deadlineMs = Number(room.registrationDeadlineMs ?? 0);
    return deadlineMs <= 0 || nowMs >= deadlineMs;
  }
  if (room.status === 'live') {
    const nextDrawMs = Number(room.nextBallDrawAtMs ?? 0);
    return nextDrawMs <= 0 || nowMs >= nextDrawMs;
  }
  if (room.status === 'completed') {
    const intermissionEndMs = Number(room.intermissionEndsAtMs ?? 0);
    return intermissionEndMs <= 0 || nowMs >= intermissionEndMs;
  }
  return false;
}

export function createFirestoreGameStore(db: Firestore): GamePersistenceStore {
  const roomsCol = db.collection('rooms');
  const gamesCol = db.collection('games');
  const usersCol = db.collection('users');
  const botPlayersCol = db.collection('botPlayers');
  const transactionsCol = db.collection('transactions');
  const schedulerLeasesCol = db.collection(SCHEDULER_LEASES_COLLECTION);
  const schedulerAuditCol = db.collection(SCHEDULER_AUDIT_LOGS_COLLECTION);
  const botOutboxCol = db.collection('botOutbox');

  function extractTelegramIdFromUid(uid: string): number {
    const m = /^tg_([1-9]\d*)$/.exec(uid);
    return m ? Number(m[1]) : 0;
  }

  function mapRoomDoc(docId: string, data: Record<string, unknown>, nowMs: number = Date.now()): RoomSummary {
    const rawStatus = String(data.status || 'countdown');
    const status: RoomSummary['status'] =
      rawStatus === 'waiting' ||
      rawStatus === 'countdown' ||
      rawStatus === 'live' ||
      rawStatus === 'completed'
        ? rawStatus
        : 'countdown';
    const cardPrice = Number(data.cardPrice ?? data.cardPriceEtb ?? 10);
    const minPlayers = Number(data.minPlayers ?? 3);
    const registrationDeadlineMs = Number(data.registrationDeadlineMs ?? 0);
    const intermissionEndsAtMs = Number(data.intermissionEndsAtMs ?? 0);
    const roundStartedAtMs = Number(data.roundStartedAtMs ?? 0);
    const storedCountdownSeconds = Number(data.countdownSeconds ?? 60);
    // Server-authoritative live remaining seconds derived from persistent deadlines
    const countdownSeconds =
      status === 'live'
        ? 0
        : status === 'completed'
          ? intermissionEndsAtMs > 0
            ? Math.max(0, Math.ceil((intermissionEndsAtMs - nowMs) / 1000))
            : 0
          : registrationDeadlineMs > 0
            ? Math.max(0, Math.ceil((registrationDeadlineMs - nowMs) / 1000))
            : storedCountdownSeconds;
    const activePlayersCount = Number(data.activePlayersCount ?? 0);
    const reservedCardsCount = Number(data.reservedCardsCount ?? 0);
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
    });
    return {
      roomId: String(data.roomId || docId),
      nameAm: String(data.nameAm || ''),
      nameEn: String(data.nameEn || ''),
      cardPrice,
      maxPlayersPerRoom: financials.maxCapacityPlayers,
      maxCardsPerRoom: Number(data.maxCardsPerRoom ?? 600),
      maxCardsPerPlayer: Number(data.maxCardsPerPlayer ?? 4),
      minPlayers,
      countdownSeconds,
      roundNumber: Number(data.roundNumber ?? 1),
      roundStartedAtMs,
      registrationDeadlineMs,
      nextBallDrawAtMs: Number(data.nextBallDrawAtMs ?? 0),
      intermissionEndsAtMs: Number(data.intermissionEndsAtMs ?? 0),
      extendedRegistrationCount: Number(data.extendedRegistrationCount ?? 0),
      scheduleNoticeAm: data.scheduleNoticeAm ? String(data.scheduleNoticeAm) : undefined,
      scheduleNoticeEn: data.scheduleNoticeEn ? String(data.scheduleNoticeEn) : undefined,
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
      currentGameId: String(data.currentGameId || `game_${docId}_live`),
      hostUid: String(data.hostUid || ''),
    };
  }

  return {
    async ensureDefaultRooms(): Promise<void> {
      const nowMs = Date.now();
      for (const rm of AUTHORITATIVE_PRODUCTION_ROOMS) {
        const roomRef = roomsCol.doc(rm.id);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(roomRef);
          if (!snap.exists) {
            const lifecycleStage = resolveGameLifecycleStage({
              status: 'countdown',
              confirmedPlayersCount: 0,
              countdownSeconds: rm.countdownSeconds,
              minPlayers: rm.minPlayers,
            });
            tx.set(roomRef, {
              roomId: rm.id,
              nameAm: rm.nameAm.slice(0, 100),
              nameEn: rm.nameEn.slice(0, 100),
              cardPrice: rm.cardPrice,
              cardPriceEtb: rm.cardPrice,
              maxPlayersPerRoom: rm.maxPlayersPerRoom,
              maxCardsPerRoom: rm.maxCardsPerRoom,
              maxCardsPerPlayer: rm.maxCardsPerPlayer,
              minPlayers: rm.minPlayers,
              countdownSeconds: rm.countdownSeconds,
              lobbyCountdownSeconds: rm.countdownSeconds,
              roundNumber: 1,
              roundStartedAtMs: nowMs,
              registrationDeadlineMs: nowMs + rm.countdownSeconds * 1000,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: 0,
              activePlayersCount: 0,
              confirmedPlayersCount: 0,
              verifiedPaidEntriesCount: 0,
              availableSpaces: rm.maxPlayersPerRoom,
              reservedCardsCount: 0,
              totalCardsSold: 0,
              totalCollectedEtb: 0,
              adeyShareEtb: 0,
              winnersPrizePoolEtb: 0,
              status: 'countdown',
              adminStatus: 'open',
              lifecycleStage,
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

        const nowMs = Date.now();
        const docData = {
          roomId: cleanRoomId,
          nameAm: cleanNameAm,
          nameEn: cleanNameEn,
          cardPrice,
          maxPlayersPerRoom: 600,
          maxCardsPerRoom: 600,
          maxCardsPerPlayer: 4,
          minPlayers: 3,
          countdownSeconds,
          roundNumber: 1,
          roundStartedAtMs: nowMs,
          registrationDeadlineMs: nowMs + Math.max(10, countdownSeconds) * 1000,
          activePlayersCount: 0,
          confirmedPlayersCount: 0,
          verifiedPaidEntriesCount: 0,
          availableSpaces: 600,
          reservedCardsCount: 0,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          status: 'countdown' as const,
          lifecycleStage: 'WAITING' as const,
          currentGameId: `game_${cleanRoomId}_live`,
          hostUid: hostUid.trim().slice(0, 128),
          updatedAt: FieldValue.serverTimestamp(),
        };
        tx.set(roomRef, docData);
        return {
          ok: true,
          room: mapRoomDoc(cleanRoomId, docData, nowMs),
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
        const cardPrice = Number(roomSnap.get('cardPrice') ?? 10);

        if (!isRoomEligibleToStart(activePlayersCount, reservedCardsCount, minPlayers)) {
          return { ok: false, reason: 'eligibility_not_met' };
        }

        const openingBall = crypto.randomInt(1, 76);
        const nowMs = Date.now();
        const nextBallDrawAtMs = nowMs + DEFAULT_BALL_DRAW_INTERVAL_MS;
        const resolvedHost = existingHost || callerUid;
        const roundNumber = gameSnap.exists ? Number(gameSnap.get('roundNumber') ?? 1) : 1;
        const financials = calculateAuthoritativeGameFinancials(
          activePlayersCount,
          reservedCardsCount,
          cardPrice
        );

        const sessionDoc: PersistentGameSessionDoc = {
          gameId,
          roomId,
          hostUid: resolvedHost,
          roundNumber,
          status: 'live',
          lifecycleStage: 'IN_PROGRESS',
          calledNumbers: [openingBall],
          latestBall: openingBall,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          confirmedPlayersCount: financials.confirmedPlayersCount,
          availableSpaces: financials.availableSpaces,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          nextBallDrawAtMs,
          intermissionEndsAtMs: 0,
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
          lifecycleStage: 'IN_PROGRESS',
          countdownSeconds: 0,
          nextBallDrawAtMs,
          intermissionEndsAtMs: 0,
          lastSchedulerTickMs: nowMs,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
          availableSpaces: financials.availableSpaces,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
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
      const tgId = extractTelegramIdFromUid(uid);
      const botPlayerRef = tgId > 0 ? botPlayersCol.doc(String(tgId)) : null;

      return await db.runTransaction(async (tx) => {
        const [roomSnap, cardSnap, playerSnap, userSnap, botPlayerSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(cardRef),
          tx.get(playerRef),
          tx.get(userRef),
          botPlayerRef ? tx.get(botPlayerRef) : Promise.resolve(null),
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
        if (String(userSnap.get('accountStatus') || 'active') === 'suspended') {
          return { ok: false, reason: 'account_suspended' };
        }

        const cardPrice = Number(roomSnap.get('cardPrice') ?? roomSnap.get('cardPriceEtb') ?? 10);
        const minPlayers = Number(roomSnap.get('minPlayers') ?? 3);
        const countdownSeconds = Number(roomSnap.get('countdownSeconds') ?? 60);
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
          const updatedBalance = Math.min(1_000_000, Number((currentBalance + cardPrice).toFixed(2)));
          const txId = `tx_rel_${crypto.randomUUID()}`;
          const nextReservedCount = Math.max(0, currentReservedCount - 1);
          const nextPlayersCount =
            nextCardIds.length === 0 ? Math.max(0, currentPlayersCount - 1) : currentPlayersCount;
          const nextFinancials = calculateAuthoritativeGameFinancials(
            nextPlayersCount,
            nextReservedCount,
            cardPrice
          );
          const nextLifecycle = resolveGameLifecycleStage({
            status: 'countdown',
            confirmedPlayersCount: nextFinancials.confirmedPlayersCount,
            countdownSeconds,
            minPlayers,
          });

          tx.delete(cardRef);
          if (nextCardIds.length === 0) {
            tx.delete(playerRef);
            tx.update(roomRef, {
              reservedCardsCount: nextReservedCount,
              totalCardsSold: nextFinancials.totalCardsSold,
              activePlayersCount: nextFinancials.confirmedPlayersCount,
              confirmedPlayersCount: nextFinancials.confirmedPlayersCount,
              verifiedPaidEntriesCount: nextFinancials.verifiedPaidEntriesCount,
              availableSpaces: nextFinancials.availableSpaces,
              totalCollectedEtb: nextFinancials.totalCollectedEtb,
              adeyShareEtb: nextFinancials.adeyShareEtb,
              winnersPrizePoolEtb: nextFinancials.winnersPrizePoolEtb,
              lifecycleStage: nextLifecycle,
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
              reservedCardsCount: nextReservedCount,
              totalCardsSold: nextFinancials.totalCardsSold,
              activePlayersCount: nextFinancials.confirmedPlayersCount,
              confirmedPlayersCount: nextFinancials.confirmedPlayersCount,
              verifiedPaidEntriesCount: nextFinancials.verifiedPaidEntriesCount,
              availableSpaces: nextFinancials.availableSpaces,
              totalCollectedEtb: nextFinancials.totalCollectedEtb,
              adeyShareEtb: nextFinancials.adeyShareEtb,
              winnersPrizePoolEtb: nextFinancials.winnersPrizePoolEtb,
              lifecycleStage: nextLifecycle,
              updatedAt: FieldValue.serverTimestamp(),
            });
          }

          tx.update(userRef, {
            demoBalanceEtb: updatedBalance,
            updatedAt: FieldValue.serverTimestamp(),
          });
          if (botPlayerRef && botPlayerSnap?.exists) {
            tx.update(botPlayerRef, {
              demoBalanceEtb: updatedBalance,
              updatedAt: new Date().toISOString(),
            });
          }
          tx.set(transactionsCol.doc(txId), {
            transactionId: txId,
            userId: uid,
            type: 'card_entry',
            amountEtb: cardPrice,
            balanceBeforeEtb: currentBalance,
            balanceAfterEtb: updatedBalance,
            status: 'demo_completed',
            description: `Card #${cardId} Release Refund (${roomId})`.slice(0, 160),
            reference: `ADB-REL-${cardId}`,
            relatedId: roomId,
            idempotencyKey: txId,
            createdAt: FieldValue.serverTimestamp(),
          });

          return {
            ok: true,
            action: 'released',
            cardIds: nextCardIds,
            updatedBalanceEtb: updatedBalance,
            financials: nextFinancials,
          };
        }

        if (expectedAction === 'release') {
          return { ok: false, reason: 'card_not_reserved' };
        }

        if (existingCardIds.length >= 4) {
          return { ok: false, reason: 'max_4_cards_reached' };
        }
        // Strict 600 individual player cap AND 600 card cap
        if (!playerSnap.exists && currentPlayersCount >= 600) {
          return { ok: false, reason: 'room_full' };
        }
        if (currentReservedCount >= 600) {
          return { ok: false, reason: 'room_full' };
        }
        if (currentBalance < cardPrice) {
          return { ok: false, reason: 'insufficient_balance' };
        }

        const nextCardIds = [...existingCardIds, cardId].sort((a, b) => a - b);
        const serial = `ADB-${String(cardId).padStart(3, '0')}`;
        const updatedBalance = Math.max(0, Number((currentBalance - cardPrice).toFixed(2)));
        const txId = `tx_ent_${crypto.randomUUID()}`;
        const nextReservedCount = currentReservedCount + 1;
        const nextPlayersCount = playerSnap.exists
          ? currentPlayersCount
          : Math.min(600, currentPlayersCount + 1);
        const nextFinancials = calculateAuthoritativeGameFinancials(
          nextPlayersCount,
          nextReservedCount,
          cardPrice
        );
        const nextLifecycle = resolveGameLifecycleStage({
          status: 'countdown',
          confirmedPlayersCount: nextFinancials.confirmedPlayersCount,
          countdownSeconds,
          minPlayers,
        });

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
          reservedCardsCount: nextReservedCount,
          totalCardsSold: nextFinancials.totalCardsSold,
          activePlayersCount: nextFinancials.confirmedPlayersCount,
          confirmedPlayersCount: nextFinancials.confirmedPlayersCount,
          verifiedPaidEntriesCount: nextFinancials.verifiedPaidEntriesCount,
          availableSpaces: nextFinancials.availableSpaces,
          totalCollectedEtb: nextFinancials.totalCollectedEtb,
          adeyShareEtb: nextFinancials.adeyShareEtb,
          winnersPrizePoolEtb: nextFinancials.winnersPrizePoolEtb,
          lifecycleStage: nextLifecycle,
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(userRef, {
          demoBalanceEtb: updatedBalance,
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (botPlayerRef && botPlayerSnap?.exists) {
          tx.update(botPlayerRef, {
            demoBalanceEtb: updatedBalance,
            updatedAt: new Date().toISOString(),
          });
        }

        tx.set(transactionsCol.doc(txId), {
          transactionId: txId,
          userId: uid,
          type: 'card_entry',
          amountEtb: -cardPrice,
          balanceBeforeEtb: currentBalance,
          balanceAfterEtb: updatedBalance,
          status: 'demo_completed',
          description: `Card #${cardId} Entry (${roomId})`.slice(0, 160),
          reference: `ADB-ENT-${cardId}`,
          relatedId: roomId,
          idempotencyKey: txId,
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          action: 'reserved',
          cardIds: nextCardIds,
          updatedBalanceEtb: updatedBalance,
          financials: nextFinancials,
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
          calledNumbers = [];
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
        const nextBallDrawAtMs = Date.now() + DEFAULT_BALL_DRAW_INTERVAL_MS;

        if (isNewGame) {
          tx.set(gameRef, {
            gameId,
            roomId,
            hostUid,
            roundNumber,
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            calledNumbers: updatedCalls,
            latestBall: drawnBall,
            nextBallDrawAtMs,
            intermissionEndsAtMs: 0,
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
            lifecycleStage: 'IN_PROGRESS',
            calledNumbers: updatedCalls,
            latestBall: drawnBall,
            nextBallDrawAtMs,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        if (roomSnap.get('status') !== 'live') {
          tx.update(roomRef, {
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            currentGameId: gameId,
            nextBallDrawAtMs,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(roomRef, {
            nextBallDrawAtMs,
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
      const tgId = extractTelegramIdFromUid(claimantUid);

      return await db.runTransaction(async (tx) => {
        const [roomSnap, gameSnap, cardSnap, playerSnap, userSnap, cardsSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
          tx.get(cardRef),
          tx.get(playerRef),
          tx.get(userRef),
          roomRef.collection('cards').get(),
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

        const cardPrice = Number(roomSnap.get('cardPrice') ?? roomSnap.get('cardPriceEtb') ?? 10);
        const activePlayersCount = Number(
          roomSnap.get('confirmedPlayersCount') ?? roomSnap.get('activePlayersCount') ?? 0
        );
        const reservedCardsCount = Number(
          roomSnap.get('totalCardsSold') ?? roomSnap.get('reservedCardsCount') ?? 0
        );
        const financials = calculateAuthoritativeGameFinancials(
          activePlayersCount,
          reservedCardsCount,
          cardPrice
        );
        const patternLabel = (winResult.patternLabelEn || 'Bingo Line').slice(0, 64);
        const roundNumber = Number(gameData.roundNumber ?? 1);

        // Evaluate ALL reserved cards in the room so simultaneous co-winners split the 80% prize pool fairly
        const cardEntries: RoomCardOwnerEntry[] = cardsSnap.docs
          .map((cDoc) => {
            const cid = Number(cDoc.get('cardId') ?? cDoc.id);
            const ownerId = String(cDoc.get('ownerId') || '').trim();
            const ownerName = String(
              cDoc.get('ownerName') || (ownerId === claimantUid ? playerName : ownerId)
            ).slice(0, 80);
            return {
              cardId: cid,
              uid: ownerId,
              telegramUserId: extractTelegramIdFromUid(ownerId),
              displayName: ownerName,
            };
          })
          .filter(
            (e) => Number.isInteger(e.cardId) && e.cardId >= 1 && e.cardId <= 600 && e.uid.length > 0
          );

        if (!cardEntries.some((e) => e.cardId === cardId && e.uid === claimantUid)) {
          cardEntries.push({
            cardId,
            uid: claimantUid,
            telegramUserId: tgId,
            displayName: playerName.slice(0, 80),
          });
        }

        const settlement = evaluateRoundWinners({
          entries: cardEntries,
          calledNumbers: authoritativeCalls,
          cardPrice,
          totalCardsInRoom: financials.totalCardsSold,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          useAuthoritative8020Split: true,
        });

        const payoutsByPlayer =
          settlement.payoutsByPlayer.length > 0
            ? settlement.payoutsByPlayer
            : [
                {
                  uid: claimantUid,
                  telegramUserId: tgId,
                  displayName: playerName.slice(0, 80),
                  cardIds: [cardId],
                  totalPrizeEtb: financials.winnersPrizePoolEtb,
                },
              ];

        const winnerShares: RoundWinnerShare[] =
          settlement.winners.length > 0
            ? settlement.winners
            : [
                {
                  uid: claimantUid,
                  telegramUserId: tgId,
                  displayName: playerName.slice(0, 80),
                  cardId,
                  patternType: winResult.patternType || 'row',
                  patternLabelAm: winResult.patternLabelAm || 'አሸናፊ መስመር',
                  patternLabelEn: patternLabel,
                  winningCells: winResult.winningCells || [],
                  prizeEtb: financials.winnersPrizePoolEtb,
                },
              ];

        // Deterministic idempotent transaction IDs (single-winner keeps legacy txId for compatibility)
        const payoutTxIds = payoutsByPlayer.map((p, i) =>
          i === 0 && payoutsByPlayer.length === 1
            ? `tx_win_${gameId}_r${roundNumber}`
            : `tx_win_${gameId}_r${roundNumber}_${p.uid}`
        );
        const legacySingleTxId = `tx_win_${gameId}_r${roundNumber}`;

        // Firestore read-before-write rule: fetch all winner profiles, botPlayers, and tx docs first
        const [winnerUserSnaps, winnerBotSnaps, existingWinTxSnaps, legacyTxSnap] = await Promise.all([
          Promise.all(
            payoutsByPlayer.map((p) =>
              p.uid === claimantUid ? Promise.resolve(userSnap) : tx.get(usersCol.doc(p.uid))
            )
          ),
          Promise.all(
            payoutsByPlayer.map((p) =>
              p.telegramUserId > 0
                ? tx.get(botPlayersCol.doc(String(p.telegramUserId)))
                : Promise.resolve(null)
            )
          ),
          Promise.all(payoutTxIds.map((id) => tx.get(transactionsCol.doc(id)))),
          payoutTxIds.includes(legacySingleTxId)
            ? Promise.resolve(null)
            : tx.get(transactionsCol.doc(legacySingleTxId)),
        ]);

        if (
          legacyTxSnap?.exists ||
          existingWinTxSnaps.some((snap) => snap.exists)
        ) {
          return {
            verified: false,
            reason: 'game_already_completed',
            cardId,
            serverVerifiedAt: nowIso,
          };
        }

        const claimantPayout = payoutsByPlayer.find((p) => p.uid === claimantUid);
        const claimantPrizeEtb = claimantPayout
          ? claimantPayout.totalPrizeEtb
          : financials.winnersPrizePoolEtb;
        const intermissionEndsAtMs = Date.now() + DEFAULT_INTERMISSION_MS;
        const primaryWinner = winnerShares.find((w) => w.uid === claimantUid && w.cardId === cardId) || winnerShares[0];
        const completedPayload = {
          status: 'completed' as const,
          lifecycleStage: 'COMPLETED' as const,
          roomNameAm: String(roomSnap.get('nameAm') || roomId),
          roomNameEn: String(roomSnap.get('nameEn') || roomId),
          cardPrice,
          entryFeeDemo: cardPrice,
          demoPrizeEtb: financials.winnersPrizePoolEtb,
          winnerUid: primaryWinner.uid,
          winnerName: primaryWinner.displayName.slice(0, 80),
          winningCardId: primaryWinner.cardId,
          winningPattern: primaryWinner.patternLabelEn || patternLabel,
          winners: winnerShares,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          availableSpaces: financials.availableSpaces,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs,
          completedAt: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        };

        tx.update(gameRef, completedPayload);
        tx.set(gamesCol.doc(`game_${roomId}_r${roundNumber}`), {
          gameId: `game_${roomId}_r${roundNumber}`,
          roomId,
          hostUid: String(gameData.hostUid || roomSnap.get('hostUid') || ''),
          roundNumber,
          calledNumbers: authoritativeCalls,
          latestBall: Number(gameData.latestBall ?? authoritativeCalls[authoritativeCalls.length - 1] ?? 0),
          ...completedPayload,
          createdAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          status: 'completed',
          lifecycleStage: 'COMPLETED',
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
          availableSpaces: financials.availableSpaces,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          updatedAt: FieldValue.serverTimestamp(),
        });

        for (let i = 0; i < payoutsByPlayer.length; i++) {
          const payout = payoutsByPlayer[i];
          const uSnap = winnerUserSnaps[i];
          const bSnap = winnerBotSnaps[i];
          const wUserRef = usersCol.doc(payout.uid);
          const currentBal = uSnap.exists ? Number(uSnap.get('demoBalanceEtb') ?? 0) : 0;
          const nextBal = Math.min(1_000_000, Number((currentBal + payout.totalPrizeEtb).toFixed(2)));
          if (uSnap.exists) {
            tx.update(wUserRef, {
              demoBalanceEtb: nextBal,
              updatedAt: FieldValue.serverTimestamp(),
            });
          } else {
            tx.set(wUserRef, {
              uid: payout.uid,
              telegramUserId: payout.telegramUserId > 0 ? `tg_${payout.telegramUserId}` : payout.uid,
              displayName: payout.displayName.slice(0, 80),
              username: payout.uid,
              language: 'am',
              phoneVerified: false,
              demoBalanceEtb: nextBal,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          if (payout.telegramUserId > 0 && bSnap?.exists) {
            tx.update(botPlayersCol.doc(String(payout.telegramUserId)), {
              demoBalanceEtb: nextBal,
              updatedAt: nowIso,
            });
          }

          const txId = payoutTxIds[i];
          tx.set(transactionsCol.doc(txId), {
            transactionId: txId,
            userId: payout.uid,
            type: 'bingo_win',
            amountEtb: payout.totalPrizeEtb,
            balanceBeforeEtb: currentBal,
            balanceAfterEtb: nextBal,
            status: 'demo_completed',
            description: `Server-verified Bingo Win (Card #${payout.cardIds.join(', #')} · ${
              payoutsByPlayer.length > 1 ? `Split x${winnerShares.length}` : patternLabel
            })`.slice(0, 160),
            reference: `ADB-WIN-${gameId}-R${roundNumber}`.slice(0, 64),
            relatedId: gameId,
            idempotencyKey: txId,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        return {
          verified: true,
          cardId,
          winResult,
          demoPrizeEtb: claimantPrizeEtb,
          winners: winnerShares,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          adeyShareEtb: financials.adeyShareEtb,
          totalCollectedEtb: financials.totalCollectedEtb,
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
        const [roomSnap, gameSnap, cardsSnap, playersSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(gameRef),
          roomRef.collection('cards').get(),
          roomRef.collection('players').get(),
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
        const minPlayers = Number(roomSnap.get('minPlayers') ?? 3);
        const nowMs = Date.now();
        const nextDeadlineMs = nowMs + DEFAULT_REGISTRATION_WINDOW_MS;
        const nextLifecycle = resolveGameLifecycleStage({
          status: 'countdown',
          confirmedPlayersCount: 0,
          countdownSeconds: 60,
          minPlayers,
        });

        for (const cDoc of cardsSnap.docs) {
          tx.delete(cDoc.ref);
        }
        for (const pDoc of playersSnap.docs) {
          tx.delete(pDoc.ref);
        }

        tx.set(gameRef, {
          gameId,
          roomId,
          hostUid,
          roundNumber: nextRound,
          status: 'countdown',
          lifecycleStage: nextLifecycle,
          calledNumbers: [],
          latestBall: 0,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          winners: [],
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          status: 'countdown',
          lifecycleStage: nextLifecycle,
          roundNumber: nextRound,
          countdownSeconds: 60,
          roundStartedAtMs: nowMs,
          registrationDeadlineMs: nextDeadlineMs,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          activePlayersCount: 0,
          confirmedPlayersCount: 0,
          verifiedPaidEntriesCount: 0,
          availableSpaces: 600,
          reservedCardsCount: 0,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          currentGameId: gameId,
          hostUid,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return { ok: true };
      });
    },

    async tickRoomSchedulerAtomic({
      roomId,
      nowMs = Date.now(),
      workerId = 'server_scheduler',
      registrationWindowMs = DEFAULT_REGISTRATION_WINDOW_MS,
      ballDrawIntervalMs = DEFAULT_BALL_DRAW_INTERVAL_MS,
      intermissionMs = DEFAULT_INTERMISSION_MS,
      stuckSessionTimeoutMs = DEFAULT_STUCK_SESSION_TIMEOUT_MS,
      skipCountdownSync = false,
    }): Promise<SchedulerTickResult> {
      const roomRef = roomsCol.doc(roomId);
      const leaseRef = schedulerLeasesCol.doc(roomId);
      const defaultGameId = `game_${roomId}_live`;

      return await db.runTransaction(async (tx) => {
        const [roomSnap, leaseSnap, playersSnap, cardsSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(leaseRef),
          roomRef.collection('players').get(),
          roomRef.collection('cards').get(),
        ]);

        if (!roomSnap.exists) {
          return {
            ok: false,
            roomId,
            gameId: defaultGameId,
            roundNumber: 1,
            action: 'noop',
            status: 'countdown',
            lifecycleStage: 'WAITING',
            confirmedPlayersCount: 0,
            availableSpaces: 600,
            totalCardsSold: 0,
            totalCollectedEtb: 0,
            adeyShareEtb: 0,
            winnersPrizePoolEtb: 0,
            registrationDeadlineMs: 0,
            nextBallDrawAtMs: 0,
            intermissionEndsAtMs: 0,
            extendedRegistrationCount: 0,
            reason: 'room_not_found',
          };
        }

        const roomData = (roomSnap.data() || {}) as Record<string, unknown>;
        const gameId = String(roomData.currentGameId || defaultGameId);
        const gameRef = gamesCol.doc(gameId);
        const gameSnap = await tx.get(gameRef);

        const rawStatus = String(roomData.status || 'countdown');
        const status: 'waiting' | 'countdown' | 'live' | 'completed' =
          rawStatus === 'waiting' ||
          rawStatus === 'countdown' ||
          rawStatus === 'live' ||
          rawStatus === 'completed'
            ? rawStatus
            : 'countdown';
        const cardPrice = Number(roomData.cardPrice ?? roomData.cardPriceEtb ?? 10);
        const minPlayers = Math.max(1, Number(roomData.minPlayers ?? 3));
        const roundNumber = Math.max(
          1,
          Number(roomData.roundNumber ?? (gameSnap.exists ? gameSnap.get('roundNumber') : 1) ?? 1)
        );
        const hostUid = String(roomData.hostUid || 'system_scheduler');

        // Recompute authoritative player and card counts from verified subcollections
        const cardEntries: RoomCardOwnerEntry[] = [];
        const uniqueOwnerUids = new Set<string>();
        for (const doc of cardsSnap.docs) {
          const d = (doc.data() || {}) as Record<string, unknown>;
          const cid = Number(d.cardId ?? doc.id);
          const ownerId = String(d.ownerId || '').trim();
          const ownerName = String(d.ownerName || ownerId).trim();
          if (Number.isInteger(cid) && cid >= 1 && cid <= 600 && ownerId) {
            uniqueOwnerUids.add(ownerId);
            const tgId = ownerId.startsWith('tg_') ? Number(ownerId.slice(3)) || 0 : 0;
            cardEntries.push({
              cardId: cid,
              uid: ownerId,
              telegramUserId: tgId,
              displayName: ownerName,
            });
          }
        }
        // Fallback if room doc was seeded directly in tests without card subcollection docs
        const authoritativePlayersCount =
          uniqueOwnerUids.size > 0
            ? uniqueOwnerUids.size
            : playersSnap.size > 0
              ? playersSnap.size
              : Number(roomData.confirmedPlayersCount ?? roomData.activePlayersCount ?? 0);
        const authoritativeCardsCount =
          cardEntries.length > 0
            ? cardEntries.length
            : Number(roomData.reservedCardsCount ?? roomData.totalCardsSold ?? 0);

        const financials = calculateAuthoritativeGameFinancials(
          authoritativePlayersCount,
          authoritativeCardsCount,
          cardPrice
        );

        let registrationDeadlineMs = Number(roomData.registrationDeadlineMs ?? 0);
        let nextBallDrawAtMs = Number(
          roomData.nextBallDrawAtMs ??
            (gameSnap.exists ? gameSnap.get('nextBallDrawAtMs') : 0) ??
            0
        );
        let intermissionEndsAtMs = Number(
          roomData.intermissionEndsAtMs ??
            (gameSnap.exists ? gameSnap.get('intermissionEndsAtMs') : 0) ??
            0
        );
        let extendedRegistrationCount = Number(roomData.extendedRegistrationCount ?? 0);

        // Lease guard: prevent concurrent workers from overlapping on the same tick or active lease window
        // without ever blocking a genuinely expired phase deadline.
        const isCurrentPhaseDue =
          status === 'waiting' || status === 'countdown'
            ? registrationDeadlineMs > 0 && nowMs >= registrationDeadlineMs
            : status === 'live'
              ? nextBallDrawAtMs <= 0 || nowMs >= nextBallDrawAtMs
              : intermissionEndsAtMs <= 0 || nowMs >= intermissionEndsAtMs;

        if (leaseSnap.exists) {
          const leaseData = (leaseSnap.data() || {}) as Record<string, unknown>;
          const leaseWorker = String(leaseData.workerId || '');
          const leaseTickMs = Number(leaseData.lastTickMs ?? 0);
          const leasedUntilMs = Number(leaseData.leasedUntilMs ?? 0);
          const leaseStatus = String(leaseData.status || '');
          const leaseLastAction = String(leaseData.lastAction || '');
          const activeLeaseOverlap =
            leaseWorker !== workerId &&
            leaseStatus === status &&
            (leaseTickMs === nowMs ||
              (leasedUntilMs > nowMs &&
                leaseLastAction !== 'countdown_synced' &&
                !isCurrentPhaseDue));
          if (activeLeaseOverlap) {
            const currentStage = resolveGameLifecycleStage({
              status,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              countdownSeconds: Math.max(0, Math.ceil((registrationDeadlineMs - nowMs) / 1000)),
              minPlayers,
            });
            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'lease_busy_skipped',
              status,
              lifecycleStage: currentStage,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs,
              intermissionEndsAtMs,
              extendedRegistrationCount,
            };
          }
        }

        const writeAudit = (action: SchedulerActionType, details: string, round = roundNumber) => {
          const logId = `sched_${roomId}_r${round}_${action}_${nowMs}_${crypto.randomUUID().slice(0, 8)}`;
          tx.set(schedulerAuditCol.doc(logId), {
            logId,
            roomId,
            gameId,
            roundNumber: round,
            action,
            confirmedPlayersCount: financials.confirmedPlayersCount,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            details: details.slice(0, 240),
            workerId,
            timestampMs: nowMs,
          });
        };

        const updateLease = (
          action: SchedulerActionType,
          nextStatus: string,
          nextScheduledDeadlineMs = 0
        ) => {
          const rawLeaseUntil = nowMs + 2_000;
          const boundedLeaseUntil =
            nextScheduledDeadlineMs > nowMs
              ? Math.min(rawLeaseUntil, Math.max(nowMs + 250, nextScheduledDeadlineMs - 50))
              : rawLeaseUntil;
          tx.set(leaseRef, {
            roomId,
            workerId,
            lastTickMs: nowMs,
            leasedUntilMs: boundedLeaseUntil,
            lastAction: action,
            status: nextStatus,
            updatedAtMs: nowMs,
          });
        };

        // ====================================================================
        // PHASE 1: WAITING FOR PLAYERS -> REGISTRATION OPEN -> DEADLINE CHECK
        // ====================================================================
        if (status === 'waiting' || status === 'countdown') {
          const hadExistingDeadline = registrationDeadlineMs > 0;
          if (!hadExistingDeadline) {
            registrationDeadlineMs = nowMs + registrationWindowMs;
          }

          if (nowMs < registrationDeadlineMs) {
            const remainingSeconds = Math.max(
              1,
              Math.ceil((registrationDeadlineMs - nowMs) / 1000)
            );
            const nextLifecycle = resolveGameLifecycleStage({
              status: 'countdown',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              countdownSeconds: remainingSeconds,
              minPlayers,
            });
            if (skipCountdownSync && hadExistingDeadline) {
              return {
                ok: true,
                roomId,
                gameId,
                roundNumber,
                action: 'noop',
                status: 'countdown',
                lifecycleStage: nextLifecycle,
                confirmedPlayersCount: financials.confirmedPlayersCount,
                availableSpaces: financials.availableSpaces,
                totalCardsSold: financials.totalCardsSold,
                totalCollectedEtb: financials.totalCollectedEtb,
                adeyShareEtb: financials.adeyShareEtb,
                winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
                registrationDeadlineMs,
                nextBallDrawAtMs: 0,
                intermissionEndsAtMs: 0,
                extendedRegistrationCount,
              };
            }
            updateLease('countdown_synced', 'countdown', registrationDeadlineMs);
            tx.update(roomRef, {
              status: 'countdown',
              lifecycleStage: nextLifecycle,
              roundNumber,
              countdownSeconds: remainingSeconds,
              registrationDeadlineMs,
              activePlayersCount: financials.confirmedPlayersCount,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
              availableSpaces: financials.availableSpaces,
              reservedCardsCount: financials.totalCardsSold,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              lastSchedulerTickMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });

            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'countdown_synced',
              status: 'countdown',
              lifecycleStage: nextLifecycle,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: 0,
              extendedRegistrationCount,
            };
          }

          // Registration deadline reached: validate paid players against minPlayers (default 3)
          if (financials.confirmedPlayersCount < minPlayers) {
            // NEVER fabricate players or start an invalid game!
            // Extend registration window and preserve all verified payments and card reservations.
            registrationDeadlineMs = nowMs + registrationWindowMs;
            extendedRegistrationCount += 1;
            const remainingSeconds = Math.max(1, Math.ceil(registrationWindowMs / 1000));
            const nextLifecycle = resolveGameLifecycleStage({
              status: 'countdown',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              countdownSeconds: remainingSeconds,
              minPlayers,
            });
            const noticeAm = `ዝቅተኛው የተጫዋች ቁጥር (${minPlayers}) ስላልሞላ ምዝገባ ተራዝሟል። ክፍያዎ እና ካርድዎ ተጠብቋል።`;
            const noticeEn = `Minimum ${minPlayers} paid players not yet reached (${financials.confirmedPlayersCount}/${minPlayers}). Registration extended; your verified payment & cards are preserved.`;

            updateLease('registration_extended', 'countdown', registrationDeadlineMs);
            writeAudit(
              'registration_extended',
              `Extended registration window #${extendedRegistrationCount} (${financials.confirmedPlayersCount}/${minPlayers} paid players). Preserved ${financials.totalCardsSold} cards.`
            );

            // Notify registered players in botOutbox about the extended schedule
            for (const uid of uniqueOwnerUids) {
              const tgId = uid.startsWith('tg_') ? Number(uid.slice(3)) || 0 : 0;
              const ntfId = `ntf_${crypto.randomUUID()}`;
              tx.set(botOutboxCol.doc(ntfId), {
                id: ntfId,
                event: 'schedule_extended',
                telegramUserId: tgId,
                recipientTelegramId: tgId,
                language: 'am',
                title: `Round #${roundNumber} Extended (${roomId})`,
                body: noticeEn,
                roomId,
                roundNumber,
                textAm: noticeAm,
                textEn: noticeEn,
                deliveredViaBotApi: false,
                createdAtMs: nowMs,
                createdAt: new Date(nowMs).toISOString(),
              });
            }

            tx.update(roomRef, {
              status: 'countdown',
              lifecycleStage: nextLifecycle,
              roundNumber,
              countdownSeconds: remainingSeconds,
              registrationDeadlineMs,
              extendedRegistrationCount,
              scheduleNoticeAm: noticeAm,
              scheduleNoticeEn: noticeEn,
              activePlayersCount: financials.confirmedPlayersCount,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
              availableSpaces: financials.availableSpaces,
              reservedCardsCount: financials.totalCardsSold,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              lastSchedulerAction: 'registration_extended',
              lastSchedulerTickMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });

            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'registration_extended',
              status: 'countdown',
              lifecycleStage: nextLifecycle,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: 0,
              extendedRegistrationCount,
              scheduleNoticeAm: noticeAm,
              scheduleNoticeEn: noticeEn,
            };
          }

          // Minimum paid players met (e.g., 3, 5, 50, 600) -> START GAME AUTOMATICALLY!
          const openingBall = crypto.randomInt(1, 76);
          const openingCalls = [openingBall];
          nextBallDrawAtMs = nowMs + ballDrawIntervalMs;

          updateLease('game_auto_started', 'live', nextBallDrawAtMs);
          writeAudit(
            'game_auto_started',
            `Auto-started Round #${roundNumber} with ${financials.confirmedPlayersCount} paid players (${financials.totalCardsSold} cards, ${financials.totalCollectedEtb} ETB collected, ${financials.winnersPrizePoolEtb} ETB 80% prize pool).`
          );

          tx.set(gameRef, {
            gameId,
            roomId,
            hostUid,
            roundNumber,
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            calledNumbers: openingCalls,
            latestBall: openingBall,
            winnerUid: '',
            winnerName: '',
            winningCardId: 0,
            winningPattern: '',
            confirmedPlayersCount: financials.confirmedPlayersCount,
            availableSpaces: financials.availableSpaces,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            nextBallDrawAtMs,
            intermissionEndsAtMs: 0,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          tx.update(roomRef, {
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            roundNumber,
            currentGameId: gameId,
            countdownSeconds: 0,
            nextBallDrawAtMs,
            intermissionEndsAtMs: 0,
            scheduleNoticeAm: '',
            scheduleNoticeEn: '',
            activePlayersCount: financials.confirmedPlayersCount,
            confirmedPlayersCount: financials.confirmedPlayersCount,
            verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
            availableSpaces: financials.availableSpaces,
            reservedCardsCount: financials.totalCardsSold,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            lastSchedulerAction: 'game_auto_started',
            lastSchedulerTickMs: nowMs,
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            ok: true,
            roomId,
            gameId,
            roundNumber,
            action: 'game_auto_started',
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            confirmedPlayersCount: financials.confirmedPlayersCount,
            availableSpaces: financials.availableSpaces,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            registrationDeadlineMs,
            nextBallDrawAtMs,
            intermissionEndsAtMs: 0,
            extendedRegistrationCount,
            drawnBall: openingBall,
            calledNumbers: openingCalls,
          };
        }

        // ====================================================================
        // PHASE 2: IN_PROGRESS -> DRAW BINGO NUMBERS -> VALIDATE & SETTLE WINNER
        // ====================================================================
        if (status === 'live') {
          // Guard 1: If the live game doc was already completed for this round (e.g., via manual claim),
          // sync room status to completed without drawing another ball or double-crediting winners.
          if (
            gameSnap.exists &&
            gameSnap.get('status') === 'completed' &&
            Number(gameSnap.get('roundNumber') ?? roundNumber) === roundNumber
          ) {
            const syncedIntermissionMs =
              Number(gameSnap.get('intermissionEndsAtMs') ?? intermissionEndsAtMs) ||
              nowMs + intermissionMs;
            updateLease('noop', 'completed', syncedIntermissionMs);
            tx.update(roomRef, {
              status: 'completed',
              lifecycleStage: 'COMPLETED',
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: syncedIntermissionMs,
              lastSchedulerTickMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });
            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'noop',
              status: 'completed',
              lifecycleStage: 'COMPLETED',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: syncedIntermissionMs,
              extendedRegistrationCount,
            };
          }

          // Guard 2: Empty ghost 'live' room with 0 players and 0 cards -> recover cleanly to countdown
          if (financials.confirmedPlayersCount === 0 && financials.totalCardsSold === 0) {
            const recoveredDeadlineMs = nowMs + registrationWindowMs;
            const recoveredCountdown = Math.max(1, Math.ceil(registrationWindowMs / 1000));
            updateLease('stuck_session_recovered', 'countdown', recoveredDeadlineMs);
            writeAudit(
              'stuck_session_recovered',
              `Recovered empty live room ${roomId} (0 players / 0 cards) back to registration countdown.`
            );
            tx.update(roomRef, {
              status: 'countdown',
              lifecycleStage: 'WAITING',
              countdownSeconds: recoveredCountdown,
              registrationDeadlineMs: recoveredDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: 0,
              activePlayersCount: 0,
              confirmedPlayersCount: 0,
              verifiedPaidEntriesCount: 0,
              availableSpaces: 600,
              reservedCardsCount: 0,
              totalCardsSold: 0,
              totalCollectedEtb: 0,
              adeyShareEtb: 0,
              winnersPrizePoolEtb: 0,
              lastSchedulerAction: 'stuck_session_recovered',
              lastSchedulerTickMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });
            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'stuck_session_recovered',
              status: 'countdown',
              lifecycleStage: 'WAITING',
              confirmedPlayersCount: 0,
              availableSpaces: 600,
              totalCardsSold: 0,
              totalCollectedEtb: 0,
              adeyShareEtb: 0,
              winnersPrizePoolEtb: 0,
              registrationDeadlineMs: recoveredDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs: 0,
              extendedRegistrationCount,
            };
          }

          const isStuckSession =
            nextBallDrawAtMs <= 0 || nowMs - nextBallDrawAtMs >= stuckSessionTimeoutMs;

          if (!isStuckSession && nowMs < nextBallDrawAtMs) {
            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'noop',
              status: 'live',
              lifecycleStage: 'IN_PROGRESS',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs,
              intermissionEndsAtMs: 0,
              extendedRegistrationCount,
            };
          }

          const existingCalls: number[] = gameSnap.exists && Array.isArray(gameSnap.get('calledNumbers'))
            ? Array.from(
                new Set(
                  (gameSnap.get('calledNumbers') as unknown[])
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 75)
                )
              )
            : [];

          const calledSet = new Set<number>(existingCalls);
          const remaining: number[] = [];
          for (let n = 1; n <= 75; n++) {
            if (!calledSet.has(n)) remaining.push(n);
          }

          const drawnBall =
            remaining.length > 0
              ? remaining[crypto.randomInt(0, remaining.length)]
              : existingCalls[existingCalls.length - 1] || 75;
          const updatedCalls =
            remaining.length > 0 ? [...existingCalls, drawnBall] : existingCalls;

          // Evaluate all reserved cards against updatedCalls using verified 80% prize pool
          const settlement = evaluateRoundWinners({
            entries: cardEntries,
            calledNumbers: updatedCalls,
            cardPrice,
            totalCardsInRoom: financials.totalCardsSold,
            confirmedPlayersCount: financials.confirmedPlayersCount,
            useAuthoritative8020Split: true,
          });

          if (settlement.hasWinner || remaining.length <= 1) {
            // READ ALL WINNER USER PROFILES, BOT PLAYERS & DETERMINISTIC TX IDS BEFORE ANY WRITES (Firestore read-before-write rule!)
            const payoutTxIds = settlement.payoutsByPlayer.map((p, i) =>
              i === 0 && settlement.payoutsByPlayer.length === 1
                ? `tx_win_${gameId}_r${roundNumber}`
                : `tx_win_${gameId}_r${roundNumber}_${p.uid}`
            );
            const [winnerUserSnaps, winnerBotSnaps, existingWinTxSnaps] = await Promise.all([
              Promise.all(settlement.payoutsByPlayer.map((p) => tx.get(usersCol.doc(p.uid)))),
              Promise.all(
                settlement.payoutsByPlayer.map((p) =>
                  p.telegramUserId > 0
                    ? tx.get(botPlayersCol.doc(String(p.telegramUserId)))
                    : Promise.resolve(null)
                )
              ),
              Promise.all(payoutTxIds.map((txId) => tx.get(transactionsCol.doc(txId)))),
            ]);

            intermissionEndsAtMs = nowMs + intermissionMs;
            nextBallDrawAtMs = 0;

            updateLease('winner_auto_settled', 'completed', intermissionEndsAtMs);
            writeAudit(
              'winner_auto_settled',
              `Round #${roundNumber} settled after ${updatedCalls.length} balls. Distributed ${settlement.prizePoolEtb} ETB (80% of ${financials.totalCollectedEtb} ETB) across ${settlement.payoutsByPlayer.length} winner(s). ADEYBINGO 20% share: ${financials.adeyShareEtb} ETB.`
            );

            // Credit each winner's balance with their exact share of the 80% prize pool (idempotent per deterministic txId)
            for (let i = 0; i < settlement.payoutsByPlayer.length; i++) {
              if (existingWinTxSnaps[i]?.exists) {
                continue;
              }
              const payout = settlement.payoutsByPlayer[i];
              const uSnap = winnerUserSnaps[i];
              const bSnap = winnerBotSnaps[i];
              const userRef = usersCol.doc(payout.uid);
              const currentBal = uSnap.exists ? Number(uSnap.get('demoBalanceEtb') ?? 0) : 0;
              const nextBal = Math.min(1_000_000, Number((currentBal + payout.totalPrizeEtb).toFixed(2)));
              if (uSnap.exists) {
                tx.update(userRef, {
                  demoBalanceEtb: nextBal,
                  updatedAt: FieldValue.serverTimestamp(),
                });
              } else {
                tx.set(userRef, {
                  uid: payout.uid,
                  telegramUserId: `tg_${payout.telegramUserId}`,
                  displayName: payout.displayName.slice(0, 80),
                  username: payout.uid,
                  language: 'am',
                  phoneVerified: false,
                  demoBalanceEtb: nextBal,
                  createdAt: FieldValue.serverTimestamp(),
                  updatedAt: FieldValue.serverTimestamp(),
                });
              }
              if (payout.telegramUserId > 0 && bSnap?.exists) {
                tx.update(botPlayersCol.doc(String(payout.telegramUserId)), {
                  demoBalanceEtb: nextBal,
                  updatedAt: new Date(nowMs).toISOString(),
                });
              }

              const txId = payoutTxIds[i];
              tx.set(transactionsCol.doc(txId), {
                transactionId: txId,
                userId: payout.uid,
                type: 'bingo_win',
                amountEtb: payout.totalPrizeEtb,
                balanceBeforeEtb: currentBal,
                balanceAfterEtb: nextBal,
                status: 'demo_completed',
                description: `Auto-settled Bingo Win (Card #${payout.cardIds.join(', #')} · 80% Pool)`.slice(
                  0,
                  160
                ),
                reference: `ADB-WIN-${roomId}-R${roundNumber}`.slice(0, 64),
                relatedId: gameId,
                idempotencyKey: txId,
                createdAt: FieldValue.serverTimestamp(),
              });

              const ntfId = `ntf_${crypto.randomUUID()}`;
              tx.set(botOutboxCol.doc(ntfId), {
                id: ntfId,
                event: 'winner_announcement',
                telegramUserId: payout.telegramUserId,
                recipientTelegramId: payout.telegramUserId,
                language: 'am',
                title: `Winner Announcement · Round #${roundNumber}`,
                body: `${payout.displayName} won ${payout.totalPrizeEtb.toFixed(2)} ETB on Card #${payout.cardIds.join(', #')} (${roomId})`,
                roomId,
                roundNumber,
                winnerName: payout.displayName,
                winningCardId: payout.cardIds[0],
                prizeEtb: payout.totalPrizeEtb,
                deliveredViaBotApi: false,
                createdAtMs: nowMs,
                createdAt: new Date(nowMs).toISOString(),
              });
            }

            const primaryWinner = settlement.winners[0];
            const allWinnerNames =
              settlement.payoutsByPlayer.map((p) => p.displayName).join(', ') || 'No Winner';

            const completedGameDoc = {
              gameId,
              roomId,
              roomNameAm: String(roomData.nameAm || roomId),
              roomNameEn: String(roomData.nameEn || roomId),
              hostUid,
              roundNumber,
              cardPrice,
              entryFeeDemo: cardPrice,
              demoPrizeEtb: settlement.prizePoolEtb,
              status: 'completed',
              lifecycleStage: 'COMPLETED',
              calledNumbers: updatedCalls,
              latestBall: drawnBall,
              winnerUid: primaryWinner?.uid || '',
              winnerName: allWinnerNames.slice(0, 80),
              winningCardId: primaryWinner?.cardId || 0,
              winningPattern: (primaryWinner?.patternLabelEn || 'Exhausted').slice(0, 64),
              winners: settlement.winners,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs,
              completedAt: new Date(nowMs).toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            };

            // Save live game doc AND archive historical round result doc
            tx.set(gameRef, {
              ...completedGameDoc,
              createdAt: FieldValue.serverTimestamp(),
            });
            tx.set(gamesCol.doc(`game_${roomId}_r${roundNumber}`), {
              ...completedGameDoc,
              gameId: `game_${roomId}_r${roundNumber}`,
              createdAt: FieldValue.serverTimestamp(),
            });

            tx.update(roomRef, {
              status: 'completed',
              lifecycleStage: 'COMPLETED',
              roundNumber,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
              availableSpaces: financials.availableSpaces,
              reservedCardsCount: financials.totalCardsSold,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              lastSchedulerAction: 'winner_auto_settled',
              lastSchedulerTickMs: nowMs,
              updatedAt: FieldValue.serverTimestamp(),
            });

            return {
              ok: true,
              roomId,
              gameId,
              roundNumber,
              action: 'winner_auto_settled',
              status: 'completed',
              lifecycleStage: 'COMPLETED',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              registrationDeadlineMs,
              nextBallDrawAtMs: 0,
              intermissionEndsAtMs,
              extendedRegistrationCount,
              drawnBall,
              calledNumbers: updatedCalls,
              settlement,
            };
          }

          // No winner yet -> persist drawn ball and schedule next draw
          nextBallDrawAtMs = nowMs + ballDrawIntervalMs;
          const action: SchedulerActionType = isStuckSession
            ? 'stuck_session_recovered'
            : 'ball_auto_drawn';

          updateLease(action, 'live', nextBallDrawAtMs);
          if (isStuckSession) {
            writeAudit(
              'stuck_session_recovered',
              `Recovered stuck live session in ${roomId} (Round #${roundNumber}) and resumed ball drawing (#${updatedCalls.length}: ${drawnBall}).`
            );
          }

          tx.set(
            gameRef,
            {
              gameId,
              roomId,
              hostUid,
              roundNumber,
              status: 'live',
              lifecycleStage: 'IN_PROGRESS',
              calledNumbers: updatedCalls,
              latestBall: drawnBall,
              winnerUid: '',
              winnerName: '',
              winningCardId: 0,
              winningPattern: '',
              confirmedPlayersCount: financials.confirmedPlayersCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
              nextBallDrawAtMs,
              intermissionEndsAtMs: 0,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          tx.update(roomRef, {
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            roundNumber,
            nextBallDrawAtMs,
            lastSchedulerAction: action,
            lastSchedulerTickMs: nowMs,
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            ok: true,
            roomId,
            gameId,
            roundNumber,
            action,
            status: 'live',
            lifecycleStage: 'IN_PROGRESS',
            confirmedPlayersCount: financials.confirmedPlayersCount,
            availableSpaces: financials.availableSpaces,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            registrationDeadlineMs,
            nextBallDrawAtMs,
            intermissionEndsAtMs: 0,
            extendedRegistrationCount,
            drawnBall,
            calledNumbers: updatedCalls,
          };
        }

        // ====================================================================
        // PHASE 3: COMPLETED -> CREATE NEXT GAME AUTOMATICALLY -> REPEAT FOREVER
        // ====================================================================
        if (intermissionEndsAtMs > 0 && nowMs < intermissionEndsAtMs) {
          return {
            ok: true,
            roomId,
            gameId,
            roundNumber,
            action: 'noop',
            status: 'completed',
            lifecycleStage: 'COMPLETED',
            confirmedPlayersCount: financials.confirmedPlayersCount,
            availableSpaces: financials.availableSpaces,
            totalCardsSold: financials.totalCardsSold,
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            registrationDeadlineMs,
            nextBallDrawAtMs: 0,
            intermissionEndsAtMs,
            extendedRegistrationCount,
          };
        }

        const nextRound = roundNumber + 1;
        const nextRegistrationDeadlineMs = nowMs + registrationWindowMs;
        const nextCountdownSeconds = Math.max(1, Math.ceil(registrationWindowMs / 1000));

        // Clear completed round's reserved cards & player session docs so the new round starts fresh
        for (const cDoc of cardsSnap.docs) {
          tx.delete(cDoc.ref);
        }
        for (const pDoc of playersSnap.docs) {
          tx.delete(pDoc.ref);
        }

        updateLease('next_game_auto_created', 'countdown', nextRegistrationDeadlineMs);
        writeAudit(
          'next_game_auto_created',
          `Automatically created next game Round #${nextRound} for ${roomId}. Registration open (0/600 players, min ${minPlayers}).`,
          nextRound
        );

        tx.set(gameRef, {
          gameId,
          roomId,
          hostUid,
          roundNumber: nextRound,
          status: 'countdown',
          lifecycleStage: 'WAITING',
          calledNumbers: [],
          latestBall: 0,
          winnerUid: '',
          winnerName: '',
          winningCardId: 0,
          winningPattern: '',
          confirmedPlayersCount: 0,
          availableSpaces: 600,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.update(roomRef, {
          status: 'countdown',
          lifecycleStage: 'WAITING',
          roundNumber: nextRound,
          currentGameId: gameId,
          countdownSeconds: nextCountdownSeconds,
          registrationDeadlineMs: nextRegistrationDeadlineMs,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          extendedRegistrationCount: 0,
          scheduleNoticeAm: '',
          scheduleNoticeEn: '',
          activePlayersCount: 0,
          confirmedPlayersCount: 0,
          verifiedPaidEntriesCount: 0,
          availableSpaces: 600,
          reservedCardsCount: 0,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          lastSchedulerAction: 'next_game_auto_created',
          lastSchedulerTickMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          roomId,
          gameId,
          roundNumber: nextRound,
          action: 'next_game_auto_created',
          status: 'countdown',
          lifecycleStage: 'WAITING',
          confirmedPlayersCount: 0,
          availableSpaces: 600,
          totalCardsSold: 0,
          totalCollectedEtb: 0,
          adeyShareEtb: 0,
          winnersPrizePoolEtb: 0,
          registrationDeadlineMs: nextRegistrationDeadlineMs,
          nextBallDrawAtMs: 0,
          intermissionEndsAtMs: 0,
          extendedRegistrationCount: 0,
        };
      });
    },

    async ensureSharedRegistrationDeadline(
      roomId: string,
      nowMs: number = Date.now()
    ): Promise<number> {
      const roomRef = roomsCol.doc(roomId);
      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists) return 0;
        const status = String(snap.get('status') || 'countdown');
        const existingDeadline = Number(snap.get('registrationDeadlineMs') ?? 0);
        if ((status !== 'countdown' && status !== 'waiting') || existingDeadline > 0) {
          return existingDeadline;
        }
        const windowSeconds = Math.max(
          10,
          Number(snap.get('lobbyCountdownSeconds') ?? snap.get('countdownSeconds') ?? 60)
        );
        const deadlineMs = nowMs + windowSeconds * 1000;
        tx.update(roomRef, {
          status: 'countdown',
          countdownSeconds: windowSeconds,
          registrationDeadlineMs: deadlineMs,
          roundStartedAtMs: Number(snap.get('roundStartedAtMs') ?? 0) || nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return deadlineMs;
      });
    },

    async validateRoomIntegrity(roomId: string): Promise<RoomIntegrityReport> {
      const roomRef = roomsCol.doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) {
        return {
          ok: true,
          roomId,
          exists: false,
          valid: false,
          discrepancies: [
            {
              field: 'room',
              stored: null,
              expected: roomId,
              severity: 'error',
              message: `Room document rooms/${roomId} does not exist.`,
            },
          ],
        };
      }

      const data = (roomSnap.data() || {}) as Record<string, unknown>;
      const gameId = String(data.currentGameId || `game_${roomId}_live`);
      const [cardsSnap, playersSnap, gameSnap] = await Promise.all([
        roomRef.collection('cards').get(),
        roomRef.collection('players').get(),
        gamesCol.doc(gameId).get(),
      ]);

      const uniqueCardOwners = new Set<string>();
      for (const cDoc of cardsSnap.docs) {
        const ownerId = String(cDoc.get('ownerId') || '').trim();
        if (ownerId) uniqueCardOwners.add(ownerId);
      }
      const activePlayerDocs = playersSnap.docs.filter((pDoc) => {
        const cIds = pDoc.get('cardIds');
        return Array.isArray(cIds) && cIds.length > 0;
      });

      const computedPlayers =
        uniqueCardOwners.size > 0 ? uniqueCardOwners.size : activePlayerDocs.length;
      const computedCards = cardsSnap.size;
      const cardPrice = Number(data.cardPrice ?? data.cardPriceEtb ?? 10);
      const financials = calculateAuthoritativeGameFinancials(
        computedPlayers,
        computedCards,
        cardPrice
      );

      const storedStatus = String(data.status || 'countdown');
      const storedActivePlayers = Number(data.activePlayersCount ?? 0);
      const storedConfirmedPlayers = Number(data.confirmedPlayersCount ?? storedActivePlayers);
      const storedReservedCards = Number(data.reservedCardsCount ?? 0);
      const storedTotalCardsSold = Number(data.totalCardsSold ?? storedReservedCards);
      const storedCollected = Number(data.totalCollectedEtb ?? 0);
      const storedAdeyShare = Number(data.adeyShareEtb ?? 0);
      const storedPrizePool = Number(data.winnersPrizePoolEtb ?? 0);
      const storedDeadlineMs = Number(data.registrationDeadlineMs ?? 0);

      const discrepancies: RoomIntegrityDiscrepancy[] = [];
      if (storedConfirmedPlayers !== financials.confirmedPlayersCount) {
        discrepancies.push({
          field: 'confirmedPlayersCount',
          stored: storedConfirmedPlayers,
          expected: financials.confirmedPlayersCount,
          severity: 'error',
          message: `Confirmed players count (${storedConfirmedPlayers}) does not match subcollections (${financials.confirmedPlayersCount}).`,
        });
      }
      if (storedActivePlayers !== financials.confirmedPlayersCount) {
        discrepancies.push({
          field: 'activePlayersCount',
          stored: storedActivePlayers,
          expected: financials.confirmedPlayersCount,
          severity: 'warning',
          message: `activePlayersCount (${storedActivePlayers}) differs from subcollections (${financials.confirmedPlayersCount}).`,
        });
      }
      if (storedReservedCards !== financials.totalCardsSold || storedTotalCardsSold !== financials.totalCardsSold) {
        discrepancies.push({
          field: 'totalCardsSold',
          stored: { reservedCardsCount: storedReservedCards, totalCardsSold: storedTotalCardsSold },
          expected: financials.totalCardsSold,
          severity: 'error',
          message: `Stored card counts do not match cards subcollection (${financials.totalCardsSold}).`,
        });
      }
      if (
        data.cardPriceEtb !== undefined &&
        data.cardPrice !== undefined &&
        Number(data.cardPrice) !== Number(data.cardPriceEtb)
      ) {
        discrepancies.push({
          field: 'cardPrice',
          stored: { cardPrice: data.cardPrice, cardPriceEtb: data.cardPriceEtb },
          expected: cardPrice,
          severity: 'error',
          message: `Conflicting cardPrice (${data.cardPrice}) and cardPriceEtb (${data.cardPriceEtb}) fields.`,
        });
      }
      if (
        storedCollected !== financials.totalCollectedEtb ||
        storedAdeyShare !== financials.adeyShareEtb ||
        storedPrizePool !== financials.winnersPrizePoolEtb
      ) {
        discrepancies.push({
          field: 'financials',
          stored: {
            totalCollectedEtb: storedCollected,
            adeyShareEtb: storedAdeyShare,
            winnersPrizePoolEtb: storedPrizePool,
          },
          expected: {
            totalCollectedEtb: financials.totalCollectedEtb,
            adeyShareEtb: financials.adeyShareEtb,
            winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          },
          severity: 'error',
          message: `Room financials do not match cardPrice=${cardPrice} ETB for ${financials.confirmedPlayersCount} verified player(s).`,
        });
      }
      if (storedStatus === 'live' && financials.confirmedPlayersCount === 0 && financials.totalCardsSold === 0) {
        discrepancies.push({
          field: 'status',
          stored: 'live',
          expected: 'countdown',
          severity: 'error',
          message: 'Room is marked live with 0 confirmed players and 0 reserved cards.',
        });
      }
      if (storedStatus === 'countdown' && storedDeadlineMs <= 0) {
        discrepancies.push({
          field: 'registrationDeadlineMs',
          stored: storedDeadlineMs,
          expected: '> 0',
          severity: 'warning',
          message: 'Countdown room is missing a persisted server registrationDeadlineMs.',
        });
      }

      return {
        ok: true,
        roomId,
        exists: true,
        valid: discrepancies.length === 0,
        discrepancies,
        stored: {
          status: storedStatus,
          cardPrice,
          activePlayersCount: storedActivePlayers,
          confirmedPlayersCount: storedConfirmedPlayers,
          reservedCardsCount: storedReservedCards,
          totalCardsSold: storedTotalCardsSold,
          totalCollectedEtb: storedCollected,
          adeyShareEtb: storedAdeyShare,
          winnersPrizePoolEtb: storedPrizePool,
          registrationDeadlineMs: storedDeadlineMs,
        },
        computed: {
          cardPrice,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
          availableSpaces: financials.availableSpaces,
          playerDocsCount: playersSnap.size,
          cardDocsCount: cardsSnap.size,
          gameStatus: gameSnap.exists ? String(gameSnap.get('status') || '') : undefined,
        },
      };
    },

    async reconcileRoomStateAtomic(
      roomId: string,
      nowMs: number = Date.now(),
      options?: ReconcileRoomOptions
    ): Promise<RoomReconcileResult> {
      const dryRun = options?.dryRun === true;
      if (options && options.dryRun === false && options.confirmApply !== true) {
        return {
          ok: false,
          roomId,
          dryRun: false,
          reconciled: false,
          changes: [],
          reason: 'approval_required',
        };
      }

      const roomRef = roomsCol.doc(roomId);
      const backupsCol = db.collection('roomReconciliationBackups');
      const changes: string[] = [];

      const txResult = await db.runTransaction(async (tx) => {
        const [roomSnap, cardsSnap, playersSnap] = await Promise.all([
          tx.get(roomRef),
          roomRef.collection('cards').get(),
          roomRef.collection('players').get(),
        ]);

        if (!roomSnap.exists) {
          return { ok: false as const, reason: 'room_not_found' as const };
        }

        const data = (roomSnap.data() || {}) as Record<string, unknown>;
        const uniqueCardOwners = new Set<string>();
        for (const cDoc of cardsSnap.docs) {
          const ownerId = String(cDoc.get('ownerId') || '').trim();
          if (ownerId) uniqueCardOwners.add(ownerId);
        }
        const activePlayerDocs = playersSnap.docs.filter((pDoc) => {
          const cIds = pDoc.get('cardIds');
          return Array.isArray(cIds) && cIds.length > 0;
        });

        const computedPlayers =
          uniqueCardOwners.size > 0 ? uniqueCardOwners.size : activePlayerDocs.length;
        const computedCards = cardsSnap.size;
        const cardPrice = Number(data.cardPrice ?? data.cardPriceEtb ?? 10);
        const minPlayers = Number(data.minPlayers ?? 3);
        const countdownWindowSec = Math.max(
          10,
          Number(data.lobbyCountdownSeconds ?? data.countdownSeconds ?? 60)
        );
        const financials = calculateAuthoritativeGameFinancials(
          computedPlayers,
          computedCards,
          cardPrice
        );

        let nextStatus = String(data.status || 'countdown') as
          | 'waiting'
          | 'countdown'
          | 'live'
          | 'completed';
        let nextDeadlineMs = Number(data.registrationDeadlineMs ?? 0);

        if (nextStatus === 'live' && computedPlayers === 0 && computedCards === 0) {
          nextStatus = 'countdown';
          nextDeadlineMs = nowMs + countdownWindowSec * 1000;
          changes.push('Recovered empty ghost live room to countdown');
        }
        if ((nextStatus === 'countdown' || nextStatus === 'waiting') && nextDeadlineMs <= 0) {
          nextStatus = 'countdown';
          nextDeadlineMs = nowMs + countdownWindowSec * 1000;
          changes.push('Initialized shared server registrationDeadlineMs');
        }

        const remainingSeconds =
          nextStatus === 'countdown' && nextDeadlineMs > 0
            ? Math.max(0, Math.ceil((nextDeadlineMs - nowMs) / 1000))
            : nextStatus === 'live' || nextStatus === 'completed'
              ? 0
              : countdownWindowSec;

        const nextLifecycle = resolveGameLifecycleStage({
          status: nextStatus,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          countdownSeconds: remainingSeconds,
          minPlayers,
        });

        if (
          Number(data.confirmedPlayersCount ?? data.activePlayersCount ?? 0) !== financials.confirmedPlayersCount ||
          Number(data.activePlayersCount ?? 0) !== financials.confirmedPlayersCount
        ) {
          changes.push(
            `Reconciled player counts (confirmed=${Number(data.confirmedPlayersCount ?? 0)}, active=${Number(data.activePlayersCount ?? 0)}) -> ${financials.confirmedPlayersCount}`
          );
        }
        if (
          Number(data.totalCardsSold ?? data.reservedCardsCount ?? 0) !== financials.totalCardsSold ||
          Number(data.reservedCardsCount ?? 0) !== financials.totalCardsSold
        ) {
          changes.push(
            `Reconciled card counts (sold=${Number(data.totalCardsSold ?? 0)}, reserved=${Number(data.reservedCardsCount ?? 0)}) -> ${financials.totalCardsSold}`
          );
        }
        if (
          Number(data.totalCollectedEtb ?? 0) !== financials.totalCollectedEtb ||
          Number(data.winnersPrizePoolEtb ?? 0) !== financials.winnersPrizePoolEtb ||
          Number(data.cardPrice ?? 0) !== cardPrice ||
          Number(data.cardPriceEtb ?? cardPrice) !== cardPrice
        ) {
          changes.push(
            `Reconciled financials with cardPrice=${cardPrice} ETB (collected=${financials.totalCollectedEtb}, prizePool=${financials.winnersPrizePoolEtb})`
          );
        }

        const beforeSnapshot: Record<string, unknown> = {
          status: String(data.status || 'countdown'),
          lifecycleStage: String(data.lifecycleStage || ''),
          cardPrice: Number(data.cardPrice ?? 0),
          cardPriceEtb: Number(data.cardPriceEtb ?? 0),
          countdownSeconds: Number(data.countdownSeconds ?? 0),
          registrationDeadlineMs: Number(data.registrationDeadlineMs ?? 0),
          activePlayersCount: Number(data.activePlayersCount ?? 0),
          confirmedPlayersCount: Number(data.confirmedPlayersCount ?? 0),
          reservedCardsCount: Number(data.reservedCardsCount ?? 0),
          totalCardsSold: Number(data.totalCardsSold ?? 0),
          totalCollectedEtb: Number(data.totalCollectedEtb ?? 0),
          adeyShareEtb: Number(data.adeyShareEtb ?? 0),
          winnersPrizePoolEtb: Number(data.winnersPrizePoolEtb ?? 0),
        };

        const proposedPatch: Record<string, unknown> = {
          status: nextStatus,
          lifecycleStage: nextLifecycle,
          cardPrice,
          cardPriceEtb: cardPrice,
          countdownSeconds: remainingSeconds,
          registrationDeadlineMs: nextDeadlineMs,
          activePlayersCount: financials.confirmedPlayersCount,
          confirmedPlayersCount: financials.confirmedPlayersCount,
          verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
          availableSpaces: financials.availableSpaces,
          reservedCardsCount: financials.totalCardsSold,
          totalCardsSold: financials.totalCardsSold,
          totalCollectedEtb: financials.totalCollectedEtb,
          adeyShareEtb: financials.adeyShareEtb,
          winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
        };

        let backupId: string | undefined;
        if (!dryRun && changes.length > 0) {
          backupId = `bkp_${roomId}_${nowMs}_${crypto.randomUUID().slice(0, 8)}`;
          tx.set(backupsCol.doc(backupId), {
            backupId,
            roomId,
            createdAtMs: nowMs,
            createdAt: new Date(nowMs).toISOString(),
            requestedByUid: options?.requestedByUid || 'system',
            requestedByName: options?.requestedByName || 'System Reconciliation',
            changes,
            beforeSnapshot,
            proposedPatch,
            cardDocsCount: cardsSnap.size,
            playerDocsCount: playersSnap.size,
          });
          tx.update(roomRef, {
            ...proposedPatch,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        return { ok: true as const, backupId, beforeSnapshot, proposedPatch };
      });

      if (!txResult.ok) {
        return {
          ok: false,
          roomId,
          dryRun,
          reconciled: false,
          changes: [],
          reason: txResult.reason,
        };
      }

      const report = await this.validateRoomIntegrity(roomId);
      return {
        ok: true,
        roomId,
        dryRun,
        reconciled: !dryRun && changes.length > 0,
        changes,
        backupId: txResult.backupId,
        beforeSnapshot: txResult.beforeSnapshot,
        proposedPatch: txResult.proposedPatch,
        report,
      };
    },

    async listSchedulerAuditLogs(
      roomId?: string,
      limitCount = 50
    ): Promise<SchedulerAuditLogEntry[]> {
      const snap = roomId
        ? await schedulerAuditCol.where('roomId', '==', roomId).get()
        : await schedulerAuditCol.get();
      const entries = snap.docs.map((d) => d.data() as SchedulerAuditLogEntry);
      entries.sort((a, b) => Number(b.timestampMs ?? 0) - Number(a.timestampMs ?? 0));
      return entries.slice(0, limitCount);
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

  public async tickRoomScheduler(params: {
    roomId: string;
    nowMs?: number;
    workerId?: string;
    registrationWindowMs?: number;
    ballDrawIntervalMs?: number;
    intermissionMs?: number;
    stuckSessionTimeoutMs?: number;
  }): Promise<SchedulerTickResult> {
    await this.store.ensureDefaultRooms();
    return await this.store.tickRoomSchedulerAtomic(params);
  }

  public async tickAllRooms(params: {
    nowMs?: number;
    workerId?: string;
    roomIds?: string[];
    registrationWindowMs?: number;
    ballDrawIntervalMs?: number;
    intermissionMs?: number;
    stuckSessionTimeoutMs?: number;
  } = {}): Promise<SchedulerTickResult[]> {
    await this.store.ensureDefaultRooms();
    const targetRoomIds =
      params.roomIds && params.roomIds.length > 0
        ? params.roomIds
        : (await this.store.listRooms()).map((r) => r.roomId);
    const results: SchedulerTickResult[] = [];
    for (const roomId of targetRoomIds) {
      const res = await this.store.tickRoomSchedulerAtomic({
        roomId,
        nowMs: params.nowMs,
        workerId: params.workerId,
        registrationWindowMs: params.registrationWindowMs,
        ballDrawIntervalMs: params.ballDrawIntervalMs,
        intermissionMs: params.intermissionMs,
        stuckSessionTimeoutMs: params.stuckSessionTimeoutMs,
      });
      results.push(res);
    }
    return results;
  }

  public async ensureSharedRegistrationDeadline(
    roomId: string,
    nowMs: number = Date.now()
  ): Promise<number> {
    await this.store.ensureDefaultRooms();
    return await this.store.ensureSharedRegistrationDeadline(roomId, nowMs);
  }

  public async validateRoomIntegrity(roomId: string): Promise<RoomIntegrityReport> {
    return await this.store.validateRoomIntegrity(roomId);
  }

  public async validateAllRoomsIntegrity(): Promise<RoomIntegrityReport[]> {
    await this.store.ensureDefaultRooms();
    const rooms = await this.store.listRooms();
    const reports: RoomIntegrityReport[] = [];
    for (const room of rooms) {
      reports.push(await this.store.validateRoomIntegrity(room.roomId));
    }
    return reports;
  }

  public async reconcileRoomState(
    roomId: string,
    nowMs: number = Date.now(),
    options?: ReconcileRoomOptions
  ): Promise<RoomReconcileResult> {
    return await this.store.reconcileRoomStateAtomic(roomId, nowMs, options);
  }

  public async reconcileAllRooms(
    nowMs: number = Date.now(),
    options?: ReconcileRoomOptions
  ): Promise<RoomReconcileResult[]> {
    if (!options?.dryRun) {
      await this.store.ensureDefaultRooms();
    }
    const rooms = await this.store.listRooms();
    const results: RoomReconcileResult[] = [];
    for (const room of rooms) {
      results.push(await this.store.reconcileRoomStateAtomic(room.roomId, nowMs, options));
    }
    return results;
  }

  /**
   * Bounded idempotent scheduler execution with catch-up recovery for delayed or missed
   * Vercel Cron / external scheduler invocations. Never double-draws or double-settles.
   */
  public async tickRoomSchedulerCatchUp(params: {
    roomId: string;
    nowMs?: number;
    workerId?: string;
    maxSteps?: number;
    catchUpMissedIntervals?: boolean;
    registrationWindowMs?: number;
    ballDrawIntervalMs?: number;
    intermissionMs?: number;
    stuckSessionTimeoutMs?: number;
    skipCountdownSync?: boolean;
  }): Promise<SchedulerTickResult[]> {
    await this.store.ensureDefaultRooms();
    const nowMs = params.nowMs ?? Date.now();
    const ballDrawIntervalMs = params.ballDrawIntervalMs ?? DEFAULT_BALL_DRAW_INTERVAL_MS;
    const maxSteps = Math.max(1, Math.min(20, Math.floor(params.maxSteps ?? 6)));
    const catchUpMissedIntervals = params.catchUpMissedIntervals !== false;

    const results: SchedulerTickResult[] = [];

    // Inspect current room schedule to determine if a live room missed multiple draw intervals
    if (catchUpMissedIntervals && maxSteps > 1) {
      const rooms = await this.store.listRooms();
      const target = rooms.find((r) => r.roomId === params.roomId);
      const nextDrawMs = Number(target?.nextBallDrawAtMs ?? 0);
      if (
        target &&
        target.status === 'live' &&
        nextDrawMs > 0 &&
        nowMs >= nextDrawMs + ballDrawIntervalMs
      ) {
        const missedSteps = Math.min(
          maxSteps,
          Math.floor((nowMs - nextDrawMs) / ballDrawIntervalMs) + 1
        );
        // Anchor the catch-up series so the final step runs at exact nowMs, preventing stale past
        // nextBallDrawAtMs timestamps or false lease overlap with more recent lease records.
        const firstStepNowMs = Math.max(
          nextDrawMs,
          nowMs - (missedSteps - 1) * ballDrawIntervalMs
        );
        for (let step = 0; step < missedSteps; step++) {
          const stepNowMs =
            step === missedSteps - 1
              ? nowMs
              : Math.min(nowMs, firstStepNowMs + step * ballDrawIntervalMs);
          const tickRes = await this.store.tickRoomSchedulerAtomic({
            roomId: params.roomId,
            nowMs: stepNowMs,
            workerId: params.workerId,
            registrationWindowMs: params.registrationWindowMs,
            ballDrawIntervalMs,
            intermissionMs: params.intermissionMs,
            stuckSessionTimeoutMs: params.stuckSessionTimeoutMs,
            skipCountdownSync: params.skipCountdownSync,
          });
          results.push(tickRes);
          if (
            !tickRes.ok ||
            tickRes.status !== 'live' ||
            tickRes.action === 'noop' ||
            tickRes.action === 'lease_busy_skipped' ||
            tickRes.action === 'winner_auto_settled' ||
            tickRes.action === 'stuck_session_recovered'
          ) {
            break;
          }
        }
        if (results.length > 0) {
          return results;
        }
      }
    }

    // Standard atomic tick for the room
    const primary = await this.store.tickRoomSchedulerAtomic({
      roomId: params.roomId,
      nowMs,
      workerId: params.workerId,
      registrationWindowMs: params.registrationWindowMs,
      ballDrawIntervalMs,
      intermissionMs: params.intermissionMs,
      stuckSessionTimeoutMs: params.stuckSessionTimeoutMs,
      skipCountdownSync: params.skipCountdownSync,
    });
    results.push(primary);
    return results;
  }

  /**
   * Server-side due-deadline progression guard (used by authenticated room reads so
   * serverless deployments never stall at 00:00 between external scheduler invocations).
   * Performs ZERO Firestore writes when the room's deadline has not expired.
   */
  public async advanceRoomIfDue(params: {
    roomId: string;
    room?: RoomSummary;
    nowMs?: number;
    workerId?: string;
    maxSteps?: number;
  }): Promise<{ advanced: boolean; results: SchedulerTickResult[] }> {
    const nowMs = params.nowMs ?? Date.now();
    let targetRoom = params.room;
    if (!targetRoom) {
      await this.store.ensureDefaultRooms();
      const rooms = await this.store.listRooms();
      targetRoom = rooms.find((r) => r.roomId === params.roomId);
    }
    if (!targetRoom || !isRoomDueForSchedulerTick(targetRoom, nowMs)) {
      return { advanced: false, results: [] };
    }
    const workerId = params.workerId || `server_due_${crypto.randomUUID().slice(0, 8)}`;
    const results = await this.tickRoomSchedulerCatchUp({
      roomId: params.roomId,
      nowMs,
      workerId,
      maxSteps: Math.max(1, Math.min(6, Math.floor(params.maxSteps ?? 4))),
      catchUpMissedIntervals: true,
      skipCountdownSync: true,
    });
    const advanced = results.some(
      (r) => r.ok && r.action !== 'noop' && r.action !== 'lease_busy_skipped'
    );
    return { advanced, results };
  }

  public async tickAllRoomsCatchUp(params: {
    nowMs?: number;
    workerId?: string;
    roomIds?: string[];
    maxStepsPerRoom?: number;
    catchUpMissedIntervals?: boolean;
    registrationWindowMs?: number;
    ballDrawIntervalMs?: number;
    intermissionMs?: number;
    stuckSessionTimeoutMs?: number;
  } = {}): Promise<SchedulerTickResult[]> {
    await this.store.ensureDefaultRooms();
    const targetRoomIds =
      params.roomIds && params.roomIds.length > 0
        ? params.roomIds
        : (await this.store.listRooms()).map((r) => r.roomId);
    const allResults: SchedulerTickResult[] = [];
    for (const roomId of targetRoomIds) {
      const steps = await this.tickRoomSchedulerCatchUp({
        roomId,
        nowMs: params.nowMs,
        workerId: params.workerId,
        maxSteps: params.maxStepsPerRoom,
        catchUpMissedIntervals: params.catchUpMissedIntervals,
        registrationWindowMs: params.registrationWindowMs,
        ballDrawIntervalMs: params.ballDrawIntervalMs,
        intermissionMs: params.intermissionMs,
        stuckSessionTimeoutMs: params.stuckSessionTimeoutMs,
      });
      allResults.push(...steps);
    }
    return allResults;
  }

  public async listSchedulerAuditLogs(
    roomId?: string,
    limitCount = 50
  ): Promise<SchedulerAuditLogEntry[]> {
    return await this.store.listSchedulerAuditLogs(roomId, limitCount);
  }
}
