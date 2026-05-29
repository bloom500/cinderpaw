import { cn } from '@/lib/utils';
import { useUI, type ThemePref } from '@/stores/ui';

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'dark',   label: 'Dark' },
  { value: 'light',  label: 'Light' },
  { value: 'system', label: 'System' },
];

export function AppearanceTab() {
  const theme    = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Theme</p>
          <p className="text-xs text-text-muted mt-0.5">Pick how Feral looks</p>
        </div>
        <div className="flex rounded-md border border-border-subtle overflow-hidden">
          {THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                theme === value
                  ? 'bg-bg-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
