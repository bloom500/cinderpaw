import { motion, type HTMLMotionProps } from 'framer-motion';

/**
 * Text with a light travelling through it, letter by letter.
 *
 * Adapted from Animate UI's `texts/shimmering` primitive (MIT). Taken as a
 * file rather than as a dependency: it is forty lines, it needs nothing we do
 * not already have, and a package would have brought its own copy of motion.
 * The only change is the import — Animate UI ships against `motion/react`, and
 * this project is on `framer-motion` v12, which is the same library under its
 * previous name.
 *
 * Used where the honest answer is "this is taking a moment": a spinner says
 * something is happening, and a sentence that shimmers says the same thing
 * while also saying WHAT is happening.
 */

type ShimmeringTextProps = Omit<HTMLMotionProps<'span'>, 'children'> & {
  text: string;
  /** Seconds for one pass of the light across the whole string. */
  duration?: number;
  color?: string;
  shimmeringColor?: string;
};

export function ShimmeringText({
  text,
  duration = 1.4,
  transition,
  color = 'var(--text-muted)',
  shimmeringColor = 'var(--text-primary)',
  ...props
}: ShimmeringTextProps) {
  return (
    <motion.span
      style={{
        '--shimmering-color': shimmeringColor,
        '--color': color,
        color: 'var(--color)',
        position: 'relative',
        display: 'inline-block',
      } as React.CSSProperties}
      {...props}
    >
      {text.split('').map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
          initial={{ color: 'var(--color)' }}
          animate={{ color: ['var(--color)', 'var(--shimmering-color)', 'var(--color)'] }}
          transition={{
            duration,
            repeat: Infinity,
            repeatType: 'loop',
            repeatDelay: text.length * 0.05,
            delay: (i * duration) / text.length,
            ease: 'easeInOut',
            ...transition,
          }}
        >
          {char}
        </motion.span>
      ))}
    </motion.span>
  );
}
