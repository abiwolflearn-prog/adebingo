import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDeterministicCard } from './rules.ts';
import { evaluateRoundWinners } from './roundSettlement.ts';

test('evaluateRoundWinners finishes immediately on one diagonal and credits single winner', () => {
  const card1 = generateDeterministicCard(1);
  // Main diagonal: [0,0], [1,1], [2,2]=FREE, [3,3], [4,4]
  const diagNums = [card1.grid[0][0], card1.grid[1][1], card1.grid[3][3], card1.grid[4][4]];

  const res = evaluateRoundWinners({
    entries: [
      { cardId: 1, uid: 'tg_101', telegramUserId: 101, displayName: 'Abebe' },
      { cardId: 2, uid: 'tg_202', telegramUserId: 202, displayName: 'Kebede' },
    ],
    calledNumbers: diagNums,
    cardPrice: 10,
    totalCardsInRoom: 2,
  });

  assert.equal(res.hasWinner, true);
  assert.equal(res.winners.length, 1);
  assert.equal(res.winners[0].uid, 'tg_101');
  assert.equal(res.winners[0].cardId, 1);
  assert.equal(res.winners[0].patternType, 'diagonal');
  assert.equal(res.prizePoolEtb, 17); // 2 * 10 = 20 gross, 15% reserve = 3 -> 17 ETB pool
  assert.equal(res.payoutsByPlayer.length, 1);
  assert.equal(res.payoutsByPlayer[0].totalPrizeEtb, 17);
});

test('evaluateRoundWinners splits prize pool evenly when two players win simultaneously', () => {
  const card1 = generateDeterministicCard(1);
  const card5 = generateDeterministicCard(5);

  const diagCard1 = [card1.grid[0][0], card1.grid[1][1], card1.grid[3][3], card1.grid[4][4]];
  const antiDiagCard5 = [card5.grid[0][4], card5.grid[1][3], card5.grid[3][1], card5.grid[4][0]];
  const combinedCalls = Array.from(new Set([...diagCard1, ...antiDiagCard5]));

  const res = evaluateRoundWinners({
    entries: [
      { cardId: 1, uid: 'tg_101', telegramUserId: 101, displayName: 'Abebe' },
      { cardId: 5, uid: 'tg_202', telegramUserId: 202, displayName: 'Almaz' },
      { cardId: 9, uid: 'tg_303', telegramUserId: 303, displayName: 'Dawit' },
    ],
    calledNumbers: combinedCalls,
    cardPrice: 20,
    totalCardsInRoom: 3, // 60 gross -> 9 reserve -> 51 ETB pool
  });

  assert.equal(res.hasWinner, true);
  assert.equal(res.winners.length, 2);
  assert.equal(res.prizePoolEtb, 51);
  assert.equal(res.payoutsByPlayer.length, 2);

  const totalPaid = res.payoutsByPlayer.reduce((s, p) => s + p.totalPrizeEtb, 0);
  assert.equal(Number(totalPaid.toFixed(2)), 51);
  assert.equal(res.payoutsByPlayer[0].totalPrizeEtb, 25.5);
  assert.equal(res.payoutsByPlayer[1].totalPrizeEtb, 25.5);
});
