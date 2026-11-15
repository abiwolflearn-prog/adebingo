import { useState } from 'react';
import {
  Clock,
  Search,
  Shuffle,
  CheckCircle2,
  Play,
  ArrowLeft,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  calculateDemoPrizePool,
  generateDeterministicCard,
} from '../game/rules';
import { FirestoreRoomPlayer } from '../services/firestoreService';
import { Language, RoomConfig, ScreenId } from '../types/bingo';
import { BingoCardView } from './BingoCardView';

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
      {/* Compact Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0f1a2e] border border-slate-700/50 rounded-2xl p-3">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="p-2 rounded-xl bg-[#14223b] border border-slate-700 text-slate-300 hover:text-white min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label="Back to Home"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h2 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-white">
              {lang === 'am' ? 'ካርድ ይምረጡ (1–600)' : 'Pick Your Cards (1–600)'}
            </h2>
            <p className="text-xs text-slate-400 tabular-nums">
              {selectedCardIds.length}/4 {lang === 'am' ? 'ካርድ' : 'cards'} · {cardPrice} ETB/
              {lang === 'am' ? 'ካርድ' : 'card'} · {lang === 'am' ? 'ሽልማት' : 'Prize'}{' '}
              {prizeSummary.winnerPrizeDemo} ETB
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs ${
              isCardsLocked
                ? 'bg-rose-500/15 border-rose-400/40'
                : countdown > 0 && countdown <= 10
                  ? 'bg-amber-500/15 border-amber-400/50'
                  : 'bg-[#091221] border-cyan-400/35'
            }`}
          >
            <Clock size={14} className={isCardsLocked ? 'text-rose-400' : 'text-[#facc15]'} />
            <b
              data-testid="lobby-countdown"
              className={`font-mono text-sm font-extrabold tabular-nums ${
                isCardsLocked ? 'text-rose-300' : 'text-[#facc15]'
              }`}
            >
              {activeRoom.status === 'countdown'
                ? `00:${String(Math.max(0, countdown)).padStart(2, '0')}`
                : activeRoom.status === 'live'
                  ? 'LIVE'
                  : '00:05'}
            </b>
          </div>

          <button
            type="button"
            data-start="true"
            onClick={onEnterLiveGame}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold flex items-center gap-1.5 hover:brightness-105 min-h-[40px]"
          >
            <Play size={14} />
            {lang === 'am' ? 'ጨዋታ ጀምር' : 'Play Now'}
          </button>
        </div>
      </div>

      {/* Locked Round Banner after 60s */}
      {isCardsLocked && (
        <div
          role="status"
          className="rounded-2xl bg-amber-500/15 border border-amber-400/35 px-4 py-3 text-xs font-extrabold text-amber-200 flex items-center justify-between gap-3"
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
          <button
            type="button"
            onClick={onEnterLiveGame}
            className="px-3 py-1.5 rounded-lg bg-[#facc15] text-[#1e1402] text-xs font-extrabold shrink-0"
          >
            {lang === 'am' ? 'ጨዋታውን ይመልከቱ' : 'Watch Live'}
          </button>
        </div>
      )}

      {/* Main Split: Card Number Deck + Selected Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <section className="lg:col-span-7 bg-[#0f1a2e] border border-slate-700/50 rounded-2xl p-4 space-y-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={lang === 'am' ? 'ካርድ ፈልግ (1–600)...' : 'Search card (1–600)...'}
                aria-label="Search card number between 1 and 600"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-700 bg-[#091221] text-xs font-medium text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>

            <button
              type="button"
              disabled={isCardsLocked}
              onClick={() => onQuickPickCards(Math.min(4, Math.max(1, selectedCardIds.length + 1)))}
              className="px-3.5 py-2.5 rounded-xl bg-[#14223b] border border-cyan-400/35 text-cyan-300 text-xs font-extrabold flex items-center gap-1.5 min-h-[40px] disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Shuffle size={14} />
              {lang === 'am' ? 'በዘፈቀደ ምረጥ' : 'Quick Pick'}
            </button>

            <div className="flex items-center gap-1 bg-[#091221] p-1 rounded-xl">
              {(
                [
                  { id: 'all', am: 'ሁሉም', en: 'All' },
                  { id: 'available', am: 'ክፍት', en: 'Open' },
                  { id: 'mine', am: `${selectedCardIds.length}`, en: `Mine (${selectedCardIds.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setFilterMode(tab.id);
                    setSearchQuery('');
                  }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    filterMode === tab.id
                      ? 'bg-[#22d3ee] text-[#041423]'
                      : 'text-slate-400 hover:text-white'
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
                className={`py-2 px-3 rounded-lg text-xs font-extrabold tabular-nums transition-colors ${
                  rangeIndex === 'all'
                    ? 'bg-[#22d3ee] text-[#041423]'
                    : 'bg-[#14223b] text-slate-300 hover:bg-[#1a2c4b]'
                }`}
              >
                {lang === 'am' ? 'ሁሉም (1–600)' : 'All (1–600)'}
              </button>
              {DECK_RANGES.map((r, idx) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => setRangeIndex(idx)}
                  className={`py-2 px-2.5 rounded-lg text-xs font-extrabold tabular-nums transition-colors ${
                    rangeIndex === idx
                      ? 'bg-[#22d3ee] text-[#041423]'
                      : 'bg-[#14223b] text-slate-300 hover:bg-[#1a2c4b]'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5 max-h-[420px] overflow-y-auto p-0.5">
            {candidateNumbers.length === 0 ? (
              <div className="col-span-full py-10 text-center text-xs text-slate-500">
                {lang === 'am' ? 'ምንም ካርድ አልተገኘም።' : 'No cards match your filter.'}
              </div>
            ) : (
              candidateNumbers.map((cardNum) => {
                const isSelected = selectedCardIds.includes(cardNum);
                const isTaken = activeRoom.takenCardIds.includes(cardNum);

                return (
                  <button
                    key={cardNum}
                    type="button"
                    disabled={isTaken || isCardsLocked}
                    onClick={() => onToggleCardId(cardNum)}
                    aria-label={`Card number ${cardNum}${
                      isSelected ? ' selected' : isTaken ? ' taken' : isCardsLocked ? ' locked' : ''
                    }`}
                    className={`h-10 rounded-lg font-['Outfit'] font-bold text-xs tabular-nums transition-all flex items-center justify-center ${
                      isSelected
                        ? 'bg-[#22d3ee] text-[#041423] ring-2 ring-[#facc15]'
                        : isTaken || isCardsLocked
                          ? 'bg-slate-800/70 text-slate-500 cursor-not-allowed'
                          : 'bg-[#14223b] text-slate-200 border border-slate-700 hover:border-cyan-400'
                    }`}
                  >
                    {cardNum}
                  </button>
                );
              })
            )}
          </div>

          {selectedCardIds.length > 0 && (
            <div className="flex items-center justify-between pt-2 border-t border-slate-800 text-xs">
              <span className="text-slate-400">
                {lang === 'am' ? 'የተመረጡ፦' : 'Selected:'}{' '}
                <b className="text-cyan-300">{selectedCardIds.join(', ')}</b>
              </span>
              {!isCardsLocked && (
                <button
                  type="button"
                  onClick={onClearSelectedCards}
                  className="font-bold text-rose-400 hover:underline"
                >
                  {lang === 'am' ? 'አጽዳ' : 'Clear'}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-[#0f1a2e] border border-slate-700/50 rounded-2xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-['Outfit'] text-base font-extrabold text-white">
              {lang === 'am'
                ? `የእርስዎ ካርዶች (${selectedCardIds.length}/4)`
                : `Your Cards (${selectedCardIds.length}/4)`}
            </h3>
            <span className="text-xs font-mono font-extrabold text-[#facc15] tabular-nums">
              {entryCost} ETB
            </span>
          </div>

          {selectedCardIds.length === 0 ? (
            <div className="py-8 px-4 text-center bg-[#091221] rounded-xl border border-dashed border-slate-700">
              <p className="text-xs font-bold text-slate-300">
                {lang === 'am'
                  ? 'ከ1–600 እስከ 4 ካርዶችን ይምረጡ።'
                  : 'Select 1 to 4 cards from 1–600.'}
              </p>
              <button
                type="button"
                disabled={isCardsLocked}
                onClick={() => onQuickPickCards(1)}
                className="mt-3 px-4 py-2 rounded-xl bg-[#22d3ee] text-[#041423] text-xs font-extrabold min-h-[40px] disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {lang === 'am' ? '1 ካርድ በዘፈቀደ ምረጥ' : 'Quick Pick 1 Card'}
              </button>
            </div>
          ) : (
            <div
              className={`grid gap-1.5 ${
                selectedCardIds.length === 1 ? 'grid-cols-1 max-w-[145px]' : 'grid-cols-2 max-w-[300px]'
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

          <button
            type="button"
            onClick={onEnterLiveGame}
            className={`w-full py-3.5 px-4 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all min-h-[46px] ${
              selectedCardIds.length > 0
                ? 'bg-gradient-to-r from-[#22d3ee] to-[#0284c7] text-[#041423] hover:brightness-110'
                : 'bg-[#14223b] border border-amber-400/40 text-amber-200 hover:border-amber-400'
            }`}
          >
            <CheckCircle2 size={16} />
            {selectedCardIds.length > 0
              ? lang === 'am'
                ? `በ ${selectedCardIds.length} ካርድ ጨዋታ ጀምር (${entryCost} ETB)`
                : `Start Playing (${selectedCardIds.length} card${selectedCardIds.length === 1 ? '' : 's'} · ${entryCost} ETB)`
              : lang === 'am'
              ? 'ያለ ካርድ መጫወት አይቻልም — ቢያንስ 1 ካርድ ይምረጡ'
              : 'Select at least 1 card to play'}
          </button>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums">
            <span>
              {lang === 'am'
                ? `ቀሪ ሂሳብ፦ ${demoBalance.toFixed(2)} ETB (ሲቀላቀሉ 15 ብር)`
                : `Balance: ${demoBalance.toFixed(2)} ETB (15 ETB Join Bonus)`}
            </span>
            <button
              type="button"
              onClick={() => onNavigate('referral')}
              className="text-cyan-300 font-extrabold hover:underline"
            >
              {lang === 'am' ? 'ጓደኛ ጋብዝ (+20 ብር)' : 'Invite Friends (+20 ETB)'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
