import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import logoUrl from '@/assets/logo.svg';
import logoSvg from '@/assets/logo.svg?raw';
import { MOTION, SLOW, spring } from '@/lib/motion';

const DOTS = spring(MOTION.slow * 2, 0.35);

/**
 * What the Artifacts panel shows while a page, a poster or code is being
 * written, instead of the code itself (Darius, 14 Nov): the logo breaks into
 * dots on its own outline, the dots play (a spinning ring, a wave, a grid)
 * and come back together as the logo. Loops until the artifact is ready.
 */

const N = 32;
const VIEW = 256;
const STEP_MS = 1100;
type P = { x: number; y: number };

/** N points spread evenly along the logo's outlines; a circle where SVG lengths are not measurable (tests). */
function outlinePoints(): P[] {
  try {
    const doc = new DOMParser().parseFromString(logoSvg, 'image/svg+xml');
    const paths = [...doc.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '').filter(Boolean);
    const ns = 'http://www.w3.org/2000/svg';
    const els = paths.map((d) => { const el = document.createElementNS(ns, 'path'); el.setAttribute('d', d); return el; });
    const lengths = els.map((el) => el.getTotalLength());
    const total = lengths.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new Error('no length');
    const out: P[] = [];
    for (let i = 0; i < N; i++) {
      let at = (i / N) * total;
      let k = 0;
      while (k < els.length - 1 && at > lengths[k]!) { at -= lengths[k]!; k++; }
      const pt = els[k]!.getPointAtLength(at);
      out.push({ x: pt.x, y: pt.y });
    }
    return out;
  } catch {
    return ring(80);
  }
}

function ring(r: number): P[] {
  return Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    return { x: VIEW / 2 + Math.cos(a) * r, y: VIEW / 2 + Math.sin(a) * r };
  });
}
const wave = (): P[] => Array.from({ length: N }, (_, i) => ({ x: 36 + (i / (N - 1)) * 184, y: VIEW / 2 + Math.sin(i * 0.55) * 34 }));
const grid = (): P[] => Array.from({ length: N }, (_, i) => ({ x: 58 + (i % 8) * 20, y: 88 + Math.floor(i / 8) * 26 }));

export function BuildingMark({ size = 132 }: { size?: number }) {
  const still = useReducedMotion();
  const shapes = useMemo(() => {
    const logo = outlinePoints();
    // logo (image shown) → dots on the outline → ring → wave → grid → back.
    return [logo, logo, ring(78), wave(), grid(), logo];
  }, []);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setStep((s) => (s + 1) % shapes.length), STEP_MS);
    return () => clearInterval(id);
  }, [still, shapes.length]);

  const showLogo = still || step === 0;
  const dots = shapes[step]!;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden className="overflow-visible text-brand">
      <motion.image
        href={logoUrl}
        x={0} y={0} width={VIEW} height={VIEW}
        initial={false}
        animate={{ opacity: showLogo ? 1 : 0, scale: showLogo ? 1 : 0.9 }}
        transition={still ? { duration: 0 } : SLOW}
        style={{ transformOrigin: 'center' }}
      />
      {!still && (
        <motion.g
          animate={{ rotate: step === 2 ? 180 : 0 }}
          transition={{ duration: STEP_MS / 1000 }}
          style={{ transformOrigin: '128px 128px' }}
        >
          {dots.map((p, i) => (
            <motion.circle
              key={i}
              fill="currentColor"
              initial={false}
              animate={{ cx: p.x, cy: p.y, r: showLogo ? 0 : step === 4 ? 6 : 7, opacity: showLogo ? 0 : 1 }}
              // The app's own spring, slower and with bounce: the dots are the one
              // place meant to feel playful (Darius, 14 Nov: "jucause").
              transition={{ ...DOTS, delay: i * 0.012 }}
            />
          ))}
        </motion.g>
      )}
    </svg>
  );
}
