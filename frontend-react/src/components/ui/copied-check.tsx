import { motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { FAST } from '@/lib/motion';

/**
 * The tick that says "copied".
 *
 * Copying is the most repeated small success in the app and it used to be a
 * plain icon swap, drawn four different ways. One component, so it looks the
 * same everywhere. It grows in and stops, no more: Apple's motion guide says to
 * avoid motion on interactions that happen often, so the six sparks that burst
 * around it from 23 Sep to 29 Oct are gone, and so is the spring that swung it
 * 26% past its size with a -20 deg twist. Under reduced motion it just shows.
 */
export function CopiedCheck({ size = 14 }: { size?: number }) {
  const reduced = useReducedMotion();
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <motion.span className="inline-flex" initial={reduced ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={FAST}>
        <Check size={size} />
      </motion.span>
    </span>
  );
}
