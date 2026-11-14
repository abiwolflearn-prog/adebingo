import type { WinPatternType } from '../types/bingo.ts';
import {
  calculateDemoPrizePool,
  checkCardWin,
  generateDeterministicCard,
} from './rules.ts';

export interface RoomCardOwnerEntry {
  cardId: number;
  uid: string;
  telegramUserId: number;
  displayName: string;
}

export interface RoundWinnerShare {
  uid: string;
  telegramUserId: number;
  displayName: string;
  cardId: number;
  patternType: WinPatternType;
  patternLabelAm: string;
  patternLabelEn: string;
  winningCells: [number, number][];
  prizeEtb: number;
}

export interface PlayerPayoutSummary {
  uid: string;
  telegramUserId: number;
  displayName: string;
  cardIds: number[];
  totalPrizeEtb: number;
}

export interface RoundSettlementResult {
  hasWinner: boolean;
  prizePoolEtb: number;
  winners: RoundWinnerShare[];
  payoutsByPlayer: PlayerPayoutSummary[];
}

/**
 * Evaluates all reserved cards in a room against calledNumbers.
 * Detects the instant any line/diagonal completes and distributes the prize pool
 * fairly across simultaneous winners.
 */
export function evaluateRoundWinners(params: {
  entries: RoomCardOwnerEntry[];
  calledNumbers: number[];
  cardPrice: number;
  totalCardsInRoom?: number;
}): RoundSettlementResult {
  const { entries, calledNumbers, cardPrice } = params;
  if (!entries.length || !calledNumbers.length) {
    return {
      hasWinner: false,
      prizePoolEtb: 0,
      winners: [],
      payoutsByPlayer: [],
    };
  }

  const totalCards = Math.max(entries.length, params.totalCardsInRoom ?? entries.length);
  const { winnerPrizeDemo } = calculateDemoPrizePool(totalCards, cardPrice);
  const prizePoolEtb = Math.max(0, winnerPrizeDemo);

  const rawWinners: Array<{
    entry: RoomCardOwnerEntry;
    patternType: WinPatternType;
    patternLabelAm: string;
    patternLabelEn: string;
    winningCells: [number, number][];
  }> = [];

  for (const entry of entries) {
    if (!Number.isInteger(entry.cardId) || entry.cardId < 1 || entry.cardId > 600) {
      continue;
    }
    const card = generateDeterministicCard(entry.cardId);
    const winRes = checkCardWin(card, calledNumbers, calledNumbers, true);
    if (winRes.won && winRes.patternType) {
      rawWinners.push({
        entry,
        patternType: winRes.patternType,
        patternLabelAm: winRes.patternLabelAm || 'ቢንጎ!',
        patternLabelEn: winRes.patternLabelEn || 'Bingo Line',
        winningCells: winRes.winningCells,
      });
    }
  }

  if (rawWinners.length === 0) {
    return {
      hasWinner: false,
      prizePoolEtb,
      winners: [],
      payoutsByPlayer: [],
    };
  }

  // Sort deterministically by cardId so remainder cents are allocated consistently
  rawWinners.sort((a, b) => a.entry.cardId - b.entry.cardId);

  const totalCents = Math.round(prizePoolEtb * 100);
  const count = rawWinners.length;
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;

  const winners: RoundWinnerShare[] = rawWinners.map((w, idx) => {
    const shareCents = baseCents + (idx < remainderCents ? 1 : 0);
    return {
      uid: w.entry.uid,
      telegramUserId: w.entry.telegramUserId,
      displayName: w.entry.displayName,
      cardId: w.entry.cardId,
      patternType: w.patternType,
      patternLabelAm: w.patternLabelAm,
      patternLabelEn: w.patternLabelEn,
      winningCells: w.winningCells,
      prizeEtb: Number((shareCents / 100).toFixed(2)),
    };
  });

  const playerMap = new Map<string, PlayerPayoutSummary>();
  for (const w of winners) {
    const existing = playerMap.get(w.uid);
    if (existing) {
      existing.cardIds.push(w.cardId);
      existing.totalPrizeEtb = Number((existing.totalPrizeEtb + w.prizeEtb).toFixed(2));
    } else {
      playerMap.set(w.uid, {
        uid: w.uid,
        telegramUserId: w.telegramUserId,
        displayName: w.displayName,
        cardIds: [w.cardId],
        totalPrizeEtb: w.prizeEtb,
      });
    }
  }

  return {
    hasWinner: true,
    prizePoolEtb,
    winners,
    payoutsByPlayer: Array.from(playerMap.values()),
  };
}
