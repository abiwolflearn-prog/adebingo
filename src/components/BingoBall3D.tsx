import { motion } from 'motion/react';
import { getLetterForNumber } from '../game/rules';
import { BingoLetter } from '../types/bingo';

export interface BingoBall3DProps {
  number: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  animate?: boolean;
  animateEntry?: boolean;
  reducedMotion?: boolean;
  isRecentHighlight?: boolean;
}

const BALL_STYLES: Record<
  BingoLetter,
  { gradient: string; textColor: string; ringColor: string; glow: string }
> = {
  B: {
    gradient: 'radial-gradient(circle at 30% 24%, #ffffff, #6ee7b7 26%, #159447 68%, #08743A)',
    textColor: '#ffffff',
    ringColor: '#A7F3D0',
    glow: '0 8px 22px rgba(21, 148, 71, 0.34)',
  },
  I: {
    gradient: 'radial-gradient(circle at 30% 24%, #ffffff, #fde68a 28%, #F5BD42 68%, #D99B20)',
    textColor: '#183326',
    ringColor: '#FDE68A',
    glow: '0 8px 22px rgba(245, 189, 66, 0.38)',
  },
  N: {
    gradient: 'radial-gradient(circle at 30% 24%, #ffffff, #fdba74 26%, #f97316 68%, #c2410c)',
    textColor: '#ffffff',
    ringColor: '#FED7AA',
    glow: '0 8px 22px rgba(249, 115, 22, 0.32)',
  },
  G: {
    gradient: 'radial-gradient(circle at 30% 24%, #ffffff, #93c5fd 26%, #2563eb 68%, #1d4ed8)',
    textColor: '#ffffff',
    ringColor: '#BFDBFE',
    glow: '0 8px 22px rgba(37, 99, 235, 0.32)',
  },
  O: {
    gradient: 'radial-gradient(circle at 30% 24%, #ffffff, #fda4af 26%, #e11d48 68%, #9f1239)',
    textColor: '#ffffff',
    ringColor: '#FECDD3',
    glow: '0 8px 22px rgba(225, 29, 72, 0.32)',
  },
};

export function BingoBall3D({
  number,
  size = 'lg',
  animate,
  animateEntry = true,
  reducedMotion = false,
  isRecentHighlight = false,
}: BingoBall3DProps) {
  const shouldAnimate = animate !== undefined ? animate : animateEntry && !reducedMotion;
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
        shouldAnimate
          ? { scale: 0.92, opacity: 0.7 }
          : { opacity: 1 }
      }
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{
        background: style.gradient,
        color: style.textColor,
        borderColor: style.ringColor,
        boxShadow: `inset -6px -8px 14px rgba(24, 51, 38, 0.22), ${
          size === 'lg' || size === 'xl' || isRecentHighlight
            ? style.glow
            : '0 4px 10px rgba(24, 51, 38, 0.14)'
        }`,
      }}
      className={`relative shrink-0 rounded-full flex flex-col items-center justify-center font-extrabold select-none ${dimensions} ${
        isRecentHighlight ? 'ring-2 ring-[#159447] ring-offset-2 ring-offset-[#FFF9ED]' : ''
      }`}
      aria-label={`Bingo ball ${letter} ${number}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2.5 w-1/3 h-1/4 rounded-full bg-white/70 blur-[1px] -rotate-12"
      />
      {(size === 'lg' || size === 'xl') && (
        <small className="text-xs font-extrabold tracking-widest uppercase leading-none opacity-90 mb-0.5 drop-shadow-xs">
          {letter}
        </small>
      )}
      <span className="leading-none tabular-nums font-['Outfit'] drop-shadow-xs">
        {size === 'sm' ? `${letter}${number}` : number}
      </span>
    </motion.div>
  );
}
