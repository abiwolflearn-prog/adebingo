import type {
  BingoCard,
  BingoColumnSpec,
  BingoLetter,
  GameLifecycleStage,
  WinResult,
} from '../types/bingo.ts';

export const BINGO_COLUMNS: BingoColumnSpec[] = [
  { letter: 'B', min: 1, max: 15, color: '#087e50', accentBg: '#e4f8ec' },
  { letter: 'I', min: 16, max: 30, color: '#d99116', accentBg: '#fef5dc' },
  { letter: 'N', min: 31, max: 45, color: '#0d8a72', accentBg: '#e0f7f2' },
  { letter: 'G', min: 46, max: 60, color: '#20639b', accentBg: '#e5f1fb' },
  { letter: 'O', min: 61, max: 75, color: '#8e44ad', accentBg: '#f4eaf8' },
];

export const DEFAULT_GAME_RULES = {
  maxPlayersPerRoom: 600,
  maxCardsPerRoom: 600,
  maxCardsPerPlayer: 4,
  defaultCardPrice: 10,
  adeyShareRatio: 0.2,
  winnersPrizeRatio: 0.8,
  lobbyCountdownSeconds: 60,
  minEligiblePlayers: 3,
  initialAccountBalanceEtb: 15,
  inviterBonusEtb: 20,
  inviteeBonusEtb: 0,
} as const;

export interface AuthoritativeGameFinancials {
  maxPlayers: number;
  maxCapacityPlayers: number;
  entryPriceEtb: number;
  confirmedPlayersCount: number;
  verifiedPaidEntriesCount: number;
  availableSpaces: number;
  totalCardsSold: number;
  totalCollectedEtb: number;
  adeyShareRatio: number;
  winnersPrizeRatio: number;
  adeyShareEtb: number;
  winnersPrizePoolEtb: number;
}

/**
 * Authoritative financial rules for ADEYBINGO:
 * - Maximum capacity: 600 individual players (kept strictly separate from totalCardsSold).
 * - Entry price: 10 ETB per verified paid player entry.
 * - ADEYBINGO share: 20% (totalCollected * 0.20 -> 1,200 ETB at 600 players).
 * - Winners' prize pool: 80% (totalCollected * 0.80 -> 4,800 ETB at 600 players).
 * - Available spaces: 600 - confirmedPlayersCount.
 * Only verified paid entries count as revenue.
 */
export function calculateAuthoritativeGameFinancials(
  confirmedPaidPlayersCount: number,
  totalCardsSold?: number,
  entryPriceEtb: number = DEFAULT_GAME_RULES.defaultCardPrice
): AuthoritativeGameFinancials {
  const maxCapacityPlayers = DEFAULT_GAME_RULES.maxPlayersPerRoom;
  const safeEntryPrice = Number.isFinite(entryPriceEtb) && entryPriceEtb > 0 ? entryPriceEtb : 10;
  const confirmedPlayersCount = Math.max(
    0,
    Math.min(maxCapacityPlayers, Math.floor(Number(confirmedPaidPlayersCount) || 0))
  );
  const verifiedPaidEntriesCount = confirmedPlayersCount;
  const availableSpaces = Math.max(0, maxCapacityPlayers - confirmedPlayersCount);
  const resolvedCardsSold = Math.max(
    confirmedPlayersCount,
    Math.min(
      DEFAULT_GAME_RULES.maxCardsPerRoom,
      Math.floor(Number(totalCardsSold ?? confirmedPlayersCount) || 0)
    )
  );
  const totalCollectedEtb = Number((verifiedPaidEntriesCount * safeEntryPrice).toFixed(2));
  const adeyShareEtb = Number(
    (totalCollectedEtb * DEFAULT_GAME_RULES.adeyShareRatio).toFixed(2)
  );
  const winnersPrizePoolEtb = Number(
    (totalCollectedEtb * DEFAULT_GAME_RULES.winnersPrizeRatio).toFixed(2)
  );

  return {
    maxPlayers: maxCapacityPlayers,
    maxCapacityPlayers,
    entryPriceEtb: safeEntryPrice,
    confirmedPlayersCount,
    verifiedPaidEntriesCount,
    availableSpaces,
    totalCardsSold: resolvedCardsSold,
    totalCollectedEtb,
    adeyShareRatio: DEFAULT_GAME_RULES.adeyShareRatio,
    winnersPrizeRatio: DEFAULT_GAME_RULES.winnersPrizeRatio,
    adeyShareEtb,
    winnersPrizePoolEtb,
  };
}

