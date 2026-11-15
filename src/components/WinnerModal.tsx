import { useEffect, useRef, useCallback } from 'react';
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
  reducedMotion?: boolean;
  onPlayAgain: () => void;
  onClose: () => void;
}

const CELEBRATION_COLORS = [
  '#facc15', // Gold
  '#22d3ee', // Cyan
  '#34d399', // Emerald
  '#f59e0b', // Amber
  '#38bdf8', // Sky
  '#fde047', // Bright Yellow
  '#f472b6', // Pink Spark
  '#a78bfa', // Violet Spark
];

const CONFETTI_PARTICLES = Array.from({ length: 42 }, (_, idx) => {
  return {
    id: idx,
    left: `${(idx * 2.4 + 2) % 97}%`,
    driftX: (idx % 2 === 0 ? 1 : -1) * (18 + (idx % 5) * 12),
    color: CELEBRATION_COLORS[idx % CELEBRATION_COLORS.length],
    delay: (idx % 9) * 0.11,
    duration: 2.3 + (idx % 5) * 0.32,
    size: idx % 4 === 0 ? 11 : idx % 2 === 0 ? 8 : 6,
    rotate: (idx % 2 === 0 ? 1 : -1) * (200 + idx * 14),
    isCircle: idx % 5 === 0,
  };
});

const RADIAL_BURST_SPARKS = Array.from({ length: 24 }, (_, idx) => {
  const angleDeg = (idx / 24) * 360;
  const angleRad = (angleDeg * Math.PI) / 180;
  const distance = 125 + (idx % 3) * 48;
  return {
    id: idx,
    tx: Math.cos(angleRad) * distance,
    ty: Math.sin(angleRad) * distance,
    color: CELEBRATION_COLORS[idx % CELEBRATION_COLORS.length],
    size: idx % 2 === 0 ? 9 : 6,
    delay: (idx % 4) * 0.04,
  };
});

const BINGO_LETTERS = [
  { letter: 'B', bg: 'from-cyan-400 to-cyan-600', text: 'text-slate-950' },
  { letter: 'I', bg: 'from-yellow-300 to-amber-500', text: 'text-amber-950' },
  { letter: 'N', bg: 'from-teal-300 to-emerald-500', text: 'text-emerald-950' },
  { letter: 'G', bg: 'from-sky-400 to-blue-600', text: 'text-white' },
  { letter: 'O', bg: 'from-amber-300 to-yellow-500', text: 'text-amber-950' },
];

type ParticleShape = 'ribbon' | 'star' | 'spark' | 'diamond';

interface CanvasParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  drag: number;
  color: string;
  alpha: number;
  decay: number;
  size: number;
  rotation: number;
  vRot: number;
  tiltAngle: number;
  vTilt: number;
  shape: ParticleShape;
}

