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

  return (
    <div
      data-testid={`bingo-card-${card.id}`}
      className={`bg-[#f0f8f2] border transition-all ${
        winCheck.won
          ? 'border-[#eab308] ring-2 ring-[#facc15] shadow-lg'
          : isOneAway
          ? 'border-[#12a566] shadow-md'
          : 'border-[#d8eadc]'
      } ${compact ? 'p-2 rounded-xl' : 'p-2.5 sm:p-3 rounded-2xl'}`}
    >
      {/* Card Top Meta Row */}
      <div className="flex items-center justify-between px-1 pb-2 text-xs">
        <div className="flex items-center gap-1.5 font-bold text-[#145b38]">
          <span className="font-['Outfit'] text-sm">#{card.id}</span>
          <span aria-hidden="true" className="text-[#8ba394]">
            ·
          </span>
          <span className="font-mono text-[11px] text-[#597765]">{card.serial}</span>
        </div>

        <div className="flex items-center gap-2">
          {winCheck.won && (
            <span className="text-[11px] font-extrabold text-[#95690c] bg-[#fef08a] px-2 py-0.5 rounded-md">
              ★ BINGO!
            </span>
          )}
          {!winCheck.won && isOneAway && (
            <span className="text-[11px] font-bold text-[#087e50]">
              {lang === 'am' ? '1 ቀረው!' : '1 Away!'}
            </span>
          )}
          {onRemoveCard && (
            <button
              type="button"
              onClick={() => onRemoveCard(card.id)}
              className="text-[11px] text-[#7c9084] hover:text-red-600 px-1.5 py-0.5 rounded transition-colors"
              aria-label={`Remove card ${card.id}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* B I N G O Header */}
      <div className="grid grid-cols-5 gap-1.5 mb-1.5">
        {BINGO_COLUMNS.map((col) => (
          <div
            key={col.letter}
            className={`bg-gradient-to-br from-[#20b96d] to-[#087e50] text-white rounded-lg flex items-center justify-center font-['Outfit'] font-extrabold shadow-xs ${
              compact ? 'h-6 text-xs' : 'h-8 text-sm'
            }`}
          >
            {col.letter}
          </div>
        ))}
      </div>

      {/* 5x5 Number Grid */}
      <div className="grid grid-rows-5 gap-1.5">
        {card.grid.map((row, rIdx) => (
          <div key={rIdx} className="grid grid-cols-5 gap-1.5">
            {row.map((num, cIdx) => {
              const isFree = num === 0;
              const isCalled = isFree || calledNumbers.includes(num);
              const isMarked = isFree || markedNumbers.includes(num);
              const isWinningCell = winningCoords.has(`${rIdx}-${cIdx}`);

              let cellClasses =
                'bg-white text-[#284b36] hover:bg-[#e9f7ee] shadow-[0_2px_4px_rgba(22,62,37,0.06)]';
              if (isFree) {
                cellClasses =
                  'bg-[#f8dc7b] text-[#95690c] font-black shadow-[inset_0_0_0_2px_#e5b83b]';
              } else if (isWinningCell) {
                cellClasses =
                  'bg-gradient-to-br from-[#fde047] to-[#f59e0b] text-[#451a03] shadow-[inset_0_0_0_2px_#b45309] scale-[1.02]';
              } else if (isMarked) {
                cellClasses =
                  'bg-[#3bc97f] text-[#054427] shadow-[inset_0_0_0_2px_#0e8047]';
              } else if (isCalled) {
                cellClasses =
                  'bg-[#dff6e7] text-[#087e50] ring-1 ring-[#16a34a]/40';
              }

              return (
                <button
                  key={`${rIdx}-${cIdx}`}
                  type="button"
                  disabled={compact || isFree}
                  onClick={() => onToggleCell?.(num, card.id)}
                  aria-label={
                    isFree
                      ? `Card ${card.id} Free center space`
                      : `Card ${card.id} number ${num}${isCalled ? ' called' : ''}${
                          isMarked ? ' marked' : ''
                        }`
                  }
                  className={`aspect-square rounded-lg font-['Outfit'] font-bold flex items-center justify-center transition-all select-none tabular-nums ${
                    compact ? 'text-xs min-h-[28px]' : 'text-sm sm:text-base min-h-[42px]'
                  } ${cellClasses} ${
                    !compact && !isFree ? 'active:scale-95 cursor-pointer' : 'cursor-default'
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
