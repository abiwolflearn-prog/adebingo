import { useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  CheckSquare,
  Square,
  Plus,
  Grid,
  Award,
  Zap,
} from 'lucide-react';
import { BINGO_COLUMNS, calculateDemoPrizePool, formatBallCall } from '../game/rules';
import { BingoCard, Language, RoomConfig, ScreenId } from '../types/bingo';
import { BingoBall3D } from './BingoBall3D';
import { BingoCardView } from './BingoCardView';

interface LiveGameScreenProps {
  lang: Language;
  activeRoom: RoomConfig;
  cardPrice: number;
  playerCards: BingoCard[];
  calledNumbers: number[];
  markedNumbers: number[];
  autoMark: boolean;
  onToggleAutoMark: () => void;
  autoCallerActive: boolean;
  onToggleAutoCaller: () => void;
  callerIntervalSec: number;
  onChangeCallerInterval: (sec: number) => void;
  onCallNextBall: () => void;
  onCallHelpfulBall: () => void;
  onResetRound: () => void;
  onToggleMarkCell: (num: number, cardId: number) => void;
  onAddQuickCard: () => void;
  onRemoveCard: (cardId: number) => void;
  onClaimBingo: () => void;
  reducedMotion: boolean;
  onNavigate: (screen: ScreenId) => void;
}