interface ShockwaveRing {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
  lineWidth: number;
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  spikes: number,
  outerRadius: number,
  innerRadius: number
) {
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outerRadius, cy + Math.sin(rot) * outerRadius);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerRadius, cy + Math.sin(rot) * innerRadius);
    rot += step;
  }
  ctx.lineTo(cx, cy - outerRadius);
  ctx.closePath();
  ctx.fill();
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
  reducedMotion = false,
  onPlayAgain,
  onClose,
}: WinnerModalProps) {
  const isShared = winners.length > 1;
  const totalPool = winners.reduce((s, w) => s + w.prizeEtb, 0) || prizeDemoEtb;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<CanvasParticle[]>([]);
  const ringsRef = useRef<ShockwaveRing[]>([]);

  const spawnExplosion = useCallback(
    (originXRatio: number, originYRatio: number, count = 85, mode: 'explosion' | 'cannon-left' | 'cannon-right' = 'explosion') => {
      const canvas = canvasRef.current;
      const width = canvas?.width || window.innerWidth || 800;
      const height = canvas?.height || window.innerHeight || 600;
      const ox = width * originXRatio;
      const oy = height * originYRatio;

      const shapes: ParticleShape[] = ['ribbon', 'star', 'spark', 'diamond'];

      if (mode === 'explosion') {
        ringsRef.current.push({
          x: ox,
          y: oy,
          radius: 12,
          maxRadius: Math.min(width, height) * 0.46,
          color: '#facc15',
          alpha: 0.9,
          lineWidth: 4,
        });
        ringsRef.current.push({
          x: ox,
          y: oy,
          radius: 4,
          maxRadius: Math.min(width, height) * 0.34,
          color: '#22d3ee',
          alpha: 0.75,
          lineWidth: 2.5,
        });
      }

      for (let i = 0; i < count; i++) {
        let angle = Math.random() * Math.PI * 2;
        let speed = 4 + Math.random() * 13;

        if (mode === 'cannon-left') {
          angle = -Math.PI / 3 + (Math.random() - 0.5) * 0.65;
          speed = 11 + Math.random() * 14;
        } else if (mode === 'cannon-right') {
          angle = (-2 * Math.PI) / 3 + (Math.random() - 0.5) * 0.65;
          speed = 11 + Math.random() * 14;
        }

        const shape = shapes[i % shapes.length];
        particlesRef.current.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - (mode === 'explosion' ? 2.2 : 1.5),
          gravity: shape === 'spark' ? 0.16 : 0.22,
          drag: shape === 'spark' ? 0.965 : 0.982,
          color: CELEBRATION_COLORS[i % CELEBRATION_COLORS.length],
          alpha: 1,
          decay: 0.006 + Math.random() * 0.007,
          size: shape === 'star' ? 7 + Math.random() * 5 : 6 + Math.random() * 6,
          rotation: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 0.22,
          tiltAngle: Math.random() * Math.PI * 2,
          vTilt: 0.08 + Math.random() * 0.14,
          shape,
        });
      }
    },
    []
  );

  const triggerFullCelebrationSequence = useCallback(() => {
    if (reducedMotion) return;
    // 1. Immediate center supernova explosion
    spawnExplosion(0.5, 0.42, 110, 'explosion');
    // 2. Dual side confetti cannons
    const t1 = window.setTimeout(() => {
      spawnExplosion(0.06, 0.86, 55, 'cannon-left');
      spawnExplosion(0.94, 0.86, 55, 'cannon-right');
    }, 240);
    // 3. Upper-left & upper-right sky firework starbursts
    const t2 = window.setTimeout(() => {
      spawnExplosion(0.24, 0.26, 70, 'explosion');
      spawnExplosion(0.76, 0.26, 70, 'explosion');
    }, 680);
    // 4. Finale gold & cyan crown burst
    const t3 = window.setTimeout(() => {
      spawnExplosion(0.5, 0.22, 85, 'explosion');
    }, 1250);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [reducedMotion, spawnExplosion]);

  useEffect(() => {
    if (!open || !winResult || !winningCard || reducedMotion) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    particlesRef.current = [];
    ringsRef.current = [];
    const clearInitialSequence = triggerFullCelebrationSequence();

    // Periodic celebratory firework bursts while modal stays open
    const periodicInterval = window.setInterval(() => {
      const rx = 0.2 + Math.random() * 0.6;
      const ry = 0.18 + Math.random() * 0.35;
      spawnExplosion(rx, ry, 65, 'explosion');
    }, 2700);

    let rafId = 0;
    const renderFrame = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update & draw shockwave rings
      for (let i = ringsRef.current.length - 1; i >= 0; i--) {
        const ring = ringsRef.current[i];
        ring.radius += (ring.maxRadius - ring.radius) * 0.09 + 2.5;
        ring.alpha *= 0.93;
        if (ring.alpha <= 0.02 || ring.radius >= ring.maxRadius) {
          ringsRef.current.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = ring.alpha;
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = ring.lineWidth;
        ctx.shadowColor = ring.color;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Update & draw particles
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.vx *= p.drag;
        p.vy = p.vy * p.drag + p.gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vRot;
        p.tiltAngle += p.vTilt;
        p.alpha -= p.decay;

        if (p.alpha <= 0.01 || p.y > canvas.height + 40) {
          particlesRef.current.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.shape === 'spark' || p.shape === 'star' ? 10 : 4;

        const scaleY = Math.cos(p.tiltAngle);
        ctx.scale(1, Math.max(0.25, Math.abs(scaleY)));

        if (p.shape === 'star') {
          drawStar(ctx, 0, 0, 5, p.size, p.size * 0.45);
        } else if (p.shape === 'spark') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.48, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.shape === 'diamond') {
          ctx.beginPath();
          ctx.moveTo(0, -p.size);
          ctx.lineTo(p.size * 0.65, 0);
          ctx.lineTo(0, p.size);
          ctx.lineTo(-p.size * 0.65, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(-p.size * 0.6, -p.size * 0.35, p.size * 1.2, p.size * 0.7);
        }

        ctx.restore();
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.clearInterval(periodicInterval);
      if (clearInitialSequence) clearInitialSequence();
      window.cancelAnimationFrame(rafId);
    };
  }, [open, winResult, winningCard, reducedMotion, spawnExplosion, triggerFullCelebrationSequence]);

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
          {/* Layer 1: Continuous Full-Screen Confetti Cascade */}
          {!reducedMotion && (
            <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden z-0">
              {CONFETTI_PARTICLES.map((p) => (
                <motion.span
                  key={p.id}
                  initial={{ y: -36, x: 0, opacity: 0, rotate: 0, scale: 0.6 }}
                  animate={{
                    y: ['-5vh', '96vh'],
                    x: [0, p.driftX, -p.driftX * 0.5, p.driftX * 0.3],
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
                    height: p.isCircle ? p.size : p.size * 1.45,
                    backgroundColor: p.color,
                    boxShadow: `0 0 10px ${p.color}`,
                  }}
                  className={`absolute top-0 ${p.isCircle ? 'rounded-full' : 'rounded-xs'}`}
                />
              ))}
            </div>
          )}

          {/* Layer 2: Motion Center Radial Particle Burst Overlay */}
          {!reducedMotion && (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-0 flex items-center justify-center overflow-hidden z-10"
            >
              {RADIAL_BURST_SPARKS.map((spark) => (
                <motion.span
                  key={spark.id}
                  initial={{ x: 0, y: 0, scale: 0.2, opacity: 1 }}
                  animate={{
                    x: [0, spark.tx],
                    y: [0, spark.ty],
                    scale: [0.3, 1.35, 0],
                    opacity: [1, 0.95, 0],
                  }}
                  transition={{
                    duration: 1.35,
                    delay: spark.delay,
                    repeat: Infinity,
                    repeatDelay: 1.4,
                    ease: 'easeOut',
                  }}
                  style={{
                    width: spark.size,
                    height: spark.size,
                    backgroundColor: spark.color,
                    boxShadow: `0 0 14px ${spark.color}`,
                  }}
                  className="absolute rounded-full"
                />
              ))}
            </div>
          )}

          {/* Layer 3: High-FPS Full-Screen HTML5 Canvas Particle Explosion & Fireworks */}
          {!reducedMotion && (
            <canvas
              ref={canvasRef}
              data-testid="winner-particle-canvas"
              aria-hidden="true"
              className="pointer-events-none fixed inset-0 z-20 w-full h-full"
            />
          )}

          {/* Layer 4: Winner Celebration Card */}
          <motion.div
            initial={{ scale: 0.78, y: 28, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 250, damping: 18 }}
            className="relative z-30 w-full max-w-md rounded-3xl bg-gradient-to-b from-[#13233f] via-[#0f1a2e] to-[#091221] border-2 border-[#facc15] p-6 shadow-[0_0_55px_rgba(250,204,21,0.35),0_24px_60px_rgba(0,0,0,0.8)] text-[#f1f5f9] max-h-[90vh] overflow-y-auto"
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

            {/* Gold Trophy Banner with Pulsing Halo Rings (Tap Trophy to Trigger Extra Particle Burst) */}
            <div
              onClick={() => spawnExplosion(0.5, 0.35, 95, 'explosion')}
              title={lang === 'am' ? 'ለተጨማሪ ርችት ይንኩ' : 'Tap for extra firework burst'}
              className="relative mx-auto w-20 h-20 flex items-center justify-center mb-3 cursor-pointer select-none"
            >
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

