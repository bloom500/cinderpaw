import { motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';

/**
 * The tick that says "copied", with a small burst of sparks around it.
 *
 * Copying is the most repeated small success in the app and it used to be a
 * plain icon swap, drawn four different ways. One component, so it looks the
 * same everywhere, and a reward the size of the action: six sparks, 450 ms,
 * gone. Under reduced motion only the tick shows.
 */
const SPARKS = 6;

export function CopiedCheck({ size = 14 }: { size?: number }) {
  const reduced = useReducedMotion();
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <motion.span
        className="inline-flex"
        initial={reduced ? false : { scale: 0.4, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 520, damping: 18 }}
      >
        <Check size={size} />
      </motion.span>
      {!reduced &&
        Array.from({ length: SPARKS }, (_, i) => {
          const a = (i / SPARKS) * Math.PI * 2 - Math.PI / 2;
          const d = size * 1.1;
          return (
            <motion.span
              key={i}
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 size-[3px] rotate-45 bg-brand"
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{ x: Math.cos(a) * d, y: Math.sin(a) * d, opacity: 0, scale: 0.3 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
            />
          );
        })}
    </span>
  );
}
