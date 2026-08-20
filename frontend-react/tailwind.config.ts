import type { Config } from 'tailwindcss';

/**
 * A theme token that also works with Tailwind's `/opacity` modifier.
 *
 * The tokens are hex strings in a CSS variable, and Tailwind cannot split a
 * hex out of a var into channels — so `bg-bg-surface/70` was compiling to a
 * colour the browser could not parse and every one of those surfaces was
 * rendering FULLY TRANSPARENT. Silently: no console error, nothing in the
 * build, just a panel that looked like the page behind it. Measured on the
 * sidebar, which reported `backgroundColor: rgba(0, 0, 0, 0)` while claiming
 * `bg-bg-elevated/80`; 26 call sites across the app had the same bug,
 * including the tool cards that appear over a voice call.
 *
 * `color-mix` does the split for us and leaves plain `var(--x)` usage in CSS
 * files untouched.
 */
const token = (name: string) =>
  `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Our semantic palette ──────────────────────────────────────────
        // Use these in app components: bg-bg-surface, text-text-muted, etc.
        'bg-primary':     token('bg-primary'),
        'bg-surface':     token('bg-surface'),
        'bg-elevated':    token('bg-elevated'),
        'bg-hover':       token('bg-hover'),
        'bg-active':      token('bg-active'),
        'border-subtle':  token('border-subtle'),
        'border-default': token('border-default'),
        'text-primary':   token('text-primary'),
        'text-secondary': token('text-secondary'),
        'text-muted':     token('text-muted'),
        'text-disabled':  token('text-disabled'),
        'brand':          token('brand'),
        'brand-hover':    token('brand-hover'),
        'brand-muted':    token('brand-muted'),
        'error':          token('error'),
        'success':        token('success'),
        'warning':        token('warning'),

        // ── shadcn aliases ────────────────────────────────────────────────
        // Use ONLY inside shadcn primitives. Do NOT use bg-accent/text-accent
        // in app code — use bg-brand/text-brand for the warm orange.
        background:  'var(--background)',
        foreground:  'var(--foreground)',
        primary:     { DEFAULT: 'var(--primary)',     foreground: 'var(--primary-foreground)' },
        secondary:   { DEFAULT: 'var(--secondary)',   foreground: 'var(--secondary-foreground)' },
        muted:       { DEFAULT: 'var(--muted)',       foreground: 'var(--muted-foreground)' },
        accent:      { DEFAULT: 'var(--accent)',      foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        card:        { DEFAULT: 'var(--card)',        foreground: 'var(--card-foreground)' },
        popover:     { DEFAULT: 'var(--popover)',     foreground: 'var(--popover-foreground)' },
        border:      'var(--border)',
        input:       'var(--input)',
        ring:        'var(--ring)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