/**
 * Maps internal room status & player count to the shared game lifecycle:
 * WAITING -> REGISTRATION -> READY -> IN_PROGRESS -> COMPLETED
 */
export function resolveGameLifecycleStage(params: {
  status: 'waiting' | 'countdown' | 'live' | 'completed';
  confirmedPlayersCount: number;
  countdownSeconds?: number;
  minPlayers?: number;
  explicitStage?: GameLifecycleStage;
}): GameLifecycleStage {
  if (params.explicitStage) {
    return params.explicitStage;
  }
  const { status, confirmedPlayersCount, countdownSeconds = 60, minPlayers = 2 } = params;
  if (status === 'completed') return 'COMPLETED';
  if (status === 'live') return 'IN_PROGRESS';
  if (confirmedPlayersCount <= 0 || status === 'waiting') return 'WAITING';
  if (
    confirmedPlayersCount >= minPlayers &&
    (countdownSeconds <= 10 || confirmedPlayersCount >= DEFAULT_GAME_RULES.maxPlayersPerRoom)
  ) {
    return 'READY';
  }
  return 'REGISTRATION';
}

/**
 * Seeded Mulberry32 PRNG so that each card ID (1..600) has a deterministic,
 * unique, reproducible 5x5 B-I-N-G-O layout across Lobby, Picker, and Live Game.
 */
function mulberry32(seed: number): () => number {
  let a = (seed ^ 0x6d2b79f5) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns the B-I-N-G-O column letter for any valid ball number (1..75).
 */
export function getLetterForNumber(n: number): BingoLetter {
  if (n < 1 || n > 75 || !Number.isInteger(n)) {
    throw new RangeError(`Bingo number must be an integer between 1 and 75, got ${n}`);
  }
  const col = BINGO_COLUMNS.find((c) => n >= c.min && n <= c.max);
  return col ? col.letter : 'B';
}

/**
 * Formats a ball number with its column prefix, e.g., 9 -> "B-9", 30 -> "I-30".
 */
export function formatBallCall(n: number): string {
  return `${getLetterForNumber(n)}-${n}`;
}

/**
 * Generates a deterministic 5x5 Bingo card for a specific card number (1..600).
 * Column 0 (B): 1..15
 * Column 1 (I): 16..30
 * Column 2 (N): 31..45 (with row 2, col 2 = 0 FREE SPACE)
 * Column 3 (G): 46..60
 * Column 4 (O): 61..75
 */
export function generateDeterministicCard(cardId: number): BingoCard {
  if (!Number.isInteger(cardId) || cardId < 1 || cardId > DEFAULT_GAME_RULES.maxCardsPerRoom) {
    throw new RangeError(
      `Card ID must be an integer between 1 and ${DEFAULT_GAME_RULES.maxCardsPerRoom}, got ${cardId}`
    );
  }

  const rng = mulberry32(cardId * 9973 + 1337);

  const columns: number[][] = BINGO_COLUMNS.map((colSpec) => {
    const pool = Array.from({ length: 15 }, (_, i) => colSpec.min + i);
    // Fisher-Yates shuffle using seeded PRNG
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, 5);
  });

  const grid: number[][] = Array.from({ length: 5 }, (_, rowIdx) =>
    columns.map((colValues, colIdx) => (rowIdx === 2 && colIdx === 2 ? 0 : colValues[rowIdx]))
  );

  return {
    id: cardId,
    serial: `ADB-${String(cardId).padStart(3, '0')}`,
    grid,
  };
}

/**
 * Validates and toggles a player's card selection within room and player constraints.
 */
