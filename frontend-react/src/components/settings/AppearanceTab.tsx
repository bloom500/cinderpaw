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
  const mascotEnabled    = useUI((s) => s.mascotEnabled);
  const setMascotEnabled = useUI((s) => s.setMascotEnabled);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Mascot</p>
          <p className="text-xs text-text-muted mt-0.5">
            The pixel critter that lives on the typing bar
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={mascotEnabled}
          aria-label="Toggle mascot"
          onClick={() => setMascotEnabled(!mascotEnabled)}
          className={cn(
            'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
            mascotEnabled ? 'bg-brand hover:bg-brand-hover' : 'bg-border-default hover:bg-bg-hover',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
              mascotEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
            )}
          />
        </button>
      </div>

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
