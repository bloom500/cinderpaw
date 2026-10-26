import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BLUR_RATIO, DEFAULT_ROUNDNESS, HEIGHT, SPRING } from '@/components/ui/sileo/constants';
import { cn } from '@/lib/utils';

/** How long the liquid takes to fade once a `settle` card has poured in. */
const FADE_MS = 300;

/** Sileo's two merging shapes, adapted for a responsive card. The vendored
 * toast's button root cannot contain our buttons/links. Only the backdrop is
 * filtered: text stays sharp, controls stay semantic, and content keeps its
 * natural height (including evidence/error messages and resized windows).
 * Based on hiaaryan/sileo (MIT, Aaryan); see ../ui/sileo/NOTICE.md.
 *
 * `bare` + `settle` is for a child that is a card already (its own surface and
 * radius): no frame of ours, and the liquid only while it enters, so the card
 * is exactly itself once it has arrived and nothing is filtered after. */
export function GooeyCard({ children, className, bare = false, settle = false }: {
  children: ReactNode;
  className?: string;
  bare?: boolean;
  settle?: boolean;
}) {
  const reduced = useReducedMotion();
  const id = `gooey-card-${useId().replace(/:/g, '')}`;
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // `settle`: pour, then fade the liquid out (gone at once, a glass card jumped
  // from the opaque fill to its own see-through one), then drop the filter.
  const [phase, setPhase] = useState<'pour' | 'fade' | 'done'>('pour');
  // On time, not on the spring's end: a card that keeps growing (a tool row
  // every few hundred ms) restarted the spring before it ended and kept the
  // filter for the whole reply, 11 long frames in 2.5 s (26 Oct).
  useEffect(() => {
    if (!settle || reduced) return;
    const pour = (SPRING.duration + 0.08) * 1000;
    const fade = window.setTimeout(() => setPhase('fade'), pour);
    const done = window.setTimeout(() => setPhase('done'), pour + FADE_MS);
    return () => { window.clearTimeout(fade); window.clearTimeout(done); };
  }, [settle, reduced]);

  useLayoutEffect(() => {
    const el = content.current;
    if (!el || reduced) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((prev) => prev.width === width && prev.height === height ? prev : { width, height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduced]);

  const measured = size.width > 0 && size.height > 0;
  const blur = DEFAULT_ROUNDNESS * BLUR_RATIO;
  return (
    <div
      data-gooey-card
      data-reduced-motion={!!reduced}
      className={cn('relative isolate [--gooey-fill:rgb(54,48,43)] [[data-theme=light]_&]:[--gooey-fill:rgb(251,247,241)]', className)}
    >
      {!reduced && phase !== 'done' && (
        <motion.svg aria-hidden="true" focusable="false" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          width={size.width} height={size.height}
          initial={false} animate={{ opacity: phase === 'fade' ? 0 : 1 }} transition={{ duration: FADE_MS / 1000 }}>
          <defs>
            <filter id={id} filterUnits="userSpaceOnUse" x={-blur * 2} y={-blur * 2}
              width={size.width + blur * 4} height={size.height + blur * 4} colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blur" />
              <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10" result="goo" />
              <feComposite in="SourceGraphic" in2="goo" operator="atop" />
            </filter>
          </defs>
          {measured && <g filter={`url(#${id})`} fill="var(--gooey-fill)">
            <motion.rect rx={DEFAULT_ROUNDNESS} initial={{ width: Math.min(180, size.width), height: HEIGHT }}
              animate={{ width: size.width, height: Math.min(size.height, HEIGHT + 4) }} transition={SPRING} />
            <motion.rect y={HEIGHT - 8} width={size.width} rx={DEFAULT_ROUNDNESS}
              initial={{ height: 0, opacity: 0 }} animate={{ height: Math.max(0, size.height - HEIGHT + 8), opacity: 1 }}
              transition={{ ...SPRING, delay: 0.08 }} />
          </g>}
        </motion.svg>
      )}
      <motion.div ref={content}
        initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : { ...SPRING, delay: 0.12 }}
        className={cn(bare ? 'relative' : 'relative rounded-2xl border border-border-default px-3 py-2.5',
          !bare && (reduced || !measured) && 'bg-(--gooey-fill)')}>
        {children}
      </motion.div>
    </div>
  );
}
