import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

/**
 * What the empty composer says: things this agent can actually do.
 *
 * "Ask Cinderpaw…" tells a stranger nothing about what to ask. Cycling through
 * real requests (a PDF, a form, a call) is the cheapest onboarding there is: it
 * costs no screen and no click, and nobody has to open Settings to find out.
 *
 * The look is from the HextaUI AI chat input (letters blur in, one after another,
 * and blur out in reverse). The letters are CSS animations with a delay each
 * (`.composer-letter` in globals.css): the browser runs them off the main
 * thread. They were framer-motion values driven from script, a style write per
 * letter per frame whenever the composer sat empty, 450 of them in 1.5 s on the
 * home screen (25 Sep), under every click made meanwhile. With reduced motion
 * it shows one example and stays.
 */
export const COMPOSER_EXAMPLES = [
  'Make me a short contract as a PDF',
  'Download the official form and fill it in',
  'Summarize the file I attach',
  'Plan my week around three deadlines',
  'Write a report and send it to my Telegram',
  'Find three sources and compare them',
];

const INTERVAL_MS = 3_200;
/** How long the letters take to leave: the last one starts after this many letters' worth of delay. */
const OUT_STAGGER_MS = 10;
const OUT_MS = 180;

export function ComposerPlaceholder({ active, fallback }: { active: boolean; fallback: string }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!active || reduced) return;
    let next: number | undefined;
    const id = setInterval(() => {
      setLeaving(true);
      const text = COMPOSER_EXAMPLES[index] ?? '';
      next = window.setTimeout(() => {
        setLeaving(false);
        setIndex((i) => (i + 1) % COMPOSER_EXAMPLES.length);
      }, OUT_MS + text.length * OUT_STAGGER_MS);
    }, INTERVAL_MS);
    return () => { clearInterval(id); window.clearTimeout(next); };
  }, [active, reduced, index]);

  // Focused, or reduced motion: a plain, still line.
  if (!active || reduced) {
    return <span className="truncate text-text-muted">{active ? COMPOSER_EXAMPLES[0] : fallback}</span>;
  }

  const letters = Array.from(COMPOSER_EXAMPLES[index]!);
  return (
    // Keyed on the example: a new line is new elements, so the animations start over.
    <span key={index} className="block truncate text-text-muted">
      {letters.map((ch, i) => (
        <span
          key={i}
          className={leaving ? 'composer-letter composer-letter-out' : 'composer-letter'}
          style={{ animationDelay: `${leaving ? (letters.length - 1 - i) * OUT_STAGGER_MS : i * 22}ms` }}
        >
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
    </span>
  );
}