export function toggleCardSelection(
  currentSelectedIds: number[],
  targetCardId: number,
  takenByOthersIds: number[],
  maxCardsPerPlayer: number = DEFAULT_GAME_RULES.maxCardsPerPlayer,
  maxCardsPerRoom: number = DEFAULT_GAME_RULES.maxCardsPerRoom
): {
  ok: boolean;
  reason?: 'out_of_range' | 'taken_by_other' | 'max_limit_reached';
  selectedIds: number[];
} {
  if (!Number.isInteger(targetCardId) || targetCardId < 1 || targetCardId > maxCardsPerRoom) {
    return { ok: false, reason: 'out_of_range', selectedIds: currentSelectedIds };
  }

  // If already selected by this player, deselect it
  if (currentSelectedIds.includes(targetCardId)) {
    return {
      ok: true,
      selectedIds: currentSelectedIds.filter((id) => id !== targetCardId),
    };
  }

  if (takenByOthersIds.includes(targetCardId)) {
    return { ok: false, reason: 'taken_by_other', selectedIds: currentSelectedIds };
  }

  if (currentSelectedIds.length >= maxCardsPerPlayer) {
    return { ok: false, reason: 'max_limit_reached', selectedIds: currentSelectedIds };
  }

  return {
    ok: true,
    selectedIds: [...currentSelectedIds, targetCardId],
  };
}

/**
 * Draws the next uncalled number from 1..75. Returns null if all 75 have been called.
 */
export function drawNextBall(
  calledNumbers: number[],
  rng: () => number = Math.random
): number | null {
  const calledSet = new Set(calledNumbers);
  const remaining: number[] = [];
  for (let n = 1; n <= 75; n++) {
    if (!calledSet.has(n)) {
      remaining.push(n);
    }
  }
  if (remaining.length === 0) return null;
  const idx = Math.floor(rng() * remaining.length);
  return remaining[idx];
}

/**
 * Checks whether a BingoCard has a valid winning pattern (Row, Column, Diagonal, or Four Corners).
 * Every cell in the winning pattern must be BOTH marked by the player (or Free center 0)
 * AND present in `calledNumbers` (when `verifyAgainstCalls` is true).
 */
export function checkCardWin(
  card: BingoCard,
  markedNumbers: number[],
  calledNumbers: number[],
  verifyAgainstCalls: boolean = true
): WinResult {
  const markedSet = new Set(markedNumbers);
  const calledSet = new Set(calledNumbers);

  const isCellValid = (r: number, c: number): boolean => {
    const val = card.grid[r][c];
    if (val === 0) return true; // Center free space is always valid
    if (!markedSet.has(val)) return false;
    if (verifyAgainstCalls && !calledSet.has(val)) return false;
    return true;
  };

  // 1. Check 5 Horizontal Rows
  for (let r = 0; r < 5; r++) {
    const cells: [number, number][] = [
      [r, 0],
      [r, 1],
      [r, 2],
      [r, 3],
      [r, 4],
    ];
    if (cells.every(([row, col]) => isCellValid(row, col))) {
      return {
        won: true,
        cardId: card.id,
        patternType: 'row',
        patternLabelAm: `አግድም መስመር (ረድፍ ${r + 1})`,
        patternLabelEn: `Horizontal Line (Row ${r + 1})`,
        winningCells: cells,
      };
    }
  }

  // 2. Check 5 Vertical Columns
  for (let c = 0; c < 5; c++) {
    const cells: [number, number][] = [
      [0, c],
      [1, c],
      [2, c],
      [3, c],
      [4, c],
    ];
    if (cells.every(([row, col]) => isCellValid(row, col))) {
      const colLetter = BINGO_COLUMNS[c].letter;
      return {
        won: true,
        cardId: card.id,
        patternType: 'column',
        patternLabelAm: `ቋሚ መስመር (${colLetter} ዓምድ)`,
        patternLabelEn: `Vertical Line (${colLetter} Column)`,
        winningCells: cells,
      };
    }
  }

  // 3. Check Main Diagonal (Top-Left to Bottom-Right)
  const diag1: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ];
  if (diag1.every(([row, col]) => isCellValid(row, col))) {
    return {
      won: true,
      cardId: card.id,
      patternType: 'diagonal',
      patternLabelAm: 'ሰያፍ መስመር (Diagonal)',
      patternLabelEn: 'Main Diagonal Line',
      winningCells: diag1,
    };
  }

  // 4. Check Anti-Diagonal (Top-Right to Bottom-Left)
  const diag2: [number, number][] = [
    [0, 4],
    [1, 3],
    [2, 2],
    [3, 1],
    [4, 0],
  ];
  if (diag2.every(([row, col]) => isCellValid(row, col))) {
    return {
      won: true,
      cardId: card.id,
      patternType: 'diagonal',
      patternLabelAm: 'ሰያፍ መስመር (Cross Diagonal)',
      patternLabelEn: 'Cross Diagonal Line',
      winningCells: diag2,
    };
  }

  // 5. Check Four Corners
  const corners: [number, number][] = [
    [0, 0],
    [0, 4],
    [4, 0],
    [4, 4],
  ];
  if (corners.every(([row, col]) => isCellValid(row, col))) {
    return {
      won: true,
      cardId: card.id,
      patternType: 'four_corners',
      patternLabelAm: 'አራት ማዕዘን (Four Corners)',
      patternLabelEn: 'Four Corners Pattern',
      winningCells: corners,
    };
  }

  // Find closest line (fewest missing numbers) to help player feedback
  const candidateLines: [number, number][][] = [
    ...Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (__, c) => [r, c] as [number, number])
    ),
    ...Array.from({ length: 5 }, (_, c) =>
      Array.from({ length: 5 }, (__, r) => [r, c] as [number, number])
    ),
    diag1,
    diag2,
    corners,
  ];

  let bestMissing: number[] = [1, 2, 3, 4, 5];
  for (const line of candidateLines) {
    const missing: number[] = [];
    for (const [r, c] of line) {
      if (!isCellValid(r, c)) {
        missing.push(card.grid[r][c]);
      }
    }
    if (missing.length < bestMissing.length) {
      bestMissing = missing;
    }
  }

  return {
    won: false,
    cardId: card.id,
    winningCells: [],
    missingNumbers: bestMissing,
  };
}

