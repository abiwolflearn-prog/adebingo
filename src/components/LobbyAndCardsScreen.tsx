import { useState } from 'react';
import {
  Clock,
  Search,
  Shuffle,
  CheckCircle2,
  Play,
  ArrowLeft,
  Sparkles,
  Trophy,
  Gift,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  calculateDemoPrizePool,
  generateDeterministicCard,
} from '../game/rules';
import { FirestoreRoomPlayer } from '../services/firestoreService';
import { Language, RoomConfig, ScreenId } from '../types/bingo';
import { BingoCardView } from './BingoCardView';
import {
  BingoNumberTile,
  EmptyState,
  GameStatusBadge,
  PrimaryButton,
  SecondaryButton,
} from './DesignSystem';

interface LobbyAndCardsScreenProps {
  mode: 'lobby' | 'cards';
  lang: Language;
  activeRoom: RoomConfig;
  roomPlayers?: FirestoreRoomPlayer[];
  selectedCardIds: number[];
  onToggleCardId: (cardId: number) => void;
  onQuickPickCards: (count: number) => void;
  onClearSelectedCards: () => void;
  countdown: number;
  cardPrice: number;
  demoBalance: number;
  onEnterLiveGame: () => void;
  onNavigate: (screen: ScreenId) => void;
}

const DECK_RANGES = [
  { label: '1–100', start: 1, end: 100 },
  { label: '101–200', start: 101, end: 200 },
  { label: '201–300', start: 201, end: 300 },
  { label: '301–400', start: 301, end: 400 },
  { label: '401–500', start: 401, end: 500 },
  { label: '501–600', start: 501, end: 600 },
];

