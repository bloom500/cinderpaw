import { cn } from '@/lib/utils';
import { useUI, type ThemePref } from '@/stores/ui';
import { useEffect, useState } from 'react';
import { tauri } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';
import { useSettings } from '@/stores/settings';

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

  // Glass is the see-through window material over the desktop; Solid paints
  // the app on its own ground, the way the call screen already is. Both are
  // kept so the two can be lived with side by side before one is chosen.
  const [solid, setSolid] = useState<boolean | null>(null);
  useEffect(() => { void tauri.settings.get().then((s) => setSolid(Boolean(s.window_solid))).catch(() => setSolid(false)); }, []);
  const pickSolid = (next: boolean) => {
    const was = solid;
    setSolid(next);
    tauri.raw
      .setWindowSolid(next)
      // The Settings pages save their whole loaded object back to disk; left
      // with the old value, the next Save on any tab put the old background
      // back.
      .then(() => useSettings.setState((st) => (st.settings ? { settings: { ...st.settings, window_solid: next } } : {})))
      .catch((err) => {
        setSolid(was);
        useNotifications.getState().push('error', 'Could not change the background', String(err));
      });
  };

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
          <p className="text-sm font-medium text-text-primary">Background</p>
          <p className="text-xs text-text-muted mt-0.5">Glass shows your desktop through the window; Solid does not</p>
        </div>
        <div className="flex rounded-md border border-border-subtle overflow-hidden">
          {([['Glass', false], ['Solid', true]] as const).map(([label, value]) => (
            <button
              key={label}
              type="button"
              disabled={solid === null}
              onClick={() => pickSolid(value)}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                solid === value
                  ? 'bg-bg-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Theme</p>
          <p className="text-xs text-text-muted mt-0.5">Pick how Cinderpaw looks</p>
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
