import { useEffect, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  CheckSquare,
  Square,
  Plus,
  Grid,
  Award,
  Clock,
  Users,
  Trophy,
  ChevronDown,
  ChevronUp,
  Search,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  BINGO_COLUMNS,
  DEFAULT_GAME_RULES,
  calculateDemoPrizePool,
  formatBallCall,
} from '../game/rules';
import { BingoCard, Language, RoomConfig, ScreenId } from '../types/bingo';
import { getBingoVoiceCallScript } from '../utils/amharicNumbers';
import { t } from '../utils/i18n';
import { BingoBall3D } from './BingoBall3D';
import { BingoCardView } from './BingoCardView';

interface LiveGameScreenProps {
  lang: Language;
  activeRoom: RoomConfig;
  countdown: number;
  cardPrice: number;
  selectedCardIds: number[];
  onToggleCardId: (cardId: number) => void;
  playerCards: BingoCard[];
  calledNumbers: number[];
  markedNumbers: number[];
  autoMark: boolean;
  onToggleAutoMark: () => void;
  autoCallerActive: boolean;
  onToggleAutoCaller: () => void;
  callerIntervalSec: number;
  onChangeCallerInterval: (sec: number) => void;
  onResetRound: () => void;
  onToggleMarkCell: (num: number, cardId: number) => void;
  onAddQuickCard: () => void;
  onRemoveCard: (cardId: number) => void;
  onClaimBingo: () => void;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onSpeakBall: (ballNumber: number) => void;
  reducedMotion: boolean;
  onNavigate: (screen: ScreenId) => void;
}

const ALL_CARD_IDS = Array.from({ length: DEFAULT_GAME_RULES.maxCardsPerRoom }, (_, i) => i + 1);

