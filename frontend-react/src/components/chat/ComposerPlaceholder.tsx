import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/**
 * What the empty composer says: things this agent can actually do.
 *
 * "Ask Cinderpaw…" tells a stranger nothing about what to ask. Cycling through
 * real requests (a PDF, a form, a call) is the cheapest onboarding there is: it
 * costs no screen and no click, and nobody has to open Settings to find out.
 *
 * The look is from the HextaUI AI chat input (letters blur in, one after another),
 * rebuilt on this app's framer-motion rather than adding `motion`, which is the
 * same library a second time. With reduced motion it shows one example and stays.
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

export function ComposerPlaceholder({ active, fallback }: { active: boolean; fallback: string }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % COMPOSER_EXAMPLES.length), INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, reduced]);

  // Focused, or reduced motion: a plain, still line.
  if (!active || reduced) {
    return <span className="truncate text-text-muted">{active ? COMPOSER_EXAMPLES[0] : fallback}</span>;
  }

  const text = COMPOSER_EXAMPLES[index]!;
  return (
    <AnimatePresence mode="wait">
      <motion.span
        key={index}
        className="block truncate text-text-muted"
        initial="hidden"
        animate="shown"
        exit="gone"
        variants={{ shown: { transition: { staggerChildren: 0.022 } }, gone: { transition: { staggerChildren: 0.01, staggerDirection: -1 } } }}
      >
        {Array.from(text).map((ch, i) => (
          <motion.span
            key={i}
            className="inline-block"
            variants={{
              hidden: { opacity: 0, filter: 'blur(8px)', y: 6 },
              shown: { opacity: 1, filter: 'blur(0px)', y: 0, transition: { duration: 0.28 } },
              gone: { opacity: 0, filter: 'blur(8px)', y: -6, transition: { duration: 0.18 } },
            }}
          >
            {ch === ' ' ? ' ' : ch}
          </motion.span>
        ))}
      </motion.span>
    </AnimatePresence>
  );
}
