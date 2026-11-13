import { useState } from 'react';
import {
  Clock,
  Users,
  Sparkles,
  Search,
  Shuffle,
  CheckCircle2,
  Play,
  Layers,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  calculateDemoPrizePool,
  generateDeterministicCard,
  isRoomEligibleToStart,
} from '../game/rules';
import { LIVE_DEMO_PLAYERS } from '../data/demoData';
import { Language, RoomConfig, ScreenId } from '../types/bingo';
import { BingoCardView } from './BingoCardView';

interface LobbyAndCardsScreenProps {
  mode: 'lobby' | 'cards';
  lang: Language;
  rooms: RoomConfig[];
  activeRoom: RoomConfig;
  onSelectRoom: (roomId: string) => void;
  selectedCardIds: number[];
  onToggleCardId: (cardId: number) => void;
  onQuickPickCards: (count: number) => void;
  onClearSelectedCards: () => void;
  countdown: number;
  onResetCountdown: () => void;
  cardPrice: number;
  onChangeCardPrice: (price: number) => void;
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
  mode,
  lang,
  rooms,
  activeRoom,
  onSelectRoom,
  selectedCardIds,
  onToggleCardId,
  onQuickPickCards,
  onClearSelectedCards,
  countdown,
  onResetCountdown,
  cardPrice,
  onChangeCardPrice,
  demoBalance,
  onEnterLiveGame,
  onNavigate,
}: LobbyAndCardsScreenProps) {
  const [rangeIndex, setRangeIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'available' | 'mine'>('all');

  const currentRange = DECK_RANGES[rangeIndex];
  const totalCardsInPlay = activeRoom.takenCardIds.length + selectedCardIds.length;
  const prizeSummary = calculateDemoPrizePool(totalCardsInPlay, cardPrice);
  const eligible = isRoomEligibleToStart(
    activeRoom.activePlayers,
    selectedCardIds.length,
    activeRoom.minPlayers
  );
  const entryCost = selectedCardIds.length * cardPrice;

  // Build visible card numbers from 1..600
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
    <div className="space-y-5">
      {/* Sub-navigation Switcher between Lobby Overview & 1-600 Card Picker */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#e3ede6] rounded-2xl p-3 shadow-xs">
        <div className="flex items-center gap-1.5 bg-[#eef7f1] p-1 rounded-xl">
          <button
            type="button"
            onClick={() => onNavigate('lobby')}
            className={`px-3.5 py-2 rounded-lg text-xs font-extrabold transition-colors whitespace-nowrap ${
              mode === 'lobby'
                ? 'bg-[#087e50] text-white shadow-xs'
                : 'text-[#3d5f4c] hover:text-[#087e50]'
            }`}
          >
            {lang === 'am' ? '1. የጨዋታ ሎቢ (Lobby)' : '1. Game Lobby'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('cards')}
            className={`px-3.5 py-2 rounded-lg text-xs font-extrabold transition-colors whitespace-nowrap ${
              mode === 'cards'
                ? 'bg-[#087e50] text-white shadow-xs'
                : 'text-[#3d5f4c] hover:text-[#087e50]'
            }`}
          >
            {lang === 'am'
              ? `2. ካርድ መምረጫ (1–600) [${selectedCardIds.length}/4]`
              : `2. Card Selection (1–600) [${selectedCardIds.length}/4]`}
          </button>
        </div>

        {/* Live 60s Countdown Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#f3faf5] border border-[#d6eadc] px-3 py-1.5 rounded-xl">
            <Clock size={15} className="text-[#087e50]" />
            <span className="text-xs font-bold text-[#2b523c]">
              {lang === 'am' ? 'ዙሩ የሚጀምረው፦' : 'Starts in:'}
            </span>
            <b
              data-testid="lobby-countdown"
              className="font-mono text-sm font-extrabold text-[#087e50] tabular-nums"
            >
              00:{String(countdown).padStart(2, '0')}
            </b>
            <button
              type="button"
              onClick={onResetCountdown}
              className="text-[11px] font-bold text-[#61806e] hover:text-[#087e50] underline ml-1"
            >
              {lang === 'am' ? '60s አድስ' : 'Reset 60s'}
            </button>
          </div>

          <button
            type="button"
            data-start="true"
            onClick={onEnterLiveGame}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold flex items-center gap-1.5 shadow-sm hover:brightness-105 transition-all whitespace-nowrap"
          >
            <Play size={14} />
            {lang === 'am' ? 'ወደ ቀጥታ ጨዋታ ግባ' : 'Start Live Game'}
          </button>
        </div>
      </div>

      {/* Room Selection Cards & Configurable Card Price */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        {rooms.map((rm) => {
          const isCurrent = rm.id === activeRoom.id;
          return (
            <button
              key={rm.id}
              type="button"
              onClick={() => onSelectRoom(rm.id)}
              className={`text-left p-4 rounded-2xl border transition-all ${
                isCurrent
                  ? 'bg-gradient-to-br from-[#075d3c] to-[#0e8d58] text-white border-[#087e50] shadow-md'
                  : 'bg-white text-[#193b2b] border-[#e3ede6] hover:border-[#12a566]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span
                  className={`text-[11px] font-bold uppercase tracking-wider ${
                    isCurrent ? 'text-[#fde047]' : 'text-[#12a566]'
                  }`}
                >
                  {lang === 'am' ? rm.badgeAm : rm.badgeEn}
                </span>
                <span
                  className={`text-xs font-mono font-bold tabular-nums ${
                    isCurrent ? 'text-[#d4f5e2]' : 'text-[#627b6c]'
                  }`}
                >
                  {rm.activePlayers} {lang === 'am' ? 'ተጫዋቾች' : 'players'} · {rm.maxCardsPerRoom}{' '}
                  {lang === 'am' ? 'ካርድ' : 'cards'}
                </span>
              </div>
              <h3 className="font-['Outfit'] text-lg font-extrabold">
                {lang === 'am' ? rm.nameAm : rm.nameEn}
              </h3>
              <p
                className={`text-xs mt-0.5 ${
                  isCurrent ? 'text-[#d8f3e3]' : 'text-[#6e8577]'
                }`}
              >
                {lang === 'am' ? rm.subtitleAm : rm.subtitleEn}
              </p>
            </button>
          );
        })}
      </section>

      {/* Lobby Rules, Eligibility & Configurable Price Strip */}
      <section className="bg-white border border-[#e3ede6] rounded-2xl p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
        <div>
          <small className="text-[11px] font-extrabold text-[#6e8577] uppercase block">
            {lang === 'am' ? 'ብቁ ተጫዋቾች (ቢያንስ 3)' : 'ELIGIBLE PLAYERS (MIN 3)'}
          </small>
          <div className="flex items-center gap-2 mt-1">
            <Users size={18} className="text-[#087e50]" />
            <b className="font-['Outfit'] text-lg font-extrabold tabular-nums">
              {activeRoom.activePlayers} / {activeRoom.minPlayers}+
            </b>
            <span className="text-xs font-bold text-[#087e50]">
              {eligible
                ? lang === 'am'
                  ? '✓ ዝግጁ'
                  : '✓ Ready'
                : lang === 'am'
                ? 'ካርድ ይምረጡ'
                : 'Select 1+ card'}
            </span>
          </div>
        </div>

        <div>
          <small className="text-[11px] font-extrabold text-[#6e8577] uppercase block">
            {lang === 'am' ? 'የካርድ ዋጋ (ሊስተካከል የሚችል)' : 'CARD PRICE (CONFIGURABLE)'}
          </small>
          <div className="flex items-center gap-1.5 mt-1">
            <SlidersHorizontal size={15} className="text-[#087e50]" />
            {[5, 10, 20, 50].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChangeCardPrice(p)}
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold tabular-nums transition-colors ${
                  cardPrice === p
                    ? 'bg-[#087e50] text-white'
                    : 'bg-[#eff7f2] text-[#355644] hover:bg-[#dff1e6]'
                }`}
              >
                {p} ETB
              </button>
            ))}
          </div>
        </div>

        <div>
          <small className="text-[11px] font-extrabold text-[#6e8577] uppercase block">
            {lang === 'am' ? 'የተመረጡ ካርዶች እና ወጪ' : 'YOUR CARDS & ENTRY COST'}
          </small>
          <div className="mt-1 font-['Outfit'] text-lg font-extrabold text-[#193b2b] tabular-nums">
            {selectedCardIds.length}/4 {lang === 'am' ? 'ካርድ' : 'cards'} ·{' '}
            <span className="text-[#087e50]">{entryCost} ETB</span>
          </div>
        </div>

        <div>
          <small className="text-[11px] font-extrabold text-[#6e8577] uppercase block">
            {lang === 'am' ? 'የዙሩ የሙከራ ሽልማት ክምችት' : 'EST. DEMO PRIZE POOL'}
          </small>
          <div className="mt-1 font-['Outfit'] text-lg font-extrabold text-[#d49a19] tabular-nums">
            {prizeSummary.winnerPrizeDemo} ETB{' '}
            <span className="text-xs font-normal text-[#778c7f]">
              ({totalCardsInPlay}/600 {lang === 'am' ? 'ካርድ' : 'cards'})
            </span>
          </div>
        </div>
      </section>

      {/* Main Content Split: 1-600 Card Selector Deck + Live Selected Cards Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left 7 Columns: 1-600 Card Deck Selector */}
        <section className="lg:col-span-7 bg-white border border-[#e3ede6] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-[11px] font-extrabold tracking-wider uppercase text-[#12a566]">
                {lang === 'am' ? 'ከ 1 እስከ 600 የቢንጎ ካርዶች' : '1–600 BINGO CARD DECK'}
              </span>
              <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
                {lang === 'am'
                  ? 'የእድል ካርድ ቁጥርዎን ይምረጡ (ቢበዛ 4)'
                  : 'Pick Your Card Numbers (Max 4)'}
              </h3>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onQuickPickCards(Math.min(4, Math.max(1, selectedCardIds.length + 1)))}
                className="px-3 py-2 rounded-xl bg-[#eef8f2] text-[#087e50] hover:bg-[#def2e6] text-xs font-extrabold flex items-center gap-1.5 transition-colors"
              >
                <Shuffle size={14} />
                {lang === 'am' ? 'በዘፈቀደ ምረጥ' : 'Quick Pick'}
              </button>
              <button
                type="button"
                onClick={() => onQuickPickCards(4)}
                className="px-3 py-2 rounded-xl bg-[#fef6dd] text-[#8a6109] hover:bg-[#fdebb6] text-xs font-extrabold flex items-center gap-1.5 transition-colors"
              >
                <Sparkles size={14} />
                {lang === 'am' ? '4 ካርድ ሙላ' : 'Pick 4 Cards'}
              </button>
            </div>
          </div>

          {/* Search & Filter Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[180px]">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7e9487]"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  lang === 'am'
                    ? 'የካርድ ቁጥር ይፈልጉ (1–600)...'
                    : 'Search card number (1–600)...'
                }
                aria-label="Search card number between 1 and 600"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-[#d9e7de] bg-[#f9fcfa] text-xs font-medium text-[#193b2b] focus:outline-none focus:border-[#087e50]"
              />
            </div>

            <div className="flex items-center gap-1 bg-[#f0f7f2] p-1 rounded-xl">
              {(
                [
                  { id: 'all', am: 'ሁሉም', en: 'All' },
                  { id: 'available', am: 'ክፍት ብቻ', en: 'Available' },
                  { id: 'mine', am: `የእኔ (${selectedCardIds.length})`, en: `Selected (${selectedCardIds.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setFilterMode(tab.id);
                    setSearchQuery('');
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                    filterMode === tab.id
                      ? 'bg-white text-[#087e50] shadow-2xs'
                      : 'text-[#5b7565] hover:text-[#193b2b]'
                  }`}
                >
                  {lang === 'am' ? tab.am : tab.en}
                </button>
              ))}
            </div>
          </div>

          {/* 1-600 Range Tabs (when not searching or filtering by mine) */}
          {searchQuery.trim() === '' && filterMode !== 'mine' && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {DECK_RANGES.map((r, idx) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => setRangeIndex(idx)}
                  className={`py-2 px-2 rounded-xl text-xs font-extrabold tabular-nums transition-colors ${
                    rangeIndex === idx
                      ? 'bg-[#087e50] text-white'
                      : 'bg-[#f2f8f4] text-[#3c5e4b] hover:bg-[#e3f2e8]'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* 10x10 Grid of Card Numbers */}
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5 max-h-[340px] overflow-y-auto p-1">
            {candidateNumbers.length === 0 ? (
              <div className="col-span-full py-10 text-center text-xs text-[#6f8578]">
                {lang === 'am'
                  ? 'ምንም ካርድ አልተገኘም። እባክዎ ሌላ ቁጥር ይሞክሩ።'
                  : 'No cards match your filter. Try another range or number.'}
              </div>
            ) : (
              candidateNumbers.slice(0, 100).map((cardNum) => {
                const isSelected = selectedCardIds.includes(cardNum);
                const isTaken = activeRoom.takenCardIds.includes(cardNum);

                return (
                  <button
                    key={cardNum}
                    type="button"
                    disabled={isTaken}
                    onClick={() => onToggleCardId(cardNum)}
                    aria-label={`Card number ${cardNum}${
                      isSelected ? ' selected' : isTaken ? ' taken' : ''
                    }`}
                    className={`h-10 rounded-xl font-['Outfit'] font-bold text-xs tabular-nums transition-all flex items-center justify-center ${
                      isSelected
                        ? 'bg-[#087e50] text-white ring-2 ring-[#f2c24b] shadow-xs scale-[1.03]'
                        : isTaken
                        ? 'bg-[#edf2ee] text-[#9eb0a5] line-through cursor-not-allowed'
                        : 'bg-[#f4faf6] text-[#1f4732] border border-[#dcece1] hover:bg-[#dff4e7] hover:border-[#12a566]'
                    }`}
                  >
                    #{cardNum}
                  </button>
                );
              })
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#edf4ef] text-xs text-[#677e70]">
            <div className="flex items-center gap-3">
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-xs bg-[#087e50] mr-1" />
                {lang === 'am' ? 'የተመረጠ' : 'Selected'}
              </span>
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-xs bg-[#f4faf6] border border-[#dcece1] mr-1" />
                {lang === 'am' ? 'ክፍት' : 'Available'}
              </span>
              <span>
                <b className="inline-block w-2.5 h-2.5 rounded-xs bg-[#edf2ee] mr-1" />
                {lang === 'am' ? 'በሌላ የተያዘ' : 'Taken'}
              </span>
            </div>

            {selectedCardIds.length > 0 && (
              <button
                type="button"
                onClick={onClearSelectedCards}
                className="text-xs font-bold text-[#b91c1c] hover:underline"
              >
                {lang === 'am' ? 'ምርጫን አጽዳ' : 'Clear selection'}
              </button>
            )}
          </div>
        </section>

        {/* Right 5 Columns: Selected Cards 5x5 Preview + Live Room Players */}
        <section className="lg:col-span-5 space-y-4">
          <div className="bg-white border border-[#e3ede6] rounded-2xl p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-extrabold uppercase text-[#12a566] flex items-center gap-1">
                  <Layers size={13} />
                  {lang === 'am' ? 'የእርስዎ ካርዶች ቅድመ-እይታ' : 'SELECTED CARDS PREVIEW'}
                </span>
                <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
                  {selectedCardIds.length}/4{' '}
                  {lang === 'am' ? 'የተመረጡ የቢንጎ ካርዶች' : 'Active Bingo Cards'}
                </h3>
              </div>

              <span className="text-xs font-mono font-bold text-[#087e50] bg-[#e9f8ef] px-2.5 py-1 rounded-lg tabular-nums">
                {entryCost} ETB ({lang === 'am' ? 'ሙከራ' : 'Demo'})
              </span>
            </div>

            {selectedCardIds.length === 0 ? (
              <div className="py-8 px-4 text-center bg-[#f6fbf8] rounded-2xl border border-dashed border-[#cbe2d3]">
                <p className="text-xs font-bold text-[#385c48]">
                  {lang === 'am'
                    ? 'ገና ምንም ካርድ አልመረጡም (ከ1–600 ቢያንስ 1 ካርድ ይምረጡ)'
                    : 'No cards selected yet (Pick 1 to 4 cards from #1–#600)'}
                </p>
                <button
                  type="button"
                  onClick={() => onQuickPickCards(2)}
                  className="mt-3 px-4 py-2 rounded-xl bg-[#087e50] text-white text-xs font-extrabold"
                >
                  {lang === 'am' ? '2 ካርዶችን በዘፈቀደ ምረጥ' : 'Quick Pick 2 Cards'}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      onRemoveCard={(cid) => onToggleCardId(cid)}
                    />
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={onEnterLiveGame}
              className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold flex items-center justify-center gap-2 shadow-md hover:brightness-105 transition-all"
            >
              <CheckCircle2 size={16} />
              {lang === 'am'
                ? `በ ${selectedCardIds.length} ካርድ ወደ ቀጥታ ጨዋታ ግባ (${entryCost} ETB Demo)`
                : `Confirm ${selectedCardIds.length} Card(s) & Enter Live Game (${entryCost} ETB Demo)`}
            </button>

            <p className="text-[11px] text-[#6d8375] text-center">
              {lang === 'am'
                ? `የሙከራ ቀሪ ሂሳብዎ፦ ${demoBalance.toFixed(2)} ETB · እውነተኛ ገንዘብ አይቆረጥም።`
                : `Your Demo Balance: ${demoBalance.toFixed(2)} ETB · Sandbox mode only.`}
            </p>
          </div>

          {/* Live Room Players Roster */}
          <div className="bg-white border border-[#e3ede6] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-[#193b2b] flex items-center gap-1.5">
                <ShieldCheck size={15} className="text-[#087e50]" />
                {lang === 'am' ? 'በሎቢ ውስጥ ያሉ ተጫዋቾች' : 'Players in Lobby'}
              </span>
              <span className="text-xs font-bold text-[#087e50] tabular-nums">
                {activeRoom.activePlayers} {lang === 'am' ? 'በመስመር ላይ' : 'Online'}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {LIVE_DEMO_PLAYERS.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 bg-[#f5faf7] border border-[#e3efe7] px-2.5 py-2 rounded-xl text-xs"
                >
                  <span className="w-7 h-7 rounded-full bg-[#d8f3e3] text-[#087e50] font-extrabold text-[11px] flex items-center justify-center shrink-0">
                    {p.avatar}
                  </span>
                  <div className="min-w-0">
                    <b className="block truncate text-[#193b2b] text-[11px]">{p.name}</b>
                    <small className="text-[10px] text-[#6f8578] tabular-nums">
                      {p.cards}/4 {lang === 'am' ? 'ካርድ' : 'cards'}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
