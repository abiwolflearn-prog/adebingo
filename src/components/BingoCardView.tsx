import { BINGO_COLUMNS, checkCardWin } from '../game/rules';
import { BingoCard, Language } from '../types/bingo';

interface BingoCardViewProps {
  card: BingoCard;
  calledNumbers: number[];
  markedNumbers: number[];
  onToggleCell?: (num: number, cardId: number) => void;
  compact?: boolean;
  lang: Language;
  onRemoveCard?: (cardId: number) => void;
}

export function BingoCardView({
  card,
  calledNumbers,
  markedNumbers,
  onToggleCell,
  compact = false,
  lang,
  onRemoveCard,
}: BingoCardViewProps) {
  const winCheck = checkCardWin(card, markedNumbers, calledNumbers, true);
  const winningCoords = new Set(winCheck.winningCells.map(([r, c]) => `${r}-${c}`));
  const isOneAway = !winCheck.won && winCheck.missingNumbers?.length === 1;

  const canToggleCells = Boolean(onToggleCell);

  return (
    <div
      data-testid={`bingo-card-${card.id}`}
      className={`bg-[#0b1526] border transition-all ${
        winCheck.won
          ? 'border-[#facc15] ring-2 ring-[#facc15]/60 shadow-[0_0_24px_rgba(250,204,21,0.22)]'
          : isOneAway
          ? 'border-[#22d3ee] shadow-[0_0_20px_rgba(34,211,238,0.18)]'
          : 'border-[#1e3252]'
      } ${compact ? 'p-1.5 rounded-lg' : 'p-2.5 sm:p-3 rounded-2xl'}`}
    >
      {/* Card Top Meta Row */}
      <div
        className={`flex items-center justify-between px-0.5 ${
          compact ? 'pb-0.5 text-[10px]' : 'pb-2 text-xs'
        }`}
      >
        <div className="flex items-center gap-1 font-bold text-[#e2e8f0] min-w-0">
          <span className={`font-['Outfit'] text-[#22d3ee] ${compact ? 'text-[11px]' : 'text-sm'}`}>
            {card.id}
          </span>
          {!compact && (
            <>
              <span aria-hidden="true" className="text-[#475569]">
                ·
              </span>
              <span className="font-mono text-[11px] text-[#94a3b8] truncate">{card.serial}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {winCheck.won && (
            <span
              className={`font-extrabold text-[#451a03] bg-[#facc15] rounded ${
                compact ? 'text-[8px] px-1 py-0.5' : 'text-[11px] px-2 py-0.5 rounded-md'
              }`}
            >
              ★ BINGO!
            </span>
          )}
          {!winCheck.won && isOneAway && (
            <span className={`font-bold text-[#22d3ee] ${compact ? 'text-[9px]' : 'text-[11px]'}`}>
              {lang === 'am' ? '1 ቀረው!' : '1 Away!'}
            </span>
          )}
          {onRemoveCard && (
            <button
              type="button"
              onClick={() => onRemoveCard(card.id)}
              className={`text-[#94a3b8] hover:text-red-400 rounded transition-colors ${
                compact ? 'text-[10px] px-1 leading-none' : 'text-[11px] px-1.5 py-0.5'
              }`}
              aria-label={`Remove card ${card.id}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* B I N G O Header */}
      <div className={`grid grid-cols-5 ${compact ? 'gap-0.5 mb-0.5' : 'gap-1.5 mb-1.5'}`}>
        {BINGO_COLUMNS.map((col) => (
          <div
            key={col.letter}
            className={`bg-gradient-to-br from-[#22d3ee] to-[#0284c7] text-[#04101d] flex items-center justify-center font-['Outfit'] font-extrabold shadow-xs ${
              compact ? 'h-4 text-[9px] rounded' : 'h-8 text-sm rounded-lg'
            }`}
          >
            {col.letter}
          </div>
        ))}
      </div>

      {/* 5x5 Number Grid */}
      <div className={`grid grid-rows-5 ${compact ? 'gap-0.5' : 'gap-1.5'}`}>
        {card.grid.map((row, rIdx) => (
          <div key={rIdx} className={`grid grid-cols-5 ${compact ? 'gap-0.5' : 'gap-1.5'}`}>
            {row.map((num, cIdx) => {
              const isFree = num === 0;
              const isCalled = isFree || calledNumbers.includes(num);
              const isMarked = isFree || markedNumbers.includes(num);
              const isWinningCell = winningCoords.has(`${rIdx}-${cIdx}`);

              let cellClasses =
                'bg-[#13223b] text-[#e2e8f0] hover:bg-[#1a2e4f] border border-[#1f3458]';
              if (isFree) {
                cellClasses =
                  'bg-gradient-to-br from-[#fde047] to-[#f59e0b] text-[#451a03] font-black border border-[#fef08a]/60';
              } else if (isWinningCell) {
                cellClasses =
                  'bg-gradient-to-br from-[#fde047] to-[#f59e0b] text-[#451a03] font-black border border-[#fef08a] scale-[1.03] shadow-[0_0_12px_rgba(250,204,21,0.45)]';
              } else if (isMarked) {
                cellClasses =
                  'bg-gradient-to-br from-[#22d3ee] to-[#14b8a6] text-[#041824] font-black border border-[#a5f3fc]/60 shadow-[0_0_10px_rgba(34,211,238,0.3)]';
              } else if (isCalled) {
                cellClasses =
                  'bg-[#0f2f46] text-[#67e8f9] border border-[#22d3ee]/60';
              }

              return (
                <button
                  key={`${rIdx}-${cIdx}`}
                  type="button"
                  disabled={!canToggleCells || isFree}
                  onClick={() => onToggleCell?.(num, card.id)}
                  aria-label={
                    isFree
                      ? `Card ${card.id} Free center space`
                      : `Card ${card.id} number ${num}${isCalled ? ' called' : ''}${
                          isMarked ? ' marked' : ''
                        }`
                  }
                  className={`aspect-square font-['Outfit'] font-bold flex items-center justify-center transition-all select-none tabular-nums ${
                    compact
                      ? 'text-[10px] min-h-[20px] rounded'
                      : 'text-sm sm:text-base min-h-[42px] rounded-lg'
                  } ${cellClasses} ${
                    canToggleCells && !isFree ? 'active:scale-95 cursor-pointer' : 'cursor-default'
                  }`}
                >
                  {isFree ? '★' : num}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
