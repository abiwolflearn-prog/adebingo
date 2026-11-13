import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Sparkles, RotateCcw, CheckCircle2 } from 'lucide-react';
import { BingoCard, Language, WinResult } from '../types/bingo';
import { BingoCardView } from './BingoCardView';

interface WinnerModalProps {
  open: boolean;
  winResult: WinResult | null;
  winningCard: BingoCard | null;
  calledNumbers: number[];
  markedNumbers: number[];
  prizeDemoEtb: number;
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
  lang,
  onPlayAgain,
  onClose,
}: WinnerModalProps) {
  return (
    <AnimatePresence>
      {open && winResult && winningCard && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#072919]/75"
          role="dialog"
          aria-modal="true"
          aria-labelledby="winner-modal-title"
        >
          <motion.div
            initial={{ scale: 0.85, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 20 }}
            className="relative w-full max-w-md rounded-3xl bg-white border-2 border-[#f2c24b] p-6 shadow-2xl text-[#193b2b] max-h-[90vh] overflow-y-auto"
          >
            {/* Gold Trophy Banner */}
            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-[#ffe18b] to-[#eab308] flex items-center justify-center text-[#5c4108] shadow-md mb-3">
              <Trophy size={34} />
            </div>

            <div className="text-center">
              <p className="text-xs font-extrabold tracking-widest uppercase text-[#12a566] flex items-center justify-center gap-1">
                <Sparkles size={14} />
                {lang === 'am' ? 'እንኳን ደስ አለዎት! BINGO!' : 'CONGRATULATIONS! BINGO!'}
              </p>
              <h2
                id="winner-modal-title"
                className="font-['Outfit'] text-3xl font-extrabold text-[#11422b] mt-1"
              >
                {lang === 'am' ? 'ዙሩን አሸንፈዋል!' : 'You Won the Round!'}
              </h2>
              <p className="text-xs text-[#647a6d] mt-1">
                {lang === 'am'
                  ? `ካርድ #${winningCard.id} · ${winResult.patternLabelAm}`
                  : `Card #${winningCard.id} · ${winResult.patternLabelEn}`}
              </p>
            </div>

            {/* Stats Summary Strip */}
            <div className="grid grid-cols-3 gap-2 my-4 bg-[#f2f9f4] p-3 rounded-2xl border border-[#dcece1] text-center">
              <div>
                <small className="block text-[10px] font-bold text-[#6e8477] uppercase">
                  {lang === 'am' ? 'የሙከራ ሽልማት' : 'DEMO PRIZE'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-[#087e50] tabular-nums">
                  +{prizeDemoEtb} ETB
                </b>
              </div>
              <div>
                <small className="block text-[10px] font-bold text-[#6e8477] uppercase">
                  {lang === 'am' ? 'የተጠሩ ቁጥሮች' : 'CALLS'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-[#193b2b] tabular-nums">
                  {calledNumbers.length}/75
                </b>
              </div>
              <div>
                <small className="block text-[10px] font-bold text-[#6e8477] uppercase">
                  {lang === 'am' ? 'አሸናፊ ካርድ' : 'CARD ID'}
                </small>
                <b className="font-['Outfit'] text-lg font-extrabold text-[#d49a19] tabular-nums">
                  #{winningCard.id}
                </b>
              </div>
            </div>

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

            <div className="flex items-center gap-2 text-[11px] text-[#4b6757] bg-[#eef7f0] px-3 py-2 rounded-xl mb-4">
              <CheckCircle2 size={16} className="text-[#087e50] shrink-0" />
              <span>
                {lang === 'am'
                  ? 'የሙከራ ሽልማቱ ወደ ሙከራ ቦርሳዎ (Demo Wallet) ተጨምሯል።'
                  : 'Demo prize credits have been added to your Demo Wallet ledger.'}
              </span>
            </div>

            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 px-4 rounded-xl border border-[#d5e4da] bg-white text-[#355644] text-xs font-extrabold hover:bg-[#f4f9f6] transition-colors"
              >
                {lang === 'am' ? 'ካርዱን እይ' : 'Inspect Board'}
              </button>
              <button
                type="button"
                data-start="true"
                onClick={onPlayAgain}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-md hover:brightness-105 transition-all"
              >
                <RotateCcw size={15} />
                {lang === 'am' ? 'አዲስ ዙር ጀምር' : 'Play Again'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
