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
import { BingoNumberTile, GameStatusBadge, PrimaryButton } from './DesignSystem';

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
    <div className="space-y-2.5">
      {/* Top Room Status & Prize Bar */}
      <section className="rounded-xl bg-white border border-[#E7EDE8] px-3 py-2 space-y-1.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex flex-wrap items-center gap-1.5">
            <GameStatusBadge
              status={
                activeRoom.status === 'live'
                  ? 'live'
                  : activeRoom.status === 'completed'
                  ? 'completed'
                  : 'open'
              }
              label={statusText}
              pulse={activeRoom.status === 'live' || activeRoom.status === 'countdown'}
            />
            <span className="text-[11px] font-extrabold text-[#183326] truncate">
              {lang === 'am' ? activeRoom.nameAm : activeRoom.nameEn}
            </span>
            <span className="text-[11px] font-bold text-[#68776D] tabular-nums">
              · {cardPrice} ETB/{lang === 'am' ? 'ካርድ' : 'card'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 text-[11px]">
            <div className="flex items-center gap-1 bg-[#FEF5DC] border border-[#F5BD42] px-2 py-1 rounded-lg">
              <Trophy size={12} className="text-[#D99B20]" />
              <span className="text-[#9A6B0B] font-bold hidden sm:inline">
                {copy.prizePoolLabel}:
              </span>
              <b
                data-testid="live-prize-pool"
                className="font-['Outfit'] font-extrabold text-[#183326] tabular-nums"
              >
                {prizeSummary.winnerPrizeDemo} ETB
              </b>
            </div>

            <div
              className={`flex items-center gap-1 px-2 py-1 rounded-lg border ${
                activeRoom.status === 'live'
                  ? 'bg-[#E6F6EB] border-[#159447]/40 text-[#08743A]'
                  : activeRoom.status === 'completed'
                  ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#9A6B0B]'
                  : countdown > 0 && countdown <= 10
                  ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#9A6B0B]'
                  : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#183326]'
              }`}
            >
              <Clock
                size={13}
                className={
                  activeRoom.status === 'live'
                    ? 'text-[#159447]'
                    : countdown > 0 && countdown <= 10
                    ? 'text-[#D99B20] animate-pulse'
                    : 'text-[#159447]'
                }
              />
              <b
                data-testid="live-countdown"
                className="font-mono text-xs sm:text-sm font-extrabold tabular-nums"
              >
                {activeRoom.status === 'countdown'
                  ? `00:${String(Math.max(0, countdown)).padStart(2, '0')}`
                  : activeRoom.status === 'live'
                  ? `LIVE · ${calledNumbers.length}/75`
                  : '00:05'}
              </b>
            </div>

            <div className="flex items-center gap-1 bg-[#FFF9ED] border border-[#E7EDE8] px-2 py-1 rounded-lg">
              <Users size={12} className="text-[#159447]" />
              <b className="font-['Outfit'] font-extrabold text-[#183326] tabular-nums">
                {activeRoom.activePlayers}
              </b>
            </div>
          </div>
        </div>

        {activeRoom.status === 'countdown' && (
          <div className="w-full h-1.5 rounded-full bg-[#FFF9ED] border border-[#E7EDE8] overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                countdown <= 10
                  ? 'bg-[#F5BD42]'
                  : 'bg-gradient-to-r from-[#159447] to-[#F5BD42]'
              }`}
              style={{ width: `${Math.max(0, Math.min(100, Math.round((countdown / 60) * 100)))}%` }}
            />
          </div>
        )}
      </section>

      {/* Main Play Table: Ball Caller + Player Card(s) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-start">
        {/* Left 5 Columns: Clean Ball Stage & Call Action */}
        <section className="lg:col-span-5 rounded-xl bg-white border border-[#E7EDE8] p-2.5 sm:p-3 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-extrabold text-[#159447] uppercase tracking-wider">
              {copy.liveCallerTitle}
            </span>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onToggleVoice}
                aria-label={voiceEnabled ? 'Mute Amharic voice' : 'Enable Amharic voice'}
                data-testid="voice-toggle"
                className={`px-2 py-1 rounded-lg text-[11px] font-extrabold flex items-center gap-1 transition-colors min-h-[32px] border ${
                  voiceEnabled
                    ? 'bg-[#E6F6EB] border-[#159447]/40 text-[#08743A]'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#68776D]'
                }`}
              >
                {voiceEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
                {lang === 'am' ? 'ድምፅ' : 'Voice'}
              </button>

              <button
                type="button"
                onClick={onToggleAutoCaller}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold flex items-center gap-1 transition-colors min-h-[32px] border ${
                  autoCallerActive
                    ? 'bg-[#159447] border-[#08743A] text-white shadow-xs'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#183326]'
                }`}
              >
                {autoCallerActive ? <Pause size={12} /> : <Play size={12} />}
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
                  className="px-2 py-1 rounded-lg bg-[#FEF5DC] border border-[#F5BD42] text-[10px] font-mono font-extrabold text-[#183326] min-h-[32px]"
                >
                  {callerIntervalSec}s
                </button>
              )}
            </div>
          </div>

          {/* 3D Ball Stage (Fixed ultra-compact height — zero layout jump when numbers are called) */}
          <div className="h-[80px] sm:h-[88px] px-3 rounded-xl bg-gradient-to-br from-[#FFF9ED] via-white to-[#E6F6EB]/65 border border-[#E7EDE8] flex items-center justify-center gap-3 overflow-hidden shadow-inner">
            <div className="w-16 h-16 shrink-0 flex items-center justify-center">
              {latestBall ? (
                <BingoBall3D
                  number={latestBall}
                  size="lg"
                  animateEntry
                  reducedMotion={reducedMotion}
                  isRecentHighlight
                />
              ) : (
                <div className="w-16 h-16 shrink-0 rounded-full border-2 border-dashed border-[#159447]/40 bg-white flex items-center justify-center text-[#159447] font-['Outfit'] text-lg font-extrabold shadow-xs">
                  --
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1 max-w-[220px]">
              <span className="text-[10px] font-bold text-[#68776D] block truncate uppercase tracking-wider">
                {copy.numberCalledLabel}
              </span>
              <div className="flex items-center gap-1.5 min-h-[28px]">
                <b
                  data-testid="live-latest-ball"
                  className="font-['Outfit'] text-xl sm:text-2xl font-extrabold text-[#183326] tabular-nums block leading-none truncate"
                >
                  {latestBall ? formatBallCall(latestBall) : '--'}
                </b>
                {latestBall && (
                  <button
                    type="button"
                    onClick={() => onSpeakBall(latestBall)}
                    aria-label={lang === 'am' ? 'ቁጥሩን በአማርኛ ድገም' : 'Speak called number'}
                    className="p-1.5 rounded-lg bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] hover:bg-[#159447] hover:text-white transition-colors shrink-0"
                  >
                    <Volume2 size={12} />
                  </button>
                )}
              </div>
              <p className="text-[11px] text-[#159447] font-extrabold mt-0.5 tabular-nums truncate">
                {latestBall
                  ? `${getBingoVoiceCallScript(latestBall, lang).displayPhrase} · ${calledNumbers.length}/75`
                  : copy.waitingFirstBall}
              </p>
            </div>
          </div>

          {/* Recent Calls + 1-75 Board Toggle */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-[#68776D]">{copy.recentCallsLabel}</span>
              <button
                type="button"
                onClick={() => setShowMasterBoard((v) => !v)}
                className="text-[#159447] font-extrabold hover:underline flex items-center gap-1"
              >
                <Grid size={12} />
                {showMasterBoard
                  ? lang === 'am'
                    ? '1–75 ደብቅ'
                    : 'Hide 1–75'
                  : lang === 'am'
                  ? '1–75 ሰሌዳ'
                  : '1–75 Board'}
              </button>
            </div>

            <div className="h-[28px] flex items-center overflow-x-auto no-scrollbar">
              {recentBalls.length === 0 ? (
                <p className="text-[11px] text-[#68776D]">
                  {lang === 'am' ? 'እስካሁን የተጠራ ቁጥር የለም።' : 'No numbers called yet.'}
                </p>
              ) : (
                <div className="flex gap-1 items-center flex-nowrap">
                  {recentBalls.map((n, idx) => (
                    <span
                      key={n}
                      className={`px-2 py-0.5 rounded-lg font-['Outfit'] text-[11px] font-extrabold tabular-nums shrink-0 border ${
                        idx === 0
                          ? 'bg-[#F5BD42] border-[#D99B20] text-[#183326] shadow-2xs'
                          : 'bg-[#E6F6EB] border-[#159447]/30 text-[#08743A]'
                      }`}
                    >
                      {formatBallCall(n)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {showMasterBoard && (
            <div className="bg-[#FFF9ED] border border-[#E7EDE8] rounded-xl p-2 overflow-x-auto no-scrollbar">
              <div className="space-y-1 min-w-[330px] sm:min-w-0">
                {BINGO_COLUMNS.map((col, idx) => (
                  <div key={col.letter} className="flex items-center gap-1">
                    <b
                      className={`w-5 h-5 rounded-md text-[10px] font-extrabold flex items-center justify-center shrink-0 ${
                        idx === 2
                          ? 'bg-[#F5BD42] text-[#183326]'
                          : 'bg-[#159447] text-white'
                      }`}
                    >
                      {col.letter}
                    </b>
                    <div className="grid grid-cols-15 gap-0.5 flex-1">
                      {Array.from({ length: 15 }, (_, i) => col.min + i).map((num) => {
                        const isCalled = calledNumbers.includes(num);
                        return (
                          <span
                            key={num}
                            className={`h-5 rounded text-[9px] font-mono font-bold flex items-center justify-center tabular-nums border ${
                              num === latestBall
                                ? 'bg-[#F5BD42] border-[#D99B20] text-[#183326] font-extrabold'
                                : isCalled
                                ? 'bg-[#159447] border-[#08743A] text-white font-extrabold'
                                : 'bg-white border-[#E7EDE8] text-[#68776D]'
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
            </div>
          )}

          {/* Automatic Calling Status + Quiet Reset */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#E7EDE8]">
            <span className="text-[10.5px] font-bold text-[#68776D]">
              {lang === 'am' ? 'ቁጥሮች በራስ-ሰር ይጠራሉ' : 'Numbers call automatically'}
            </span>

            <button
              type="button"
              onClick={onResetRound}
              aria-label={copy.resetDemoBtn}
              title={copy.resetDemoBtn}
              className="p-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[#68776D] hover:text-[#159447] hover:bg-[#E6F6EB] min-h-[32px] min-w-[32px] flex items-center justify-center transition-colors"
            >
              <RotateCcw size={13} />
            </button>
          </div>
        </section>

        {/* Right 7 Columns: Progressive Card Picker + Player Cards & BINGO CTA */}
        <section className="lg:col-span-7 rounded-xl bg-white border border-[#E7EDE8] p-2.5 sm:p-3 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
          {/* Card Controls Header (Mobile-First) */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <button
              type="button"
              onClick={() => setCardPickerOpen((o) => !o)}
              className="px-2.5 py-1.5 rounded-lg bg-[#E6F6EB] border border-[#159447]/35 text-[11px] font-extrabold text-[#08743A] flex items-center gap-1 min-h-[34px]"
            >
              <span>
                {lang === 'am'
                  ? `ካርዶች (${selectedCardIds.length}/4)`
                  : `Cards (${selectedCardIds.length}/4)`}
              </span>
              {cardPickerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            <div className="flex items-center gap-1.5 flex-1 sm:flex-initial justify-end">
              <button
                type="button"
                onClick={onToggleAutoMark}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold flex items-center gap-1 border min-h-[34px] whitespace-nowrap transition-colors ${
                  autoMark
                    ? 'bg-[#E6F6EB] border-[#159447]/40 text-[#08743A]'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#68776D]'
                }`}
              >
                {autoMark ? <CheckSquare size={13} className="text-[#159447]" /> : <Square size={13} />}
                {lang === 'am' ? 'አውቶ ምልክት' : 'Auto-Mark'}
              </button>

              <button
                type="button"
                onClick={onClaimBingo}
                disabled={playerCards.length === 0}
                className="flex-1 sm:flex-initial px-4 py-1.5 rounded-lg bg-gradient-to-r from-[#F5BD42] to-[#D99B20] text-[#183326] border border-[#D99B20] text-xs font-extrabold flex items-center justify-center gap-1 shadow-[0_3px_10px_rgba(245,189,66,0.3)] hover:brightness-105 active:scale-95 transition-all disabled:opacity-45 min-h-[34px] whitespace-nowrap"
              >
                <Award size={13} />
                BINGO!
              </button>
            </div>
          </div>

          {/* Collapsible All-Cards Picker (1–600, Warm Cream + Rounded White & Emerald Tiles) */}
          {!isCardsLocked && (cardPickerOpen || playerCards.length === 0) && (
            <div className="rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] p-2 sm:p-2.5 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-[11px]">
                <span className="font-extrabold text-[#159447]">
                  {lang === 'am'
                    ? `ሁሉም ካርዶች 1–600 · እስከ 4 ይምረጡ (${cardPrice} ETB)`
                    : `Select Bingo Cards 1–600 · Pick up to 4 (${cardPrice} ETB)`}
                </span>
                <div className="relative w-full sm:w-44">
                  <Search
                    size={12}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#68776D]"
                  />
                  <input
                    type="search"
                    value={cardSearch}
                    onChange={(e) => setCardSearch(e.target.value)}
                    placeholder={lang === 'am' ? 'ቁጥር ፈልግ...' : 'Search card...'}
                    aria-label="Search card number"
                    className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-white border border-[#E7EDE8] text-xs font-bold text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447] min-h-[32px]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-6 sm:grid-cols-10 gap-1.5 max-h-[195px] sm:max-h-[220px] overflow-y-auto overscroll-contain p-0.5">
                {visibleCardIds.map((cid) => {
                  const isSelected = selectedCardIds.includes(cid);
                  const isTaken = activeRoom.takenCardIds.includes(cid);
                  const isSpecialGold = cid % 25 === 0 || cid === 1 || cid === 77;
                  return (
                    <BingoNumberTile
                      key={cid}
                      cardNumber={cid}
                      isSelected={isSelected}
                      isTakenByOther={isTaken}
                      isSpecialGold={isSpecialGold}
                      onSelect={onToggleCardId}
                      size="sm"
                    />
                  );
                })}
              </div>
            </div>
          )}

          {isCardsLocked && cardPickerOpen && (
            <div className="rounded-lg bg-[#FEF5DC] border border-[#F5BD42] px-2.5 py-2 text-[11px] font-bold text-[#183326]">
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
            <div className="py-5 px-3 text-center rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/35 space-y-2">
              <p className="text-xs font-extrabold text-[#183326]">
                {isCardsLocked
                  ? lang === 'am'
                    ? 'ካርድ ስላልመረጡ በዚህ ዙር መጫወት አይችሉም። ይህ ዙር ሲያልቅ አዲስ ካርድ ይምረጡ።'
                    : 'You cannot play this round without a selected card. Pick a card when the next 60s timer starts.'
                  : lang === 'am'
                  ? 'ለመጀመር ከላይ አንድ ነጭ የካርድ ቁጥር ይምረጡ (10 ብር)።'
                  : 'Tap any white card number above to join this Bingo round (10 ETB).'}
              </p>
              <p className="text-[10.5px] font-semibold text-[#68776D]">
                {lang === 'am'
                  ? 'ሲቀላቀሉ 15 ብር ቦነስ ያገኛሉ · ጓደኛ ሲጋብዙ +20 ብር ቦነስ ያገኛሉ!'
                  : '15 Birr Welcome Join Bonus · +20 Birr Bonus per Invited Friend!'}
              </p>
              {!isCardsLocked && (
                <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
                  <PrimaryButton
                    variant="emerald"
                    size="sm"
                    onClick={onAddQuickCard}
                    icon={<Plus size={13} />}
                  >
                    {lang === 'am' ? 'ፈጣን ካርድ ምረጥ (10 ብር)' : 'Quick Pick a Card (10 ETB)'}
                  </PrimaryButton>
                </div>
              )}
            </div>
          ) : (
            <div
              className={`grid gap-2 mx-auto w-full ${
                playerCards.length === 1
                  ? 'grid-cols-1 max-w-[195px]'
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
          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-2 border-t border-[#E7EDE8] text-[10.5px] font-semibold text-[#68776D]">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1 text-[#08743A]">
                <b className="inline-block w-2 h-2 rounded-full bg-[#159447]" />
                {lang === 'am' ? 'ምልክት የተደረገ' : 'Marked'}
              </span>
              <span className="inline-flex items-center gap-1 text-[#9A6B0B]">
                <b className="inline-block w-2 h-2 rounded-full bg-[#F5BD42]" />
                {lang === 'am' ? '★ ነፃ / አሸናፊ' : '★ Free / Win'}
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
