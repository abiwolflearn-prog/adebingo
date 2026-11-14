import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Sparkles, RotateCcw, CheckCircle2, Users } from 'lucide-react';
import { BingoCard, Language, WinResult } from '../types/bingo';
import type { RoundWinnerShare } from '../game/roundSettlement';
import { BingoCardView } from './BingoCardView';

interface WinnerModalProps {
  open: boolean;
  winResult: WinResult | null;
  winningCard: BingoCard | null;
  calledNumbers: number[];
  markedNumbers: number[];
  prizeDemoEtb: number;
  winners?: RoundWinnerShare[];
  lang: Language;
  onPlayAgain: () => void;
  onClose: () => void;
}

export function WinnerModal({
  open,
  winResult,
  winningCard,
  calledNumbers,
  markedNumbers,
  prizeDemoEtb,
  winners = [],
  lang,
  onPlayAgain,
  onClose,
}: WinnerModalProps) {
  const isShared = winners.length > 1;
  const totalPool = winners.reduce((s, w) => s + w.prizeEtb, 0) || prizeDemoEtb;

  return (
    <AnimatePresence>
      {open && winResult && winningCard && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#030712]/80 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="winner-modal-title"
        >
          <motion.div
            initial={{ scale: 0.85, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 20 }}
            className="relative w-full max-w-md rounded-3xl bg-[#0f1a2e] border-2 border-[#facc15]/80 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.7)] text-[#f1f5f9] max-h-[90vh] overflow-y-auto"
          >
            {/* Gold Trophy Banner */}
            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-[#fde047] to-[#f59e0b] flex items-center justify-center text-[#451a03] shadow-[0_8px_24px_rgba(250,204,21,0.35)] mb-3">
              <Trophy size={34} />
            </div>

            <div className="text-center">
              <p className="text-xs font-extrabold tracking-widest uppercase text-[#22d3ee] flex items-center justify-center gap-1">
                <Sparkles size={14} />
                {lang === 'am' ? 'እንኳን ደስ አለዎት! BINGO!' : 'CONGRATULATIONS! BINGO!'}
              </p>
              <h2
                id="winner-modal-title"
                className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold text-white mt-1"
              >
                {isShared
                  ? lang === 'am'
                    ? `${winners.length} አሸናፊዎች (ሽልማት ተከፋፍሏል)!`
                    : `${winners.length} Simultaneous Winners!`
                  : lang === 'am'
                    ? 'ዙሩን አሸንፈዋል!'
                    : 'Round Winner Confirmed!'}
              </h2>
              <p className="text-xs text-[#94a3b8] mt-1">
                {lang === 'am'
                  ? `ካርድ ${winningCard.id} · ${winResult.patternLabelAm}`
                  : `Card ${winningCard.id} · ${winResult.patternLabelEn}`}
              </p>
            </div>

            {/* Stats Summary Strip */}
            <div className="grid grid-cols-3 gap-2 my-4 bg-[#091221] p-3 rounded-2xl border border-[#1e3252] text-center">
              <div>
                <small className="block text-[10px] font-bold text-[#94a3b8] uppercase">
                  {isShared
                    ? lang === 'am'
                      ? 'የእርስዎ ድርሻ'
                      : 'YOUR SHARE'
                    : lang === 'am'
                      ? 'የሽልማት ሂሳብ'
                      : 'PRIZE'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-[#facc15] tabular-nums">
                  +{prizeDemoEtb.toFixed(2)} ETB
                </b>
              </div>
              <div>
                <small className="block text-[10px] font-bold text-[#94a3b8] uppercase">
                  {lang === 'am' ? 'የተጠሩ ቁጥሮች' : 'CALLS'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-[#22d3ee] tabular-nums">
                  {calledNumbers.length}/75
                </b>
              </div>
              <div>
                <small className="block text-[10px] font-bold text-[#94a3b8] uppercase">
                  {isShared
                    ? lang === 'am'
                      ? 'ጠቅላላ ሽልማት'
                      : 'TOTAL POOL'
                    : lang === 'am'
                      ? 'አሸናፊ ካርድ'
                      : 'CARD ID'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-white tabular-nums">
                  {isShared ? `${totalPool.toFixed(0)} ETB` : winningCard.id}
                </b>
              </div>
            </div>

            {/* Simultaneous Winners Distribution Breakdown */}
            {winners.length > 0 && (
              <div className="mb-3 rounded-2xl bg-[#091221] border border-[#1e3252] p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-extrabold text-cyan-300">
                  <span className="flex items-center gap-1.5">
                    <Users size={13} />
                    {lang === 'am' ? 'የሽልማት ክፍፍል' : 'Payout Distribution'}
                  </span>
                  <span className="text-slate-400">
                    {winners.length} {lang === 'am' ? 'አሸናፊ' : 'winner(s)'}
                  </span>
                </div>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {winners.map((w) => (
                    <div
                      key={`${w.uid}-${w.cardId}`}
                      className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-lg bg-[#14223b]"
                    >
                      <span className="truncate text-slate-200 font-bold">
                        {w.displayName} · {lang === 'am' ? 'ካርድ' : 'Card'} {w.cardId}
                      </span>
                      <b className="font-mono text-[#facc15] tabular-nums shrink-0">
                        +{w.prizeEtb.toFixed(2)} ETB
                      </b>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Mini Winning Card Verification Preview */}
            <div className="my-2.5 max-w-[250px] mx-auto">
              <BingoCardView
                card={winningCard}
                calledNumbers={calledNumbers}
                markedNumbers={markedNumbers}
                compact
                lang={lang}
              />
            </div>

            <div className="flex items-center gap-2 text-[11px] text-[#cbd5e1] bg-[#14223b] border border-[#1e3252] px-3 py-2 rounded-xl mb-4">
              <CheckCircle2 size={16} className="text-[#22d3ee] shrink-0" />
              <span>
                {lang === 'am'
                  ? 'ሽልማቱ ወደ አሸናፊዎች ሂሳብ ተጨምሯል። አዲስ ዙር በጥቂት ሰከንዶች ይጀምራል።'
                  : 'Prizes credited to winner accounts. Next 60s round starts automatically in seconds.'}
              </span>
            </div>

            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 px-4 rounded-xl border border-[#2a4066] bg-[#14223b] text-[#e2e8f0] text-xs font-extrabold hover:bg-[#1b2e4f] transition-colors"
              >
                {lang === 'am' ? 'ካርዱን እይ' : 'Inspect Board'}
              </button>
              <button
                type="button"
                data-start="true"
                onClick={onPlayAgain}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-[#22d3ee] to-[#0284c7] text-[#04101d] text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-md hover:brightness-110 transition-all"
              >
                <RotateCcw size={15} />
                {lang === 'am' ? 'አዲስ ዙር ጀምር' : 'Next Round'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
