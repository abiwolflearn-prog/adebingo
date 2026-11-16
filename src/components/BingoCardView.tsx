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
      className={`bg-white border transition-all ${
        winCheck.won
          ? 'border-[#F5BD42] ring-2 ring-[#F5BD42]/70 shadow-[0_6px_18px_rgba(245,189,66,0.24)]'
          : isOneAway
          ? 'border-[#159447] ring-1 ring-[#159447]/35 shadow-[0_4px_14px_rgba(21,148,71,0.14)]'
          : 'border-[#E7EDE8] shadow-[0_2px_8px_rgba(24,51,38,0.05)]'
      } ${compact ? 'p-1.5 rounded-xl' : 'p-2 sm:p-2.5 rounded-xl'}`}
    >
      {/* Card Top Meta Row */}
      <div
        className={`flex items-center justify-between px-0.5 ${
          compact ? 'pb-1 text-[9.5px]' : 'pb-1.5 text-[11px]'
        }`}
      >
        <div className="flex items-center gap-1 font-bold text-[#183326] min-w-0">
          <span
            className={`font-['Outfit'] font-extrabold text-[#08743A] bg-[#E6F6EB] border border-[#159447]/25 rounded ${
              compact ? 'text-[9.5px] px-1 py-0.5' : 'text-[11px] px-1.5 py-0.5'
            }`}
          >
            #{card.id}
          </span>
          {!compact && (
            <>
              <span aria-hidden="true" className="text-[#68776D]">
                ·
              </span>
              <span className="font-mono text-[10px] text-[#68776D] truncate">{card.serial}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {winCheck.won && (
            <span
              className={`font-extrabold text-[#183326] bg-[#F5BD42] border border-[#D99B20]/40 rounded shadow-xs ${
                compact ? 'text-[8px] px-1 py-0.5' : 'text-[10px] px-1.5 py-0.5'
              }`}
            >
              ★ BINGO!
            </span>
          )}
          {!winCheck.won && isOneAway && (
            <span
              className={`font-extrabold text-[#08743A] bg-[#E6F6EB] rounded px-1 py-0.5 ${
                compact ? 'text-[8.5px]' : 'text-[10px]'
              }`}
            >
              {lang === 'am' ? '1 ቀረው!' : '1 Away!'}
            </span>
          )}
          {onRemoveCard && (
            <button
              type="button"
              onClick={() => onRemoveCard(card.id)}
              className={`text-[#68776D] hover:text-[#D94B4B] hover:bg-red-50 rounded transition-colors ${
                compact ? 'text-[9.5px] px-1 leading-none' : 'text-[10.5px] px-1 py-0.5'
              }`}
              aria-label={`Remove card ${card.id}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* B I N G O Header */}
      <div className={`grid grid-cols-5 ${compact ? 'gap-0.5 mb-0.5' : 'gap-1 mb-1'}`}>
        {BINGO_COLUMNS.map((col, idx) => (
          <div
            key={col.letter}
            className={`flex items-center justify-center font-['Outfit'] font-extrabold shadow-2xs ${
              idx === 2
                ? 'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326]'
                : 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white'
            } ${compact ? 'h-3.5 text-[8.5px] rounded-xs' : 'h-6 text-xs rounded-md'}`}
          >
            {col.letter}
          </div>
        ))}
      </div>

      {/* 5x5 Number Grid */}
      <div className={`grid grid-rows-5 ${compact ? 'gap-0.5' : 'gap-1'}`}>
        {card.grid.map((row, rIdx) => (
          <div key={rIdx} className={`grid grid-cols-5 ${compact ? 'gap-0.5' : 'gap-1'}`}>
            {row.map((num, cIdx) => {
              const isFree = num === 0;
              const isCalled = isFree || calledNumbers.includes(num);
              const isMarked = isFree || markedNumbers.includes(num);
              const isWinningCell = winningCoords.has(`${rIdx}-${cIdx}`);

              let cellClasses =
                'bg-[#FFF9ED] text-[#183326] hover:bg-[#E6F6EB]/70 border border-[#E7EDE8]';
              if (isFree) {
                cellClasses =
                  'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] font-black border border-[#D99B20]/60 shadow-[0_1px_5px_rgba(245,189,66,0.3)]';
              } else if (isWinningCell) {
                cellClasses =
                  'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] font-black border border-[#D99B20] scale-[1.02] shadow-[0_2px_8px_rgba(245,189,66,0.4)]';
              } else if (isMarked) {
                cellClasses =
                  'bg-gradient-to-br from-[#159447] to-[#08743A] text-white font-black border border-[#08743A] shadow-[0_2px_6px_rgba(21,148,71,0.24)]';
              } else if (isCalled) {
                cellClasses =
                  'bg-[#E6F6EB] text-[#08743A] font-extrabold border border-[#159447]/60';
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
                      ? 'text-[9.5px] min-h-[18px] rounded-xs'
                      : 'text-xs sm:text-sm min-h-[32px] rounded-lg'
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
