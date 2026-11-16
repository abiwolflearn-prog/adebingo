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
          ? 'border-[#F5BD42] ring-2 ring-[#F5BD42]/70 shadow-[0_10px_28px_rgba(245,189,66,0.28)]'
          : isOneAway
          ? 'border-[#159447] ring-2 ring-[#159447]/35 shadow-[0_8px_22px_rgba(21,148,71,0.16)]'
          : 'border-[#E7EDE8] shadow-[0_4px_14px_rgba(24,51,38,0.06)]'
      } ${compact ? 'p-1.5 rounded-xl' : 'p-3 sm:p-3.5 rounded-2xl'}`}
    >
      {/* Card Top Meta Row */}
      <div
        className={`flex items-center justify-between px-0.5 ${
          compact ? 'pb-1 text-[10px]' : 'pb-2.5 text-xs'
        }`}
      >
        <div className="flex items-center gap-1.5 font-bold text-[#183326] min-w-0">
          <span
            className={`font-['Outfit'] font-extrabold text-[#08743A] bg-[#E6F6EB] border border-[#159447]/25 rounded-md ${
              compact ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'
            }`}
          >
            #{card.id}
          </span>
          {!compact && (
            <>
              <span aria-hidden="true" className="text-[#68776D]">
                ·
              </span>
              <span className="font-mono text-[11px] text-[#68776D] truncate">{card.serial}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {winCheck.won && (
            <span
              className={`font-extrabold text-[#183326] bg-[#F5BD42] border border-[#D99B20]/40 rounded-md shadow-xs ${
                compact ? 'text-[8px] px-1 py-0.5' : 'text-[11px] px-2 py-0.5'
              }`}
            >
              ★ BINGO!
            </span>
          )}
          {!winCheck.won && isOneAway && (
            <span
              className={`font-extrabold text-[#08743A] bg-[#E6F6EB] rounded-md px-1.5 py-0.5 ${
                compact ? 'text-[9px]' : 'text-[11px]'
              }`}
            >
              {lang === 'am' ? '1 ቀረው!' : '1 Away!'}
            </span>
          )}
          {onRemoveCard && (
            <button
              type="button"
              onClick={() => onRemoveCard(card.id)}
              className={`text-[#68776D] hover:text-[#D94B4B] hover:bg-red-50 rounded-md transition-colors ${
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
        {BINGO_COLUMNS.map((col, idx) => (
          <div
            key={col.letter}
            className={`flex items-center justify-center font-['Outfit'] font-extrabold shadow-xs ${
              idx === 2
                ? 'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326]'
                : 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white'
            } ${compact ? 'h-4 text-[9px] rounded' : 'h-8 text-sm rounded-lg'}`}
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
                'bg-[#FFF9ED] text-[#183326] hover:bg-[#E6F6EB]/70 border border-[#E7EDE8]';
              if (isFree) {
                cellClasses =
                  'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] font-black border border-[#D99B20]/60 shadow-[0_2px_8px_rgba(245,189,66,0.35)]';
              } else if (isWinningCell) {
                cellClasses =
                  'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] font-black border-2 border-[#D99B20] scale-[1.03] shadow-[0_4px_12px_rgba(245,189,66,0.45)]';
              } else if (isMarked) {
                cellClasses =
                  'bg-gradient-to-br from-[#159447] to-[#08743A] text-white font-black border border-[#08743A] shadow-[0_3px_10px_rgba(21,148,71,0.28)]';
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
                      ? 'text-[10px] min-h-[20px] rounded'
                      : 'text-sm sm:text-base min-h-[42px] rounded-xl'
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
