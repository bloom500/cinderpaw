import { cn } from '@/lib/utils';

/**
 * Text with a light travelling through it.
 *
 * Used where the honest answer is "this is taking a moment": a spinner says
 * something is happening, and a sentence that shimmers says the same thing
 * while also saying WHAT is happening ("Thinking…", "Cinderpaw is waking up").
 *
 * One element and a CSS gradient clipped to the text (`.shimmering-text` in
 * globals.css). It used to be a framer-motion span per letter, each animating
 * its colour from script on every frame, forever: "Cinderpaw is waking up" was
 * 22 animations, and 770 style writes in 1.2 s on the home screen (25 Sep),
 * while "Thinking…" ran exactly when a reply was streaming. Now the browser
 * moves the light itself, with no script per frame.
 */
type ShimmeringTextProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> & {
  text: string;
  /** Seconds for one pass of the light across the whole string. */
  duration?: number;
  color?: string;
  shimmeringColor?: string;
};

export function ShimmeringText({
  text,
  duration = 1.4,
  color = 'var(--text-muted)',
  shimmeringColor = 'var(--text-primary)',
  className,
  style,
  ...props
}: ShimmeringTextProps) {
  return (
    <span
      className={cn('shimmering-text', className)}
      style={{
        '--shimmer-base': color,
        '--shimmer-light': shimmeringColor,
        // One pass, then the pause the letter-by-letter version had between passes.
        '--shimmer-duration': `${duration + text.length * 0.05}s`,
        ...style,
      } as React.CSSProperties}
      {...props}
    >
      {text}
    </span>
  );
}