export function LiveGameScreen({
  lang,
  activeRoom,
  cardPrice,
  playerCards,
  calledNumbers,
  markedNumbers,
  autoMark,
  onToggleAutoMark,
  autoCallerActive,
  onToggleAutoCaller,
  callerIntervalSec,
  onChangeCallerInterval,
  onCallNextBall,
  onCallHelpfulBall,
  onResetRound,
  onToggleMarkCell,
  onAddQuickCard,
  onRemoveCard,
  onClaimBingo,
  reducedMotion,
  onNavigate,
}: LiveGameScreenProps) {
  const [showMasterBoard, setShowMasterBoard] = useState(false);

  const latestBall = calledNumbers[calledNumbers.length - 1] ?? 9;
  const recentBalls = calledNumbers.slice().reverse().slice(0, 10);
  const totalRoomCards = activeRoom.takenCardIds.length + playerCards.length;
  const prizeSummary = calculateDemoPrizePool(totalRoomCards, cardPrice);

  return (
    <div className="space-y-5">
      {/* Top Arena Status Bar */}
      <section className="bg-gradient-to-r from-[#075d3c] via-[#087e50] to-[#129b60] text-white rounded-2xl p-4 sm:p-5 shadow-md flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-[11px] font-extrabold tracking-wider uppercase text-[#c8f6d9]">
            ● {lang === 'am' ? activeRoom.nameAm : activeRoom.nameEn}
          </span>
          <h2 className="font-['Outfit'] text-2xl font-extrabold mt-0.5">
            {lang === 'am' ? 'የቀጥታ ቢንጎ ውድድር (Demo Arena)' : 'Live Bingo Arena (Demo)'}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="bg-white/15 px-3 py-2 rounded-xl">
            <small className="block text-[10px] text-[#d3f6e1] uppercase">
              {lang === 'am' ? 'ተጫዋቾች' : 'PLAYERS'}
            </small>
            <b className="font-['Outfit'] text-base tabular-nums">{activeRoom.activePlayers}</b>
          </div>

          <div className="bg-white/15 px-3 py-2 rounded-xl">
            <small className="block text-[10px] text-[#d3f6e1] uppercase">
              {lang === 'am' ? 'የእርስዎ ካርዶች' : 'YOUR CARDS'}
            </small>
            <b className="font-['Outfit'] text-base tabular-nums">{playerCards.length}/4</b>
          </div>

          <div className="bg-white/15 px-3 py-2 rounded-xl">
            <small className="block text-[10px] text-[#fde047] uppercase">
              {lang === 'am' ? 'የሙከራ ሽልማት' : 'DEMO POOL'}
            </small>
            <b className="font-['Outfit'] text-base text-[#fde047] tabular-nums">
              {prizeSummary.winnerPrizeDemo} ETB
            </b>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('cards')}
            className="px-3.5 py-2.5 rounded-xl bg-white text-[#087e50] font-extrabold text-xs hover:bg-[#f1fbf5] transition-colors"
          >
            {lang === 'am' ? 'ካርድ ቀይር (1–600)' : 'Change Cards (1–600)'}
          </button>
        </div>
      </section>

      {/* Main Arena Columns: Left = 3D Ball Caller & Controls, Right = Player's 1-4 Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left 5 Columns: 3D Number Caller & Master 1-75 Board */}
        <section className="lg:col-span-5 bg-white border border-[#e3ede6] rounded-2xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <small className="text-[10px] font-extrabold tracking-widest uppercase text-[#16975a]">
                {lang === 'am' ? 'የቀጥታ ቁጥር ጠሪ' : 'LIVE NUMBER CALLER'}
              </small>
              <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
                {formatBallCall(latestBall)}
              </h3>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onToggleAutoCaller}
                className={`px-3 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors ${
                  autoCallerActive
                    ? 'bg-[#fef08a] text-[#713f12]'
                    : 'bg-[#e9f8ef] text-[#087e50]'
                }`}
              >
                {autoCallerActive ? <Pause size={13} /> : <Play size={13} />}
                {autoCallerActive
                  ? lang === 'am'
                    ? 'አውቶ ጠሪ አቁም'
                    : 'Pause Auto'
                  : lang === 'am'
                  ? 'አውቶ ጠሪ ጀምር'
                  : 'Auto Call'}
              </button>

              {[3, 5].map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => onChangeCallerInterval(sec)}
                  className={`px-2 py-1.5 rounded-lg text-[11px] font-mono font-bold ${
                    callerIntervalSec === sec
                      ? 'bg-[#087e50] text-white'
                      : 'bg-[#f1f7f3] text-[#557260]'
                  }`}
                >
                  {sec}s
                </button>
              ))}
            </div>
          </div>

          {/* 3D Ball Stage */}
          <div className="h-44 rounded-2xl bg-[radial-gradient(ellipse_at_center,#effaf2_0%,#ffffff_75%)] border border-[#e7f2ea] flex items-center justify-center gap-6 px-4">
            <BingoBall3D
              number={latestBall}
              size="xl"
              animateEntry
              reducedMotion={reducedMotion}
            />
            <div>
              <span className="text-[11px] font-extrabold tracking-wider uppercase text-[#16975a] block">
                {lang === 'am' ? 'አሁን የተጠራ ኳስ' : 'CURRENT BALL'}
              </span>
              <b
                data-testid="live-latest-ball"
                className="font-['Outfit'] text-2xl font-extrabold text-[#193b2b] tabular-nums block mt-0.5"
              >
                {formatBallCall(latestBall)}
              </b>
              <p className="text-xs text-[#6e8577] mt-1 tabular-nums">
                {calledNumbers.length} / 75{' '}
                {lang === 'am' ? 'ቁጥሮች ተጠርተዋል' : 'numbers announced'}
              </p>
            </div>
          </div>

          {/* Recent Calls Strip */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <small className="text-[10px] font-extrabold tracking-wider uppercase text-[#6e8577]">
                {lang === 'am' ? 'በቅርብ የተጠሩ ቁጥሮች' : 'RECENT CALL HISTORY'}
              </small>
              <button
                type="button"
                onClick={() => setShowMasterBoard((v) => !v)}
                className="text-xs font-bold text-[#087e50] hover:underline flex items-center gap-1"
              >
                <Grid size={13} />
                {showMasterBoard
                  ? lang === 'am'
                    ? '1–75 ሰሌዳ ደብቅ'
                    : 'Hide 1–75 Board'
                  : lang === 'am'
                  ? 'ሁሉንም 1–75 እይ'
                  : 'View All 1–75'}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {recentBalls.map((n, idx) => (
                <span
                  key={n}
                  className={`px-2.5 py-1 rounded-full font-['Outfit'] text-xs font-bold tabular-nums ${
                    idx === 0
                      ? 'bg-[#0c965b] text-white shadow-2xs'
                      : 'bg-[#edf4ef] text-[#496554]'
                  }`}
                >
                  {formatBallCall(n)}
                </span>
              ))}
            </div>
          </div>

          {/* Collapsible 1-75 Master Board */}
          {showMasterBoard && (
            <div className="bg-[#f7fbf8] border border-[#e0ede4] rounded-xl p-3 space-y-1.5">
              {BINGO_COLUMNS.map((col) => (
                <div key={col.letter} className="flex items-center gap-1.5">
                  <b className="w-6 h-6 rounded-md bg-[#087e50] text-white text-xs font-extrabold flex items-center justify-center shrink-0">
                    {col.letter}
                  </b>
                  <div className="grid grid-cols-15 gap-1 flex-1">
                    {Array.from({ length: 15 }, (_, i) => col.min + i).map((num) => {
                      const isCalled = calledNumbers.includes(num);
                      return (
                        <span
                          key={num}
                          className={`h-6 rounded text-[10px] font-mono font-bold flex items-center justify-center tabular-nums ${
                            num === latestBall
                              ? 'bg-[#f2c24b] text-[#451a03] font-extrabold'
                              : isCalled
                              ? 'bg-[#20b96d] text-white'
                              : 'bg-white text-[#8da195] border border-[#e6efe9]'
                          }`}
                        >
                          {num}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Caller Action Controls */}
          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={onCallNextBall}
              className="py-3 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold shadow-xs hover:brightness-105 transition-all"
            >
              {lang === 'am' ? 'ቀጣይ ቁጥር ጥራ →' : 'Call Next Number →'}
            </button>

            <button
              type="button"
              onClick={onCallHelpfulBall}
              className="py-3 px-3 rounded-xl bg-[#fef5dc] border border-[#f3d37a] text-[#78520a] text-xs font-extrabold flex items-center justify-center gap-1.5 hover:bg-[#fdebb6] transition-colors"
              title="Draws a number needed on your first card to test winning quickly"
            >
              <Zap size={14} />
              {lang === 'am' ? 'የሚያሸንፍ ቁጥር ጥራ (Demo)' : 'Draw Helpful Ball'}
            </button>
          </div>

          <button
            type="button"
            onClick={onResetRound}
            className="w-full py-2.5 px-3 rounded-xl border border-[#dfeae1] bg-white text-[#4e6b59] text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-[#f5faf7]"
          >
            <RotateCcw size={13} />
            {lang === 'am' ? 'የሙከራ ዙሩን እንደገና ጀምር' : 'Reset Demo Round'}
          </button>
        </section>

        {/* Right 7 Columns: Player's 1-4 Active Bingo Cards & Auto/Manual Daub Controls */}
        <section className="lg:col-span-7 bg-white border border-[#e3ede6] rounded-2xl p-5 shadow-xs space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <small className="text-[10px] font-extrabold tracking-widest uppercase text-[#16975a]">
                {lang === 'am' ? 'የተጫዋች ካርዶች (1–4)' : 'PLAYER CARDS (MAX 4)'}
              </small>
              <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
                {lang === 'am'
                  ? `የእርስዎ የቢንጎ ካርዶች (${playerCards.length}/4)`
                  : `Your Active Bingo Cards (${playerCards.length}/4)`}
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Auto-Mark Toggle */}
              <button
                type="button"
                onClick={onToggleAutoMark}
                className={`px-3 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 border transition-colors ${
                  autoMark
                    ? 'bg-[#e9f8ef] border-[#12a566] text-[#087e50]'
                    : 'bg-white border-[#d9e7de] text-[#4e6b59]'
                }`}
              >
                {autoMark ? <CheckSquare size={15} /> : <Square size={15} />}
                {lang === 'am'
                  ? autoMark
                    ? 'አውቶ ምልክት፦ በርቷል'
                    : 'በእጅ ምልክት (Manual)'
                  : autoMark
                  ? 'Auto-Mark: ON'
                  : 'Manual Mark'}
              </button>

              <button
                type="button"
                onClick={onAddQuickCard}
                className="px-3 py-2 rounded-xl border border-[#d9e7de] bg-[#f7fbf8] text-[#193b2b] hover:border-[#087e50] text-xs font-extrabold flex items-center gap-1"
              >
                <Plus size={14} />
                {lang === 'am' ? 'ካርድ ጨምር' : 'Add Card'}
              </button>

              <button
                type="button"
                onClick={onClaimBingo}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#f59e0b] to-[#d97706] text-white text-xs font-extrabold flex items-center gap-1.5 shadow-sm hover:brightness-105 active:scale-95 transition-all"
              >
                <Award size={16} />
                BINGO!
              </button>
            </div>
          </div>

          {/* Responsive Grid of 1-4 Player Cards */}
          <div
            className={`grid gap-4 ${
              playerCards.length === 1
                ? 'grid-cols-1 max-w-sm mx-auto'
                : 'grid-cols-1 sm:grid-cols-2'
            }`}
          >
            {playerCards.map((card) => (
              <BingoCardView
                key={card.id}
                card={card}
                calledNumbers={calledNumbers}
                markedNumbers={markedNumbers}
                onToggleCell={onToggleMarkCell}
                lang={lang}
                onRemoveCard={playerCards.length > 1 ? onRemoveCard : undefined}
              />
            ))}
          </div>

          {/* Legend & Instructions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#edf4ef] text-xs text-[#698072]">
            <div className="flex items-center gap-4">
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-full bg-[#dff6e7] border border-[#087e50] mr-1" />
                {lang === 'am' ? 'የተጠራ ቁጥር' : 'Called'}
              </span>
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-full bg-[#3bc97f] mr-1" />
                {lang === 'am' ? 'ምልክት የተደረገበት' : 'Marked'}
              </span>
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-full bg-[#f8dc7b] mr-1" />
                {lang === 'am' ? '★ ነፃ የመሃል ቦታ' : '★ Free Center'}
              </span>
            </div>
            <span>
              {lang === 'am'
                ? 'አግድም፣ ቋሚ፣ ሰያፍ ወይም 4 ማዕዘን ሲሞላ BINGO! ይጫኑ።'
                : 'Complete any row, column, diagonal, or 4 corners and press BINGO!'}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