export function LiveGameScreen({
  lang,
  activeRoom,
  countdown,
  cardPrice,
  selectedCardIds,
  onToggleCardId,
  playerCards,
  calledNumbers,
  markedNumbers,
  autoMark,
  onToggleAutoMark,
  autoCallerActive,
  onToggleAutoCaller,
  callerIntervalSec,
  onChangeCallerInterval,
  onResetRound,
  onToggleMarkCell,
  onAddQuickCard,
  onRemoveCard,
  onClaimBingo,
  voiceEnabled,
  onToggleVoice,
  onSpeakBall,
  reducedMotion,
}: LiveGameScreenProps) {
  const copy = t(lang);
  const [showMasterBoard, setShowMasterBoard] = useState(false);
  const [cardPickerOpen, setCardPickerOpen] = useState(selectedCardIds.length === 0);
  const [cardSearch, setCardSearch] = useState('');

  const isCardsLocked = activeRoom.status === 'live' || activeRoom.status === 'completed';

  useEffect(() => {
    if (isCardsLocked) {
      setCardPickerOpen(false);
    } else if (activeRoom.status === 'countdown' && selectedCardIds.length === 0) {
      setCardPickerOpen(true);
    }
  }, [activeRoom.status, isCardsLocked, selectedCardIds.length]);

  const visibleCardIds = cardSearch.trim()
    ? ALL_CARD_IDS.filter((id) => String(id).includes(cardSearch.trim()))
    : ALL_CARD_IDS;

  const latestBall = calledNumbers.length > 0 ? calledNumbers[calledNumbers.length - 1] : null;
  const recentBalls = calledNumbers.slice().reverse().slice(0, 6);
  const totalRoomCards = activeRoom.takenCardIds.length + selectedCardIds.length;
  const prizeSummary = calculateDemoPrizePool(totalRoomCards, cardPrice);

  const statusText =
    activeRoom.status === 'completed'
      ? lang === 'am'
        ? 'ዙሩ ተጠናቋል · አዲስ ዙር በመጀመር ላይ'
        : 'Round Over · Next Round Starting'
      : activeRoom.status === 'live' || calledNumbers.length > 0
        ? lang === 'am'
          ? 'ቀጥታ ጨዋታ · ካርዶች ተቆልፈዋል'
          : 'Live Round · Cards Locked'
        : lang === 'am'
          ? 'ካርድ ይምረጡ (60 ሰከንድ)'
          : 'Pick Cards (60s Window)';

  return (
    <div className="space-y-4">
      {/* Compact Single-Row Room & Metrics Bar */}
      <section className="rounded-2xl bg-[#0f1a2e] border border-slate-700/50 px-4 py-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-bold text-cyan-400">{statusText}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{lang === 'am' ? activeRoom.nameAm : activeRoom.nameEn}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{cardPrice} ETB</span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <Trophy size={14} className="text-[#facc15]" />
              <span className="text-slate-400 hidden sm:inline">{copy.prizePoolLabel}:</span>
              <b data-testid="live-prize-pool" className="font-['Outfit'] font-extrabold text-[#facc15] tabular-nums">
                {prizeSummary.winnerPrizeDemo} ETB
              </b>
            </div>

            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border ${
                activeRoom.status === 'live'
                  ? 'bg-rose-500/15 border-rose-400/40'
                  : activeRoom.status === 'completed'
                    ? 'bg-amber-500/15 border-amber-400/40'
                    : countdown > 0 && countdown <= 10
                      ? 'bg-amber-500/15 border-amber-400/50'
                      : 'bg-[#091221] border-cyan-400/35'
              }`}
            >
              <Clock
                size={15}
                className={
                  activeRoom.status === 'live'
                    ? 'text-rose-400'
                    : countdown > 0 && countdown <= 10
                      ? 'text-amber-400 animate-pulse'
                      : 'text-[#facc15]'
                }
              />
              <b
                data-testid="live-countdown"
                className={`font-mono text-base font-extrabold tabular-nums ${
                  activeRoom.status === 'live'
                    ? 'text-rose-300'
                    : countdown > 0 && countdown <= 10
                      ? 'text-amber-300'
                      : 'text-[#facc15]'
                }`}
              >
                {activeRoom.status === 'countdown'
                  ? `00:${String(Math.max(0, countdown)).padStart(2, '0')}`
                  : activeRoom.status === 'live'
                    ? `LIVE · ${calledNumbers.length}/75`
                    : '00:05'}
              </b>
            </div>

            <div className="flex items-center gap-1.5">
              <Users size={14} className="text-slate-400" />
              <b className="font-['Outfit'] font-extrabold text-white tabular-nums">
                {activeRoom.activePlayers}
              </b>
            </div>
          </div>
        </div>

        {activeRoom.status === 'countdown' && (
          <div className="w-full h-1.5 rounded-full bg-[#091221] overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                countdown <= 10 ? 'bg-amber-400' : 'bg-gradient-to-r from-[#22d3ee] to-[#facc15]'
              }`}
              style={{ width: `${Math.max(0, Math.min(100, Math.round((countdown / 60) * 100)))}%` }}
            />
          </div>
        )}
      </section>

      {/* Main Play Table: Ball Caller + Player Card(s) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left 5 Columns: Clean Ball Stage & Call Action */}
        <section className="lg:col-span-5 rounded-2xl bg-[#0f1a2e] border border-slate-700/50 p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-extrabold text-cyan-300">
              {copy.liveCallerTitle}
            </span>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onToggleVoice}
                aria-label={voiceEnabled ? 'Mute Amharic voice' : 'Enable Amharic voice'}
                data-testid="voice-toggle"
                className={`px-2.5 py-1.5 rounded-lg text-xs font-extrabold flex items-center gap-1 transition-colors min-h-[36px] ${
                  voiceEnabled
                    ? 'bg-cyan-500/20 border border-cyan-400/40 text-cyan-200'
                    : 'bg-[#14223b] border border-slate-700 text-slate-400'
                }`}
              >
                {voiceEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
                {lang === 'am' ? 'ድምፅ' : 'Voice'}
              </button>

              <button
                type="button"
                onClick={onToggleAutoCaller}
                className={`px-3 py-1.5 rounded-lg text-xs font-extrabold flex items-center gap-1 transition-colors min-h-[36px] ${
                  autoCallerActive
                    ? 'bg-[#facc15] text-[#1e1402]'
                    : 'bg-[#14223b] border border-slate-700 text-cyan-300'
                }`}
              >
                {autoCallerActive ? <Pause size={13} /> : <Play size={13} />}
                {autoCallerActive
                  ? lang === 'am'
                    ? 'አቁም'
                    : 'Pause'
                  : lang === 'am'
                    ? 'አውቶ'
                    : 'Auto'}
              </button>

              {autoCallerActive && (
                <button
                  type="button"
                  onClick={() => onChangeCallerInterval(callerIntervalSec === 3 ? 5 : 3)}
                  className="px-2.5 py-1.5 rounded-lg bg-[#14223b] border border-slate-700 text-[11px] font-mono font-bold text-slate-300 min-h-[36px]"
                >
                  {callerIntervalSec}s
                </button>
              )}
            </div>
          </div>

          {/* 3D Ball Stage */}
          <div className="py-5 px-4 rounded-xl bg-[#091221] border border-slate-800 flex items-center justify-center gap-5">
            {latestBall ? (
              <BingoBall3D
                number={latestBall}
                size="xl"
                animateEntry
                reducedMotion={reducedMotion}
                isRecentHighlight
              />
            ) : (
              <div className="w-20 h-20 rounded-full border-2 border-dashed border-cyan-400/35 bg-[#0f1a2e] flex items-center justify-center text-cyan-300 font-['Outfit'] text-xl font-extrabold">
                --
              </div>
            )}

            <div>
              <span className="text-[11px] font-bold text-slate-400 block">
                {copy.numberCalledLabel}
              </span>
              <div className="flex items-center gap-2">
                <b
                  data-testid="live-latest-ball"
                  className="font-['Outfit'] text-3xl font-extrabold text-white tabular-nums block"
                >
                  {latestBall ? formatBallCall(latestBall) : '--'}
                </b>
                {latestBall && (
                  <button
                    type="button"
                    onClick={() => onSpeakBall(latestBall)}
                    aria-label={lang === 'am' ? 'ቁጥሩን በአማርኛ ድገም' : 'Speak called number'}
                    className="p-1.5 rounded-lg bg-[#14223b] border border-slate-700 text-cyan-300 hover:border-cyan-400"
                  >
                    <Volume2 size={14} />
                  </button>
                )}
              </div>
              <p className="text-xs text-cyan-300 font-bold mt-0.5 tabular-nums">
                {latestBall
                  ? `${getBingoVoiceCallScript(latestBall, lang).displayPhrase} · ${calledNumbers.length}/75`
                  : copy.waitingFirstBall}
              </p>
            </div>
          </div>

          {/* Recent Calls + 1-75 Board Toggle */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-400">{copy.recentCallsLabel}</span>
              <button
                type="button"
                onClick={() => setShowMasterBoard((v) => !v)}
                className="text-cyan-400 font-bold hover:underline flex items-center gap-1"
              >
                <Grid size={13} />
                {showMasterBoard
                  ? lang === 'am'
                    ? '1–75 ደብቅ'
                    : 'Hide 1–75'
                  : lang === 'am'
                    ? '1–75 ሰሌዳ'
                    : '1–75 Board'}
              </button>
            </div>

            {recentBalls.length === 0 ? (
              <p className="text-xs text-slate-500">
                {lang === 'am' ? 'እስካሁን የተጠራ ቁጥር የለም።' : 'No numbers called yet.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 items-center">
                {recentBalls.map((n, idx) => (
                  <span
                    key={n}
                    className={`px-2.5 py-1 rounded-lg font-['Outfit'] text-xs font-extrabold tabular-nums ${
                      idx === 0
                        ? 'bg-[#facc15] text-[#1e1402]'
                        : 'bg-[#14223b] border border-slate-700 text-slate-200'
                    }`}
                  >
                    {formatBallCall(n)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {showMasterBoard && (
            <div className="bg-[#091221] border border-slate-800 rounded-xl p-3 space-y-1.5">
              {BINGO_COLUMNS.map((col) => (
                <div key={col.letter} className="flex items-center gap-1.5">
                  <b className="w-6 h-6 rounded-md bg-cyan-400 text-[#041423] text-xs font-extrabold flex items-center justify-center shrink-0">
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
                              ? 'bg-[#facc15] text-[#451a03] font-extrabold'
                              : isCalled
                                ? 'bg-cyan-400 text-[#041423]'
                                : 'bg-[#111d33] text-slate-500'
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

          {/* Automatic Calling Status + Quiet Reset */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] font-bold text-slate-400">
              {lang === 'am'
                ? 'ቁጥሮች በራስ-ሰር ይጠራሉ'
                : 'Numbers call automatically'}
            </span>

            <button
              type="button"
              onClick={onResetRound}
              aria-label={copy.resetDemoBtn}
              title={copy.resetDemoBtn}
              className="p-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-slate-300 hover:text-white min-h-[40px] min-w-[40px] flex items-center justify-center"
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </section>

        {/* Right 7 Columns: Progressive Card Picker + Player Cards & BINGO CTA */}
        <section className="lg:col-span-7 rounded-2xl bg-[#0f1a2e] border border-slate-700/50 p-4 space-y-4">
          {/* Card Controls Header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setCardPickerOpen((o) => !o)}
              className="px-3 py-2 rounded-xl bg-[#14223b] border border-slate-700 text-xs font-extrabold text-white flex items-center gap-2 min-h-[40px]"
            >
              <span>
                {lang === 'am'
                  ? `ካርዶች (${selectedCardIds.length}/4)`
                  : `Cards (${selectedCardIds.length}/4)`}
              </span>
              {cardPickerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleAutoMark}
                className={`px-3 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 border min-h-[40px] ${
                  autoMark
                    ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300'
                    : 'bg-[#14223b] border-slate-700 text-slate-300'
                }`}
              >
                {autoMark ? <CheckSquare size={14} /> : <Square size={14} />}
                {lang === 'am' ? 'አውቶ ምልክት' : 'Auto-Mark'}
              </button>

              <button
                type="button"
                onClick={onClaimBingo}
                disabled={playerCards.length === 0}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold flex items-center gap-1.5 shadow-[0_6px_18px_rgba(250,204,21,0.28)] hover:brightness-105 active:scale-95 transition-all disabled:opacity-45 min-h-[40px]"
              >
                <Award size={15} />
                BINGO!
              </button>
            </div>
          </div>

          {/* Collapsible All-Cards Picker (1–600, locked once 60s ends and round goes live) */}
          {!isCardsLocked && (cardPickerOpen || playerCards.length === 0) && (
            <div className="rounded-xl bg-[#091221] border border-slate-800 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-bold text-slate-300">
                  {lang === 'am'
                    ? `ሁሉም ካርዶች 1–600 · እስከ 4 ይምረጡ (${cardPrice} ETB)`
                    : `All Cards 1–600 · Pick up to 4 (${cardPrice} ETB)`}
                </span>
                <div className="relative w-36 sm:w-44">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    type="search"
                    value={cardSearch}
                    onChange={(e) => setCardSearch(e.target.value)}
                    placeholder={lang === 'am' ? 'ቁጥር ፈልግ...' : 'Search card...'}
                    aria-label="Search card number"
                    className="w-full pl-7 pr-2.5 py-1.5 rounded-lg bg-[#0f1a2e] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-6 sm:grid-cols-10 gap-1.5 max-h-[260px] overflow-y-auto p-0.5">
                {visibleCardIds.map((cid) => {
                  const isSelected = selectedCardIds.includes(cid);
                  const isTaken = activeRoom.takenCardIds.includes(cid);
                  return (
                    <button
                      key={cid}
                      type="button"
                      disabled={isTaken}
                      onClick={() => onToggleCardId(cid)}
                      className={`h-9 rounded-lg font-['Outfit'] text-xs font-bold tabular-nums transition-all ${
                        isSelected
                          ? 'bg-[#22d3ee] text-[#041423] ring-2 ring-[#facc15]'
                          : isTaken
                            ? 'bg-slate-800/70 text-slate-600 line-through cursor-not-allowed'
                            : 'bg-[#14223b] text-slate-200 border border-slate-700 hover:border-cyan-400'
                      }`}
                    >
                      {cid}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isCardsLocked && cardPickerOpen && (
            <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 px-3.5 py-2.5 text-xs font-bold text-amber-200">
              {activeRoom.status === 'completed'
                ? lang === 'am'
                  ? 'ዙሩ ተጠናቋል — አዲስ የ60 ሰከንድ ካርድ መምረጫ በቅርቡ ይከፈታል።'
                  : 'Round finished — next 60s card selection opens shortly.'
                : lang === 'am'
                  ? '60 ሰከንዱ አልቋል — ጨዋታው እስኪያልቅ ድረስ ካርድ መምረጥ ወይም መቀየር አይቻልም።'
                  : '60s timer ended — cards are locked until this round finishes.'}
            </div>
          )}

          {/* Active Player Cards Grid */}
          {playerCards.length === 0 ? (
            <div className="py-10 px-4 text-center rounded-xl bg-[#091221] border border-dashed border-slate-700">
              <p className="text-xs font-bold text-slate-300">
                {isCardsLocked
                  ? lang === 'am'
                    ? 'ጨዋታው በመካሄድ ላይ ነው። ይህ ዙር ሲያልቅ አዲስ ካርድ መምረጥ ይችላሉ።'
                    : 'Round is live — you can pick cards as soon as this round finishes and the next 60s timer starts.'
                  : lang === 'am'
                    ? 'ለመጀመር ከላይ አንድ ካርድ ይንኩ።'
                    : 'Tap any card number above to start playing.'}
              </p>
              {!isCardsLocked && (
                <button
                  type="button"
                  onClick={onAddQuickCard}
                  className="mt-3 px-4 py-2.5 rounded-xl bg-[#22d3ee] text-[#041423] text-xs font-extrabold inline-flex items-center gap-1.5 min-h-[44px]"
                >
                  <Plus size={14} />
                  {lang === 'am' ? 'ፈጣን ካርድ ምረጥ' : 'Quick Pick a Card'}
                </button>
              )}
            </div>
          ) : (
            <div
              className={`grid gap-1.5 mx-auto ${
                playerCards.length === 1
                  ? 'grid-cols-1 max-w-[180px]'
                  : 'grid-cols-2 max-w-[360px]'
              }`}
            >
              {playerCards.map((card) => (
                <BingoCardView
                  key={card.id}
                  card={card}
                  calledNumbers={calledNumbers}
                  markedNumbers={markedNumbers}
                  onToggleCell={onToggleMarkCell}
                  compact
                  lang={lang}
                  onRemoveCard={isCardsLocked ? undefined : onRemoveCard}
                />
              ))}
            </div>
          )}

          {/* Compact Legend */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800 text-[11px] text-slate-400">
            <div className="flex items-center gap-3">
              <span>
                <b className="inline-block w-2 h-2 rounded-full bg-cyan-400 mr-1" />
                {lang === 'am' ? 'ምልክት የተደረገ' : 'Marked'}
              </span>
              <span>
                <b className="inline-block w-2 h-2 rounded-full bg-[#facc15] mr-1" />
                {lang === 'am' ? '★ ነፃ' : '★ Free'}
              </span>
            </div>
            <span>
              {lang === 'am'
                ? 'መስመር ሲሞላ BINGO! ይጫኑ።'
                : 'Complete a line or 4 corners and tap BINGO!'}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
