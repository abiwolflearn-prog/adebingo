import {
  Clock,
  Shuffle,
  CheckCircle2,
  Play,
  ArrowLeft,
  Sparkles,
  Trophy,
  Grid,
  Wallet,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  calculateAuthoritativeGameFinancials,
  generateDeterministicCard,
} from '../game/rules';
import { FirestoreRoomPlayer } from '../services/firestoreService';
import { Language, RoomConfig, ScreenId } from '../types/bingo';
import { BingoCardView } from './BingoCardView';
import {
  BingoNumberTile,
  EmptyState,
  PrimaryButton,
} from './DesignSystem';

interface LobbyAndCardsScreenProps {
  mode: 'lobby' | 'cards';
  lang: Language;
  rooms?: RoomConfig[];
  activeRoom: RoomConfig;
  onSelectRoom?: (roomId: string) => void;
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

const ALL_CARDS = Array.from({ length: DEFAULT_GAME_RULES.maxCardsPerRoom }, (_, i) => i + 1);

export function LobbyAndCardsScreen({
  lang,
  rooms,
  activeRoom,
  onSelectRoom,
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
  const isCardsLocked = activeRoom.status === 'live' || activeRoom.status === 'completed';
  const totalCardsInPlay = activeRoom.takenCardIds.length + selectedCardIds.length;
  const confirmedPlayersCount = Math.max(
    activeRoom.confirmedPlayersCount ?? activeRoom.activePlayers,
    selectedCardIds.length > 0 ? 1 : 0
  );
  const financials = calculateAuthoritativeGameFinancials(
    confirmedPlayersCount,
    totalCardsInPlay,
    cardPrice
  );
  const winnersPrizePoolEtb =
    typeof activeRoom.winnersPrizePoolEtb === 'number' &&
    activeRoom.winnersPrizePoolEtb > financials.winnersPrizePoolEtb
      ? activeRoom.winnersPrizePoolEtb
      : financials.winnersPrizePoolEtb;
  const entryCost = selectedCardIds.length * cardPrice;

  return (
    <div className="space-y-2">
      {/* Top Game Info & Card Selection Header Card (Ultra-Compact Icon-First) */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 bg-white border border-[#E7EDE8] rounded-xl p-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            title={lang === 'am' ? 'ወደ መነሻ ተመለስ' : 'Back to Home'}
            className="p-1.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB] hover:border-[#159447]/40 min-h-[32px] min-w-[32px] flex items-center justify-center transition-colors shrink-0"
            aria-label="Back to Home"
          >
            <ArrowLeft size={14} className="text-[#159447]" />
          </button>
          <div className="min-w-0">
            <h2 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#159447] leading-tight flex items-center gap-1">
              <Grid size={13} />
              {lang === 'am' ? 'ካርዶች' : 'Cards'}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <div
            title={lang === 'am' ? 'የዙር ሰዓት ቆጣሪ' : 'Round countdown timer'}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] min-h-[32px] ${
              isCardsLocked
                ? 'bg-[#FFF5F5] border-[#D94B4B]/40 text-[#D94B4B]'
                : countdown > 0 && countdown <= 10
                ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#9A6B0B]'
                : 'bg-[#E6F6EB] border-[#159447]/30 text-[#08743A]'
            }`}
          >
            <Clock
              size={12}
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
              className="font-mono text-xs font-extrabold tabular-nums"
            >
              {activeRoom.status === 'live'
                ? 'LIVE'
                : `00:${String(Math.max(0, countdown)).padStart(2, '0')}`}
            </b>
          </div>

          <PrimaryButton
            data-start="true"
            variant="emerald"
            size="sm"
            onClick={onEnterLiveGame}
            icon={<Play size={12} className="fill-current" />}
          >
            {lang === 'am' ? 'ይጫወቱ' : 'Play'}
          </PrimaryButton>
        </div>
      </div>

      {rooms && rooms.length > 1 && onSelectRoom && (
        <div className="flex flex-wrap items-center gap-1">
          {rooms.map((rm) => {
            const isCurrent = rm.id === activeRoom.id;
            return (
              <button
                key={rm.id}
                type="button"
                onClick={() => onSelectRoom(rm.id)}
                className={`px-2 py-1 rounded-lg text-[10px] font-extrabold border transition-colors ${
                  isCurrent
                    ? 'bg-[#159447] text-white border-[#159447]'
                    : 'bg-white text-[#183326] border-[#E7EDE8] hover:border-[#159447]/40'
                }`}
              >
                {lang === 'am' ? rm.nameAm : rm.nameEn} · {rm.cardPrice} ETB
              </button>
            );
          })}
        </div>
      )}

      {/* Compact 2-Col Metric Strip */}
      <div className="grid grid-cols-2 gap-1.5">
        <div
          title={lang === 'am' ? 'የዙር አሸናፊ ሽልማት (80%)' : 'Winners Prize Pool (80%)'}
          className="rounded-xl bg-[#FEF5DC]/75 border border-[#F5BD42]/60 p-2 flex items-center justify-between shadow-2xs"
        >
          <div className="min-w-0">
            <span className="text-[9.5px] font-bold text-[#9A6B0B] flex items-center gap-1 truncate">
              <Trophy size={10} className="text-[#D99B20]" />
              {lang === 'am' ? 'ሽልማት (80%)' : 'Prize (80%)'}
            </span>
            <b
              data-testid="lobby-prize-pool"
              className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] tabular-nums"
            >
              {winnersPrizePoolEtb} ETB
            </b>
          </div>
          <span className="text-[9px] font-mono font-extrabold text-[#9A6B0B] bg-white/80 border border-[#F5BD42]/50 px-1.5 py-0.5 rounded shrink-0">
            {confirmedPlayersCount}/600
          </span>
        </div>

        <div
          className="rounded-xl bg-white border border-[#E7EDE8] p-2 flex items-center justify-between shadow-2xs"
        >
          <div className="min-w-0">
            <span className="text-[9.5px] font-bold text-[#68776D] flex items-center gap-1 truncate">
              <Wallet size={10} className="text-[#159447]" />
              {lang === 'am' ? 'ሂሳብ' : 'Balance'}
            </span>
            <b className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] tabular-nums">
              {demoBalance.toFixed(0)} ETB
            </b>
          </div>
          {entryCost > 0 && (
            <span className="text-[9px] font-extrabold bg-[#E6F6EB] text-[#08743A] px-1.5 py-0.5 rounded shrink-0">
              -{entryCost}
            </span>
          )}
        </div>
      </div>

      {/* Locked Round Banner after 60s */}
      {isCardsLocked && (
        <div
          role="status"
          className="rounded-xl bg-[#FEF5DC] border border-[#F5BD42] px-2.5 py-1.5 text-[11px] font-extrabold text-[#183326] flex items-center justify-between gap-2 shadow-xs"
        >
          <span>
            {activeRoom.status === 'completed'
              ? lang === 'am'
                ? 'ዙሩ ተጠናቋል · አዲስ ዙር ይጀምራል'
                : 'Round finished · Next round starting'
              : lang === 'am'
              ? 'ቀጥታ ጨዋታ · ካርዶች ተቆልፈዋል'
              : 'Live round · Cards locked'}
          </span>
          <PrimaryButton variant="gold" size="sm" onClick={onEnterLiveGame}>
            {lang === 'am' ? 'ይመልከቱ' : 'Watch'}
          </PrimaryButton>
        </div>
      )}

      {/* Main Split: Card Number Deck + Selected Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-start">
        <section className="lg:col-span-7 bg-white border border-[#E7EDE8] rounded-xl p-2 sm:p-2.5 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
          {/* Warm Cream Tray with 8-col mobile / 10-col desktop Number Tiles */}
          <div className="rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] p-1.5">
            <div className="grid grid-cols-8 sm:grid-cols-10 gap-1 max-h-[250px] overflow-y-auto p-0.5">
              {ALL_CARDS.map((cardNum) => {
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
              })}
            </div>
          </div>

          {selectedCardIds.length > 0 && (
            <div className="flex items-center justify-end gap-1.5 text-[10px]">
              <b className="text-[#159447] font-mono">#{selectedCardIds.join(', #')}</b>
              {!isCardsLocked && (
                <button
                  type="button"
                  onClick={onClearSelectedCards}
                  title={lang === 'am' ? 'ሁሉንም አጽዳ' : 'Clear selected cards'}
                  className="p-1 rounded text-[#D94B4B] hover:bg-red-50"
                  aria-label="Clear selected cards"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
        </section>

        {/* Right Preview & Confirmation Column */}
        <section className="lg:col-span-5 bg-white border border-[#E7EDE8] rounded-xl p-2 sm:p-2.5 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
          {selectedCardIds.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="w-4 h-4" />}
              title={lang === 'am' ? 'ካርድ' : 'Cards'}
              action={
                <PrimaryButton
                  variant="gold"
                  size="sm"
                  disabled={isCardsLocked}
                  onClick={() => onQuickPickCards(1)}
                  icon={<Shuffle size={12} />}
                >
                  +1
                </PrimaryButton>
              }
            />
          ) : (
            <div
              className={`grid gap-1.5 mx-auto ${
                selectedCardIds.length === 1
                  ? 'grid-cols-1 max-w-[165px]'
                  : 'grid-cols-2 max-w-[300px]'
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
            size="md"
            fullWidth
            onClick={onEnterLiveGame}
            icon={<CheckCircle2 size={14} />}
          >
            {lang === 'am' ? 'ይጫወቱ' : 'Play'}
          </PrimaryButton>
        </section>
      </div>
    </div>
  );
}
