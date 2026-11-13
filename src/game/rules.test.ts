import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BINGO_COLUMNS,
  DEFAULT_GAME_RULES,
  calculateDemoPrizePool,
  checkCardWin,
  drawNextBall,
  formatBallCall,
  generateDeterministicCard,
  getLetterForNumber,
  getNextHelpfulNumberForCard,
  isRoomEligibleToStart,
  toggleCardSelection,
} from './rules';

test('getLetterForNumber maps 1..75 to B, I, N, G, O accurately', () => {
  assert.equal(getLetterForNumber(1), 'B');
  assert.equal(getLetterForNumber(15), 'B');
  assert.equal(getLetterForNumber(16), 'I');
  assert.equal(getLetterForNumber(30), 'I');
  assert.equal(getLetterForNumber(31), 'N');
  assert.equal(getLetterForNumber(45), 'N');
  assert.equal(getLetterForNumber(46), 'G');
  assert.equal(getLetterForNumber(60), 'G');
  assert.equal(getLetterForNumber(61), 'O');
  assert.equal(getLetterForNumber(75), 'O');
  assert.equal(formatBallCall(9), 'B-9');
  assert.equal(formatBallCall(30), 'I-30');
  assert.throws(() => getLetterForNumber(0), RangeError);
  assert.throws(() => getLetterForNumber(76), RangeError);
});

test('generateDeterministicCard produces valid 5x5 cards for IDs 1..600 with free center', () => {
  const card1 = generateDeterministicCard(1);
  const card1Again = generateDeterministicCard(1);
  const card600 = generateDeterministicCard(600);

  assert.deepEqual(card1, card1Again, 'Card generation must be deterministic for the same ID');
  assert.notDeepEqual(card1.grid, card600.grid, 'Different card IDs must have distinct grids');
  assert.equal(card1.serial, 'ADB-001');
  assert.equal(card600.serial, 'ADB-600');
  assert.equal(card1.grid[2][2], 0, 'Center cell [2][2] must be 0 (free space)');

  // Check column ranges and uniqueness
  for (let colIdx = 0; colIdx < 5; colIdx++) {
    const spec = BINGO_COLUMNS[colIdx];
    const seen = new Set<number>();
    for (let rowIdx = 0; rowIdx < 5; rowIdx++) {
      const val = card1.grid[rowIdx][colIdx];
      if (rowIdx === 2 && colIdx === 2) {
        assert.equal(val, 0);
        continue;
      }
      assert.ok(
        val >= spec.min && val <= spec.max,
        `Value ${val} at [${rowIdx}][${colIdx}] out of range ${spec.min}..${spec.max}`
      );
      assert.ok(!seen.has(val), `Duplicate number ${val} in column ${spec.letter}`);
      seen.add(val);
    }
  }

  assert.throws(() => generateDeterministicCard(0), RangeError);
  assert.throws(() => generateDeterministicCard(601), RangeError);
});

test('toggleCardSelection enforces 1-600 range, max 4 cards per player, and taken cards', () => {
  const taken = [10, 20];
  let selected: number[] = [];

  // Select 4 valid cards
  for (const id of [1, 2, 3, 4]) {
    const res = toggleCardSelection(selected, id, taken);
    assert.equal(res.ok, true);
    selected = res.selectedIds;
  }
  assert.deepEqual(selected, [1, 2, 3, 4]);

  // Attempt 5th card -> rejected with max_limit_reached
  const fifth = toggleCardSelection(selected, 5, taken);
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, 'max_limit_reached');
  assert.equal(fifth.selectedIds.length, DEFAULT_GAME_RULES.maxCardsPerPlayer);

  // Deselect card 2 -> succeeds
  const deselect = toggleCardSelection(selected, 2, taken);
  assert.equal(deselect.ok, true);
  assert.deepEqual(deselect.selectedIds, [1, 3, 4]);

  // Attempt taken card 10 -> rejected
  const takenAttempt = toggleCardSelection(deselect.selectedIds, 10, taken);
  assert.equal(takenAttempt.ok, false);
  assert.equal(takenAttempt.reason, 'taken_by_other');
});

test('drawNextBall draws unique numbers from 1..75 and returns null when full', () => {
  const called: number[] = [];
  for (let i = 0; i < 75; i++) {
    const next = drawNextBall(called, () => 0);
    assert.ok(next !== null && next >= 1 && next <= 75);
    assert.ok(!called.includes(next));
    called.push(next);
  }
  assert.equal(called.length, 75);
  assert.equal(drawNextBall(called), null);
});

test('checkCardWin verifies row, diagonal with free space, and prevents uncalled false claims', () => {
  const card = generateDeterministicCard(7);
  // Middle row is [2][0], [2][1], 0 (FREE), [2][3], [2][4]
  const middleRowNums = [card.grid[2][0], card.grid[2][1], card.grid[2][3], card.grid[2][4]];

  // Marked but NOT called yet -> should not win when verifyAgainstCalls is true
  const uncalledCheck = checkCardWin(card, middleRowNums, [middleRowNums[0]], true);
  assert.equal(uncalledCheck.won, false);

  // Marked AND called -> wins on horizontal row 3!
  const validWin = checkCardWin(card, middleRowNums, middleRowNums, true);
  assert.equal(validWin.won, true);
  assert.equal(validWin.patternType, 'row');
  assert.equal(validWin.winningCells.length, 5);

  // Helpful number finder returns a number needed to complete a line
  const helpful = getNextHelpfulNumberForCard(card, [middleRowNums[0], middleRowNums[1], middleRowNums[2]]);
  assert.equal(helpful, middleRowNums[3]);
});

test('room eligibility and demo prize pool calculations', () => {
  assert.equal(isRoomEligibleToStart(3, 1), true);
  assert.equal(isRoomEligibleToStart(2, 2), false);
  assert.equal(isRoomEligibleToStart(5, 0), false);

  const pool = calculateDemoPrizePool(40, 10, 0.15);
  assert.equal(pool.grossTotal, 400);
  assert.equal(pool.serviceReserveDemo, 60);
  assert.equal(pool.winnerPrizeDemo, 340);
});
