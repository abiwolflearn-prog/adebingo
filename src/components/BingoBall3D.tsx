import { motion } from 'motion/react';
import { getLetterForNumber } from '../game/rules';
import { BingoLetter } from '../types/bingo';

interface BingoBall3DProps {
  number: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  animateEntry?: boolean;
  reducedMotion?: boolean;
  isRecentHighlight?: boolean;
}

const BALL_STYLES: Record<
  BingoLetter,
  { gradient: string; textColor: string; ringColor: string; glow: string }
> = {
  B: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #67e8f9 30%, #0891b2 70%, #083344)',
    textColor: '#042f40',
    ringColor: '#cffafe',
    glow: '0 0 26px rgba(34, 211, 238, 0.45)',
  },
  I: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #fef08a 30%, #f59e0b 68%, #78350f)',
    textColor: '#451a03',
    ringColor: '#fef9c3',
    glow: '0 0 28px rgba(250, 204, 21, 0.48)',
  },
  N: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #5eead4 30%, #0d9488 70%, #042f2e)',
    textColor: '#042f2e',
    ringColor: '#ccfbf1',
    glow: '0 0 26px rgba(20, 184, 166, 0.45)',
  },
  G: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #93c5fd 30%, #2563eb 70%, #172554)',
    textColor: '#0f172a',
    ringColor: '#dbeafe',
    glow: '0 0 26px rgba(59, 130, 246, 0.45)',
  },
  O: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #e9d5ff 30%, #9333ea 70%, #3b0764)',
    textColor: '#2e1065',
    ringColor: '#f3e8ff',
    glow: '0 0 26px rgba(168, 85, 247, 0.45)',
  },
};

export function BingoBall3D({
  number,
  size = 'lg',
  animateEntry = true,
  reducedMotion = false,
  isRecentHighlight = false,
}: BingoBall3DProps) {
  const letter = getLetterForNumber(number);
  const style = BALL_STYLES[letter];

  const dimensions = {
    sm: 'w-9 h-9 text-xs border-2',
    md: 'w-12 h-12 text-sm border-[3px]',
    lg: 'w-24 h-24 text-3xl border-[5px]',
    xl: 'w-28 h-28 text-4xl border-[6px]',
  }[size];

  return (
    <motion.div
      key={number}
      initial={
        animateEntry && !reducedMotion
          ? { y: -28, scale: 0.65, rotate: -16, opacity: 0 }
          : { opacity: 1 }
      }
      animate={{ y: 0, scale: 1, rotate: 0, opacity: 1 }}
      transition={
        reducedMotion
          ? { duration: 0.1 }
          : { type: 'spring', stiffness: 230, damping: 14 }
      }
      style={{
        background: style.gradient,
        color: style.textColor,
        borderColor: style.ringColor,
        boxShadow: `inset -8px -10px 16px rgba(7, 13, 25, 0.45), ${
          size === 'lg' || size === 'xl' || isRecentHighlight
            ? style.glow
            : '0 6px 14px rgba(2, 6, 23, 0.45)'
        }`,
      }}
      className={`relative rounded-full flex flex-col items-center justify-center font-extrabold select-none ${dimensions} ${
        isRecentHighlight ? 'ring-2 ring-[#22d3ee] ring-offset-2 ring-offset-[#070d19]' : ''
      }`}
      aria-label={`Bingo ball ${letter} ${number}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2.5 w-1/3 h-1/4 rounded-full bg-white/60 blur-[1px] -rotate-12"
      />
      {(size === 'lg' || size === 'xl') && (
        <small className="text-xs font-extrabold tracking-widest uppercase leading-none opacity-85 mb-0.5">
          {letter}
        </small>
      )}
      <span className="leading-none tabular-nums font-['Outfit']">
        {size === 'sm' ? `${letter}${number}` : number}
      </span>
    </motion.div>
  );
}
