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
  { gradient: string; textColor: string; ringColor: string }
> = {
  B: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #b4f4cc 28%, #15a865 68%, #075f39)',
    textColor: '#07472b',
    ringColor: '#ffffff',
  },
  I: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #ffebad 28%, #f2c24b 65%, #c9821d)',
    textColor: '#634c1b',
    ringColor: '#ffffff',
  },
  N: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #bbf4ea 28%, #149981 68%, #085749)',
    textColor: '#07483d',
    ringColor: '#ffffff',
  },
  G: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #c8e6ff 28%, #2e86de 68%, #164678)',
    textColor: '#10375e',
    ringColor: '#ffffff',
  },
  O: {
    gradient: 'radial-gradient(circle at 30% 22%, #ffffff, #f5d6ff 28%, #9b59b6 68%, #5b2c6f)',
    textColor: '#4a235a',
    ringColor: '#ffffff',
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
    lg: 'w-24 h-24 text-3xl border-[6px]',
    xl: 'w-28 h-28 text-4xl border-[7px]',
  }[size];

  return (
    <motion.div
      key={number}
      initial={
        animateEntry && !reducedMotion
          ? { y: -32, scale: 0.65, rotate: -18, opacity: 0 }
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
      }}
      className={`relative rounded-full flex flex-col items-center justify-center font-extrabold select-none shadow-[inset_-8px_-10px_16px_rgba(20,60,35,0.28),0_12px_24px_rgba(8,80,48,0.25)] ${dimensions} ${
        isRecentHighlight ? 'ring-2 ring-[#0c965b] ring-offset-2' : ''
      }`}
      aria-label={`Bingo ball ${letter} ${number}`}
    >
      {/* Inner glossy reflection */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2.5 w-1/3 h-1/4 rounded-full bg-white/55 blur-[1px] -rotate-12"
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
