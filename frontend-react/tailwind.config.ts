import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Our semantic palette ──────────────────────────────────────────
        // Use these in app components: bg-bg-surface, text-text-muted, etc.
        'bg-primary':     'var(--bg-primary)',
        'bg-surface':     'var(--bg-surface)',
        'bg-elevated':    'var(--bg-elevated)',
        'bg-hover':       'var(--bg-hover)',
        'bg-active':      'var(--bg-active)',
        'border-subtle':  'var(--border-subtle)',
        'border-default': 'var(--border-default)',
        'text-primary':   'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted':     'var(--text-muted)',
        'text-disabled':  'var(--text-disabled)',
        'brand':          'var(--brand)',
        'brand-hover':    'var(--brand-hover)',
        'brand-muted':    'var(--brand-muted)',
        'error':          'var(--error)',
        'success':        'var(--success)',
        'warning':        'var(--warning)',

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