/**
 * Returns the next uncalled number that helps the given card complete its closest line.
 * Useful for demo play so users can test a full winning round quickly.
 */
export function getNextHelpfulNumberForCard(
  card: BingoCard,
  calledNumbers: number[]
): number | null {
  const calledSet = new Set(calledNumbers);
  const candidateLines: [number, number][][] = [
    // Middle row & middle column & diagonals only need 4 numbers because of Free center!
    [
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
    ],
    [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ],
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ],
    [
      [0, 4],
      [1, 3],
      [2, 2],
      [3, 1],
      [4, 0],
    ],
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ],
  ];

  let bestUncalled: number[] | null = null;
  for (const line of candidateLines) {
    const uncalledInLine: number[] = [];
    for (const [r, c] of line) {
      const val = card.grid[r][c];
      if (val !== 0 && !calledSet.has(val)) {
        uncalledInLine.push(val);
      }
    }
    if (
      uncalledInLine.length > 0 &&
      (bestUncalled === null || uncalledInLine.length < bestUncalled.length)
    ) {
      bestUncalled = uncalledInLine;
    }
  }

  return bestUncalled ? bestUncalled[0] : drawNextBall(calledNumbers);
}

/**
 * Checks whether a lobby room meets the minimum player & card requirements to start.
 */
export function isRoomEligibleToStart(
  activePlayers: number,
  selectedPlayerCardsCount: number,
  minPlayers: number = DEFAULT_GAME_RULES.minEligiblePlayers
): boolean {
  return activePlayers >= minPlayers && selectedPlayerCardsCount >= 1;
}

/**
 * Calculates demo prize pool breakdown from cards in play.
 */
export function calculateDemoPrizePool(
  totalCardsInRoom: number,
  cardPrice: number = DEFAULT_GAME_RULES.defaultCardPrice,
  serviceReserveRatio: number = DEFAULT_GAME_RULES.adeyShareRatio
): {
  grossTotal: number;
  winnerPrizeDemo: number;
  serviceReserveDemo: number;
} {
  const safeCards = Math.max(0, Math.min(DEFAULT_GAME_RULES.maxCardsPerRoom, totalCardsInRoom));
  const grossTotal = safeCards * cardPrice;
  const serviceReserveDemo = Math.round(grossTotal * serviceReserveRatio);
  const winnerPrizeDemo = grossTotal - serviceReserveDemo;
  return {
    grossTotal,
    winnerPrizeDemo,
    serviceReserveDemo,
  };
}