export function LobbyAndCardsScreen({
  lang,
  activeRoom,
  selectedCardIds,
  onToggleCardId,
  onQuickPickCards,
  onClearSelectedCards,
  countdown,
  cardPrice,
  demoBalance,
  onEnterLiveGame,
  onNavigate,
}: LobbyAndCardsScreenProps) {
  const [rangeIndex, setRangeIndex] = useState<number | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'available' | 'mine'>('all');

  const isCardsLocked = activeRoom.status === 'live' || activeRoom.status === 'completed';
  const currentRange =
    rangeIndex === 'all'
      ? { start: 1, end: DEFAULT_GAME_RULES.maxCardsPerRoom }
      : DECK_RANGES[rangeIndex];
  const totalCardsInPlay = activeRoom.takenCardIds.length + selectedCardIds.length;
  const prizeSummary = calculateDemoPrizePool(totalCardsInPlay, cardPrice);
  const entryCost = selectedCardIds.length * cardPrice;

  const candidateNumbers: number[] = [];
  if (searchQuery.trim() !== '') {
    const q = searchQuery.trim();
    for (let id = 1; id <= DEFAULT_GAME_RULES.maxCardsPerRoom; id++) {
      if (String(id).includes(q)) {
        candidateNumbers.push(id);
      }
    }
  } else if (filterMode === 'mine') {
    candidateNumbers.push(...selectedCardIds);
  } else {
    for (let id = currentRange.start; id <= currentRange.end; id++) {
      if (filterMode === 'available' && activeRoom.takenCardIds.includes(id)) {
        continue;
      }
      candidateNumbers.push(id);
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Game Info & Card Selection Header Card */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#E7EDE8] rounded-2xl p-3.5 sm:p-4 shadow-[0_6px_20px_rgba(24,51,38,0.06)]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB] hover:border-[#159447]/40 min-h-[42px] min-w-[42px] flex items-center justify-center transition-colors"
            aria-label="Back to Home"
          >
            <ArrowLeft size={18} className="text-[#159447]" />
          </button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-['Outfit'] text-base sm:text-xl font-extrabold text-[#159447]">
                {lang === 'am' ? 'ካርድ ይምረጡ (1–600)' : 'Select Your Bingo Cards (1–600)'}
              </h2>
              <GameStatusBadge
                status={isCardsLocked ? 'live' : 'open'}
                label={
                  isCardsLocked
                    ? lang === 'am'
                      ? 'ቀጥታ ዙር'
                      : 'Live Round'
                    : lang === 'am'
                    ? 'ክፍት ምርጫ'
                    : 'Selection Open'
                }
                pulse={!isCardsLocked}
              />
            </div>
            <p className="text-xs text-[#68776D] font-semibold tabular-nums mt-0.5">
              <b className="text-[#159447]">{selectedCardIds.length}/4</b>{' '}
              {lang === 'am' ? 'ካርድ ተመርጧል' : 'cards selected'} · {cardPrice} ETB/
              {lang === 'am' ? 'ካርድ' : 'card'} ·{' '}
              <span className="text-[#9A6B0B] font-bold">
                {lang === 'am' ? 'ሽልማት' : 'Prize'} {prizeSummary.winnerPrizeDemo} ETB
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-xs ${
              isCardsLocked
                ? 'bg-[#FFF5F5] border-[#D94B4B]/40 text-[#D94B4B]'
                : countdown > 0 && countdown <= 10
                ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#9A6B0B]'
                : 'bg-[#E6F6EB] border-[#159447]/30 text-[#08743A]'
            }`}
          >
            <Clock
              size={15}
              className={
                isCardsLocked
                  ? 'text-[#D94B4B]'
                  : countdown > 0 && countdown <= 10
                  ? 'text-[#D99B20]'
                  : 'text-[#159447]'
              }
            />
            <b
              data-testid="lobby-countdown"
              className="font-mono text-sm font-extrabold tabular-nums"
            >
              {activeRoom.status === 'countdown'
                ? `00:${String(Math.max(0, countdown)).padStart(2, '0')}`
                : activeRoom.status === 'live'
                ? 'LIVE'
                : '00:05'}
            </b>
          </div>

          <PrimaryButton
            data-start="true"
            variant="emerald"
            size="sm"
            onClick={onEnterLiveGame}
            icon={<Play size={15} />}
          >
            {lang === 'am' ? 'ጨዋታ ጀምር' : 'Play Bingo'}
          </PrimaryButton>
        </div>
      </div>

      {/* Game Info Strip */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="rounded-2xl bg-white border border-[#E7EDE8] p-3 flex items-center justify-between shadow-2xs">
          <div>
            <span className="text-[11px] font-bold text-[#68776D] block">
              {lang === 'am' ? 'የተመረጡ ካርዶች' : 'Selected Cards'}
            </span>
            <b className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#159447] tabular-nums">
              {selectedCardIds.length} / 4
            </b>
          </div>
          <span className="w-8 h-8 rounded-xl bg-[#E6F6EB] text-[#159447] font-extrabold text-xs flex items-center justify-center">
            #{selectedCardIds[0] || '-'}
          </span>
        </div>

        <div className="rounded-2xl bg-[#FEF5DC]/75 border border-[#F5BD42]/60 p-3 flex items-center justify-between shadow-2xs">
          <div>
            <span className="text-[11px] font-bold text-[#9A6B0B] block">
              {lang === 'am' ? 'የዙር ሽልማት' : 'Round Prize'}
            </span>
            <b className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326] tabular-nums">
              {prizeSummary.winnerPrizeDemo} ETB
            </b>
          </div>
          <div className="w-8 h-8 rounded-xl bg-[#F5BD42] text-[#183326] flex items-center justify-center">
            <Trophy size={15} />
          </div>
        </div>

        <div className="rounded-2xl bg-white border border-[#E7EDE8] p-3 flex items-center justify-between shadow-2xs">
          <div>
            <span className="text-[11px] font-bold text-[#68776D] block">
              {lang === 'am' ? 'ቀሪ ሂሳብ' : 'Your Balance'}
            </span>
            <b className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326] tabular-nums">
              {demoBalance.toFixed(0)} ETB
            </b>
          </div>
          <span className="text-[10px] font-extrabold bg-[#E6F6EB] text-[#08743A] px-2 py-0.5 rounded-md">
            {entryCost} ETB
          </span>
        </div>
      </div>

      {/* Locked Round Banner after 60s */}
      {isCardsLocked && (
        <div
          role="status"
          className="rounded-2xl bg-[#FEF5DC] border border-[#F5BD42] px-4 py-3 text-xs font-extrabold text-[#183326] flex items-center justify-between gap-3 shadow-xs"
        >
          <span>
            {activeRoom.status === 'completed'
              ? lang === 'am'
                ? 'ዙሩ ተጠናቋል — አዲስ የ60 ሰከንድ ዙር በጥቂት ሰከንዶች ውስጥ ይጀምራል...'
                : 'Round finished — starting a new 60s card selection round shortly...'
              : lang === 'am'
              ? 'ጨዋታው ተጀምሯል — ዙሩ እስኪያልቅ ድረስ ካርድ መምረጥ ወይም መቀየር አይቻልም።'
              : 'Round is live — cards are locked until this game finishes.'}
          </span>
          <PrimaryButton variant="gold" size="sm" onClick={onEnterLiveGame}>
            {lang === 'am' ? 'ጨዋታውን ይመልከቱ' : 'Watch Live'}
          </PrimaryButton>
        </div>
      )}

      {/* Main Split: Card Number Deck + Selected Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <section className="lg:col-span-7 bg-white border border-[#E7EDE8] rounded-2xl p-4 space-y-3.5 shadow-[0_8px_24px_rgba(24,51,38,0.06)]">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#68776D]"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={lang === 'am' ? 'ካርድ ፈልግ (1–600)...' : 'Search card (1–600)...'}
                aria-label="Search card number between 1 and 600"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447] focus:bg-white transition-colors min-h-[42px]"
              />
            </div>

            <SecondaryButton
              size="sm"
              disabled={isCardsLocked}
              onClick={() => onQuickPickCards(Math.min(4, Math.max(1, selectedCardIds.length + 1)))}
              icon={<Shuffle size={14} className="text-[#159447]" />}
              className="!border-[#F5BD42] !bg-[#FEF5DC]/70 hover:!bg-[#FEF5DC] !text-[#183326]"
            >
              {lang === 'am' ? 'በዘፈቀደ ምረጥ' : 'Lucky Pick'}
            </SecondaryButton>

            <div className="flex items-center gap-1 bg-[#FFF9ED] border border-[#E7EDE8] p-1 rounded-xl">
              {(
                [
                  { id: 'all', am: 'ሁሉም', en: 'All' },
                  { id: 'available', am: 'ክፍት', en: 'Open' },
                  {
                    id: 'mine',
                    am: `የእኔ (${selectedCardIds.length})`,
                    en: `Mine (${selectedCardIds.length})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setFilterMode(tab.id);
                    setSearchQuery('');
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-extrabold transition-colors ${
                    filterMode === tab.id
                      ? 'bg-[#159447] text-white shadow-2xs'
                      : 'text-[#68776D] hover:text-[#183326]'
                  }`}
                >
                  {lang === 'am' ? tab.am : tab.en}
                </button>
              ))}
            </div>
          </div>

          {searchQuery.trim() === '' && filterMode !== 'mine' && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setRangeIndex('all')}
                className={`py-2 px-3 rounded-xl text-xs font-extrabold tabular-nums transition-all border ${
                  rangeIndex === 'all'
                    ? 'bg-[#159447] text-white border-[#08743A] shadow-2xs'
                    : 'bg-[#FFF9ED] text-[#183326] border-[#E7EDE8] hover:bg-[#E6F6EB]'
                }`}
              >
                {lang === 'am' ? 'ሁሉም (1–600)' : 'All (1–600)'}
              </button>
              {DECK_RANGES.map((r, idx) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => setRangeIndex(idx)}
                  className={`py-2 px-2.5 rounded-xl text-xs font-extrabold tabular-nums transition-all border ${
                    rangeIndex === idx
                      ? 'bg-[#159447] text-white border-[#08743A] shadow-2xs'
                      : 'bg-[#FFF9ED] text-[#183326] border-[#E7EDE8] hover:bg-[#E6F6EB]'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* Warm Cream Tray with Rounded White & Emerald Number Tiles */}
          <div className="rounded-2xl bg-[#FFF9ED] border border-[#E7EDE8] p-2.5 sm:p-3">
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 max-h-[420px] overflow-y-auto p-0.5">
              {candidateNumbers.length === 0 ? (
                <div className="col-span-full py-6">
                  <EmptyState
                    title={lang === 'am' ? 'ምንም ካርድ አልተገኘም' : 'No matching cards'}
                    description={
                      lang === 'am'
                        ? 'ሌላ ቁጥር ይፈልጉ ወይም በዘፈቀደ ይምረጡ።'
                        : 'Try another card number or tap Lucky Pick.'
                    }
                  />
                </div>
              ) : (
                candidateNumbers.map((cardNum) => {
                  const isSelected = selectedCardIds.includes(cardNum);
                  const isTaken = activeRoom.takenCardIds.includes(cardNum);
                  const isSpecialGold = cardNum % 25 === 0 || cardNum === 1 || cardNum === 77;

                  return (
                    <BingoNumberTile
                      key={cardNum}
                      cardNumber={cardNum}
                      isSelected={isSelected}
                      isTakenByOther={isTaken}
                      isSpecialGold={isSpecialGold}
                      disabled={isCardsLocked}
                      onSelect={onToggleCardId}
                      size="sm"
                    />
                  );
                })
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
            <div className="flex items-center gap-3 text-[11px] font-bold text-[#68776D]">
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded bg-white border border-[#E7EDE8] inline-block" />
                {lang === 'am' ? 'ክፍት' : 'Available'}
              </span>
              <span className="inline-flex items-center gap-1 text-[#08743A]">
                <span className="w-3 h-3 rounded bg-[#159447] inline-block" />
                {lang === 'am' ? 'የተመረጠ' : 'Selected'}
              </span>
              <span className="inline-flex items-center gap-1 text-[#9A6B0B]">
                <span className="w-3 h-3 rounded bg-[#FEF5DC] border border-[#F5BD42] inline-block" />
                {lang === 'am' ? 'ልዩ ቁጥር' : 'Lucky Gold'}
              </span>
            </div>

            {selectedCardIds.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[#68776D] font-semibold">
                  {lang === 'am' ? 'የተመረጡ፦' : 'Selected:'}{' '}
                  <b className="text-[#159447]">#{selectedCardIds.join(', #')}</b>
                </span>
                {!isCardsLocked && (
                  <button
                    type="button"
                    onClick={onClearSelectedCards}
                    className="font-extrabold text-[#D94B4B] hover:underline"
                  >
                    {lang === 'am' ? 'አጽዳ' : 'Clear'}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Right Preview & Confirmation Column */}
        <section className="lg:col-span-5 bg-white border border-[#E7EDE8] rounded-2xl p-4 space-y-4 shadow-[0_8px_24px_rgba(24,51,38,0.06)]">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
                {lang === 'am'
                  ? `የእርስዎ ካርዶች (${selectedCardIds.length}/4)`
                  : `Your Selected Cards (${selectedCardIds.length}/4)`}
              </h3>
              <p className="text-[11px] text-[#68776D]">
                {lang === 'am'
                  ? 'እስከ 4 ካርዶችን በአንድ ዙር መጫወት ይችላሉ'
                  : 'Play up to 4 Bingo cards simultaneously'}
              </p>
            </div>
            <span className="text-xs font-['Outfit'] font-extrabold bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] px-2.5 py-1 rounded-xl tabular-nums">
              {entryCost} ETB
            </span>
          </div>

          {selectedCardIds.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="w-6 h-6" />}
              title={
                lang === 'am'
                  ? 'ከ1–600 እስከ 4 ካርዶችን ይምረጡ'
                  : 'Pick 1 to 4 Cards from 1–600'
              }
              description={
                lang === 'am'
                  ? 'ማንኛውንም ነጭ የካርድ ቁጥር ይንኩ ወይም በዘፈቀደ ይምረጡ።'
                  : 'Tap any white number tile on the board or use Lucky Pick to get started.'
              }
              action={
                <PrimaryButton
                  variant="gold"
                  size="sm"
                  disabled={isCardsLocked}
                  onClick={() => onQuickPickCards(1)}
                  icon={<Shuffle size={14} />}
                >
                  {lang === 'am' ? '1 ካርድ በዘፈቀደ ምረጥ' : 'Quick Pick 1 Card'}
                </PrimaryButton>
              }
            />
          ) : (
            <div
              className={`grid gap-2 mx-auto ${
                selectedCardIds.length === 1
                  ? 'grid-cols-1 max-w-[200px]'
                  : 'grid-cols-2 max-w-[340px]'
              }`}
            >
              {selectedCardIds.map((id) => {
                const card = generateDeterministicCard(id);
                return (
                  <BingoCardView
                    key={id}
                    card={card}
                    calledNumbers={[]}
                    markedNumbers={[]}
                    compact
                    lang={lang}
                    onRemoveCard={isCardsLocked ? undefined : (cid) => onToggleCardId(cid)}
                  />
                );
              })}
            </div>
          )}

          <PrimaryButton
            variant={selectedCardIds.length > 0 ? 'emerald' : 'gold'}
            size="lg"
            fullWidth
            onClick={onEnterLiveGame}
            icon={<CheckCircle2 size={18} />}
          >
            {selectedCardIds.length > 0
              ? lang === 'am'
                ? `በ ${selectedCardIds.length} ካርድ ጨዋታ ጀምር (${entryCost} ETB)`
                : `Confirm & Play Bingo (${selectedCardIds.length} card${
                    selectedCardIds.length === 1 ? '' : 's'
                  } · ${entryCost} ETB)`
              : lang === 'am'
              ? 'ቢያንስ 1 ካርድ ይምረጡና ይቀጥሉ'
              : 'Select at least 1 card to continue'}
          </PrimaryButton>

          <div className="rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[#68776D] font-medium tabular-nums">
              {lang === 'am'
                ? `ቀሪ ሂሳብ፦ ${demoBalance.toFixed(2)} ETB (15 ብር የመጀመሪያ ቦነስ)`
                : `Balance: ${demoBalance.toFixed(2)} ETB (15 ETB Join Bonus)`}
            </span>
            <button
              type="button"
              onClick={() => onNavigate('referral')}
              className="text-[#159447] font-extrabold hover:underline inline-flex items-center gap-1"
            >
              <Gift size={13} className="text-[#D99B20]" />
              {lang === 'am' ? 'ጓደኛ ጋብዝ (+20 ብር)' : 'Invite Friends (+20 ETB)'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
