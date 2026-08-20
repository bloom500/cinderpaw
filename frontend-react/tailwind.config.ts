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
      /**
       * ── The type scale ───────────────────────────────────────────────────
       * Nine steps, and nothing between them. Before this, the app used
       * 8, 9, 10, 10.5, 11, 12, 12.5, 13, 15 and 32 px as one-off arbitrary
       * values on top of Tailwind's own six — sixteen sizes, each chosen where
       * it was needed and never compared with its neighbours. That is what
       * "looks unfinished" actually is, most of the time: not the wrong size
       * anywhere in particular, just no agreement anywhere at all.
       *
       * Line heights are baked in so a size cannot be used without its rhythm,
       * and the large steps carry negative tracking because display text set
       * at default spacing reads loose.
       */
      fontSize: {
        micro:  ['10px',   { lineHeight: '13px', letterSpacing: '0.02em' }],
        '2xs':  ['11.5px', { lineHeight: '16px' }],
        xs:     ['12.5px', { lineHeight: '18px' }],
        sm:     ['13.5px', { lineHeight: '20px' }],
        base:   ['15px',   { lineHeight: '23px' }],
        lg:     ['17px',   { lineHeight: '26px', letterSpacing: '-0.01em' }],
        xl:     ['20px',   { lineHeight: '28px', letterSpacing: '-0.015em' }],
        '2xl':  ['24px',   { lineHeight: '30px', letterSpacing: '-0.02em' }],
        '3xl':  ['32px',   { lineHeight: '38px', letterSpacing: '-0.025em' }],
      },

      /**
       * ── Two radii ────────────────────────────────────────────────────────
       * `sm`/`md`/`lg` all resolve to the control radius and `xl`/`2xl`/`3xl`
       * to the panel one, so the six values already written across the app
       * collapse into the two the design actually has. Five different corner
       * radii on one screen is a thing the eye notices without being able to
       * say why.
       */
      borderRadius: {
        sm:    '8px',
        md:    '10px',
        lg:    '10px',
        xl:    '18px',
        '2xl': '18px',
        '3xl': '18px',
      },

      /**
       * ── Elevation ────────────────────────────────────────────────────────
       * Dark UIs get depth from a light edge above and a soft shadow below,
       * not from a black blur — on a near-black ground a black shadow is
       * invisible and the surface reads as flat paint.
       */
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.30)',
        DEFAULT: '0 2px 6px rgba(0,0,0,0.32)',
        md: '0 6px 16px rgba(0,0,0,0.34)',
        lg: '0 14px 34px rgba(0,0,0,0.38)',
        xl: '0 24px 60px rgba(0,0,0,0.44)',
        '2xl': '0 32px 80px rgba(0,0,0,0.50)',
      },

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
      // (the shadcn `--radius` mapping used to live here and silently won,
      // being the later key; the two-radius scale above replaces it)
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
