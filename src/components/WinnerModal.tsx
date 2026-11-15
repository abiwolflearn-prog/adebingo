import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Sparkles, RotateCcw, CheckCircle2, Users, Crown } from 'lucide-react';
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

const CONFETTI_PARTICLES = Array.from({ length: 28 }, (_, idx) => {
  const colors = ['#facc15', '#22d3ee', '#34d399', '#f59e0b', '#38bdf8', '#fde047'];
  return {
    id: idx,
    left: `${(idx * 3.7 + 4) % 94}%`,
    color: colors[idx % colors.length],
    delay: (idx % 7) * 0.14,
    duration: 2.4 + (idx % 5) * 0.35,
    size: idx % 3 === 0 ? 10 : 7,
    rotate: (idx % 2 === 0 ? 1 : -1) * (160 + idx * 12),
  };
});

const BINGO_LETTERS = [
  { letter: 'B', bg: 'from-cyan-400 to-cyan-600', text: 'text-slate-950' },
  { letter: 'I', bg: 'from-yellow-300 to-amber-500', text: 'text-amber-950' },
  { letter: 'N', bg: 'from-teal-300 to-emerald-500', text: 'text-emerald-950' },
  { letter: 'G', bg: 'from-sky-400 to-blue-600', text: 'text-white' },
  { letter: 'O', bg: 'from-amber-300 to-yellow-500', text: 'text-amber-950' },
];

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
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#030712]/85 backdrop-blur-sm overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="winner-modal-title"
        >
          {/* Animated Confetti Cascade */}
          <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden z-0">
            {CONFETTI_PARTICLES.map((p) => (
              <motion.span
                key={p.id}
                initial={{ y: -40, opacity: 0, rotate: 0, scale: 0.6 }}
                animate={{
                  y: ['0vh', '92vh'],
                  opacity: [0, 1, 1, 0],
                  rotate: [0, p.rotate],
                  scale: [0.8, 1.15, 0.9],
                }}
                transition={{
                  duration: p.duration,
                  delay: p.delay,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
                style={{
                  left: p.left,
                  width: p.size,
                  height: p.size * 1.4,
                  backgroundColor: p.color,
                  boxShadow: `0 0 10px ${p.color}`,
                }}
                className="absolute top-0 rounded-xs"
              />
            ))}
          </div>

          <motion.div
            initial={{ scale: 0.78, y: 28, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 250, damping: 18 }}
            className="relative z-10 w-full max-w-md rounded-3xl bg-gradient-to-b from-[#13233f] via-[#0f1a2e] to-[#091221] border-2 border-[#facc15] p-6 shadow-[0_0_55px_rgba(250,204,21,0.35),0_24px_60px_rgba(0,0,0,0.8)] text-[#f1f5f9] max-h-[90vh] overflow-y-auto"
          >
            {/* Ambient Radial Gold & Cyan Aura */}
            <motion.div
              aria-hidden="true"
              animate={{ scale: [1, 1.12, 1], opacity: [0.25, 0.45, 0.25] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
              className="pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 w-56 h-32 rounded-full bg-gradient-to-r from-[#22d3ee]/30 via-[#facc15]/40 to-[#22d3ee]/30 blur-2xl"
            />

            {/* Staggered Animated B-I-N-G-O Celebration Ribbon */}
            <div className="flex items-center justify-center gap-1.5 mb-3">
              {BINGO_LETTERS.map((item, idx) => (
                <motion.span
                  key={item.letter}
                  initial={{ y: -18, scale: 0.4, opacity: 0 }}
                  animate={{ y: [0, -4, 0], scale: 1, opacity: 1 }}
                  transition={{
                    delay: idx * 0.07,
                    duration: 1.6,
                    repeat: Infinity,
                    repeatDelay: 0.6,
                  }}
                  className={`w-7 h-7 rounded-lg bg-gradient-to-br ${item.bg} ${item.text} font-['Outfit'] text-sm font-black flex items-center justify-center shadow-md border border-white/30`}
                >
                  {item.letter}
                </motion.span>
              ))}
            </div>

            {/* Gold Trophy Banner with Pulsing Halo Rings */}
            <div className="relative mx-auto w-20 h-20 flex items-center justify-center mb-3">
              <motion.span
                aria-hidden="true"
                animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
                className="absolute inset-0 rounded-2xl border-2 border-[#facc15]"
              />
              <motion.span
                aria-hidden="true"
                animate={{ rotate: 360 }}
                transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}
                className="absolute -inset-1.5 rounded-3xl border border-dashed border-[#22d3ee]/60"
              />
              <motion.div
                animate={{ rotate: [-5, 5, -5], scale: [1, 1.07, 1] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-[#fde047] via-[#facc15] to-[#f59e0b] flex items-center justify-center text-[#451a03] shadow-[0_10px_28px_rgba(250,204,21,0.5)]"
              >
                <Trophy size={34} />
              </motion.div>
            </div>

            <div className="text-center">
              <p className="text-xs font-extrabold tracking-widest uppercase text-[#22d3ee] flex items-center justify-center gap-1">
                <Sparkles size={14} className="animate-spin" />
                {lang === 'am' ? 'እንኳን ደስ አለዎት! BINGO!' : 'CONGRATULATIONS! BINGO!'}
                <Crown size={14} className="text-[#facc15]" />
              </p>
              <motion.h2
                id="winner-modal-title"
                initial={{ scale: 0.9 }}
                animate={{ scale: [1, 1.03, 1] }}
                transition={{ duration: 1.8, repeat: Infinity }}
                className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold text-white mt-1 drop-shadow-[0_2px_10px_rgba(250,204,21,0.3)]"
              >
                {isShared
                  ? lang === 'am'
                    ? `${winners.length} አሸናፊዎች (ሽልማት ተከፋፍሏል)!`
                    : `${winners.length} Simultaneous Winners!`
                  : lang === 'am'
                    ? 'ዙሩን አሸንፈዋል!'
                    : 'Round Winner Confirmed!'}
              </motion.h2>
              <p className="text-xs text-cyan-200 font-semibold mt-1">
                {lang === 'am'
                  ? `ካርድ #${winningCard.id} · ${winResult.patternLabelAm}`
                  : `Card #${winningCard.id} · ${winResult.patternLabelEn}`}
              </p>
            </div>

            {/* Stats Summary Strip */}
            <div className="grid grid-cols-3 gap-2 my-4 bg-[#091221] p-3 rounded-2xl border border-[#22d3ee]/30 text-center shadow-inner">
              <motion.div
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
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
              </motion.div>
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
                  {isShared ? `${totalPool.toFixed(0)} ETB` : `#${winningCard.id}`}
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
                      className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-lg bg-[#14223b] border border-slate-700/60"
                    >
                      <span className="truncate text-slate-200 font-bold">
                        {w.displayName} · {lang === 'am' ? 'ካርድ' : 'Card'} #{w.cardId}
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
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.12 }}
              className="my-2.5 max-w-[240px] mx-auto rounded-xl ring-2 ring-[#facc15]/60 shadow-[0_0_20px_rgba(250,204,21,0.2)]"
            >
              <BingoCardView
                card={winningCard}
                calledNumbers={calledNumbers}
                markedNumbers={markedNumbers}
                compact
                lang={lang}
              />
            </motion.div>

            <div className="flex items-center gap-2 text-[11px] text-[#cbd5e1] bg-[#14223b] border border-[#1e3252] px-3 py-2 rounded-xl mb-4">
              <CheckCircle2 size={16} className="text-[#22d3ee] shrink-0" />
              <span>
                {lang === 'am'
                  ? 'ቁጥር መጥራት ቆሟል! ሽልማቱ ወደ አሸናፊዎች ሂሳብ ተጨምሯል። አዲስ ዙር ወዲያውኑ ይጀምራል።'
                  : 'Number calling stopped! Prizes credited to winner balances. Next round starts automatically.'}
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
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-[0_6px_20px_rgba(250,204,21,0.35)] hover:brightness-110 transition-all"
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
