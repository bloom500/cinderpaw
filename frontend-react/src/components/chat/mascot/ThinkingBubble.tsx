/**
 * ThinkingBubble — pixel-art speech bubble for the mascot.
 *
 * Appears next to the mascot when it's been in the `thinking` state
 * for a while. Shows three animated dots + a piece of text that
 * rotates through a small list of friendly phrases. The bubble
 * itself is rendered as a CSS box with a pixel tail, deliberately
 * "8-bit-ish" without going full SVG-pixel-perfect (the mascot is
 * 16×16; the bubble is text-sized).
 *
 * Why a component, not embedded in the mascot canvas: the bubble
 * text is reactive (rotates, fades), needs to be localizable, and
 * benefits from real DOM text (selectable, accessible, screen-readable).
 *
 * The mascot + bubble pair is wrapped in `MascotPerch` so the bubble
 * moves with the mascot when it runs.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

/** Pool of phrases the bubble cycles through while thinking. */
const THINKING_PHRASES = [
  'Almost ready, boss',
  'Hmm...',
  'Let me see...',
  'On it!',
  'Working on it...',
  'Hold on...',
  'Just a sec',
  'Be right back',
  'Crunching numbers...',
] as const;

const ROTATE_MS = 3200;   // how long each phrase stays before rotating
const SHOW_AFTER_MS = 1800; // show bubble after mascot has been thinking this long

interface ThinkingBubbleProps {
  /** Whether the bubble should be active. Pass the current mascot state. */
  active: boolean;
}

export function ThinkingBubble({ active }: ThinkingBubbleProps) {
  const [visible, setVisible] = useState(false);
  const [phraseIdx, setPhraseIdx] = useState(0);

  // Show after a delay, then rotate phrases while active.
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const showTimer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(showTimer);
  }, [active]);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="bubble"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 4, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className={cn(
            'absolute -top-9 left-full ml-2 z-20',
            'whitespace-nowrap pointer-events-none select-none',
            'px-2.5 py-1.5 rounded-md',
            'bg-bg-elevated border border-border-default',
            'text-[11px] text-text-primary',
            'shadow-sm',
            // Pixel-art tail: small triangle on the bottom-left
            'before:absolute before:-bottom-1.5 before:left-3',
            'before:w-2 before:h-2 before:rotate-45',
            'before:bg-bg-elevated before:border-r before:border-b before:border-border-default',
          )}
        >
          <BubbleDots />
          <span className="ml-1.5">{THINKING_PHRASES[phraseIdx]}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Three dots that bounce in sequence. Pure CSS animation. */
function BubbleDots() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-end gap-[2px] align-middle"
      style={{ height: '10px' }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-[3px] bg-text-muted rounded-sm"
          style={{
            height: '3px',
            animation: `bubbleDot 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes bubbleDot {
          0%, 60%, 100% { height: 3px; }
          30%           { height: 7px; }
        }
      `}</style>
    </span>
  );
}
