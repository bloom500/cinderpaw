import { cn } from '@/lib/utils';
import { SYSTEM_FONT, useUI, type ChatFont, type ThemePref } from '@/stores/ui';
import { useEffect, useState } from 'react';
import { tauri } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';
import { useSettings } from '@/stores/settings';

/**
 * Settings > Appearance (spec 7.4, canvas "Settings: appearance"): theme cards
 * with a small picture of each, the chat font, the window background.
 */

/** The two grounds as they really look, whatever theme the app is in now. */
const PAPER = { ground: '#F6EFE6', side: '#F1E8DD', line: '#E4D6C8', ink: '#2F2A26', faint: '#D9C8BE', bubble: '#F2DDCC' };
const CHARCOAL = { ground: '#2F2A26', side: '#28231F', line: '#4A413A', ink: '#F6EFE6', faint: '#6B5E54', bubble: '#4A3A30' };
type Ground = typeof PAPER;

/** A thumbnail of the app: the sidebar, a title, two lines, a reply. */
function Mini({ g, whole = true }: { g: Ground; whole?: boolean }) {
  return (
    <span className="flex flex-1 overflow-hidden" style={{ background: g.ground }}>
      {whole && <span className="w-11 shrink-0" style={{ background: g.side, borderRight: `1px solid ${g.line}` }} />}
      <span className="flex flex-1 flex-col gap-[7px] px-3 py-3.5">
        <span className="h-[7px] w-3/5 rounded" style={{ background: g.ink }} />
        <span className="h-[5px] w-5/6 rounded-sm" style={{ background: g.faint }} />
        <span className="h-[5px] w-2/3 rounded-sm" style={{ background: g.faint }} />
        {whole && <span className="mt-1.5 h-3.5 w-2/5 self-end rounded-full" style={{ background: g.bubble }} />}
      </span>
    </span>
  );
}

/** "follows Windows" on Windows, and the right name everywhere else. */
function systemName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  return 'your system';
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light',  label: 'Light' },
  { value: 'dark',   label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** A card of radio rows, native radios so arrows and grouping come free. */
function Choice<T extends string>({ name, value, options, onPick, disabled }: {
  name: string;
  value: T | null;
  options: { value: T; label: string; note: string; font?: string }[];
  onPick: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex max-w-[616px] flex-col overflow-hidden rounded-2xl border border-border-default bg-bg-surface">
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <label
            key={o.value}
            className={cn(
              'flex cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-text-primary/5',
              i > 0 && 'border-t border-border-subtle',
              disabled && 'cursor-default opacity-60',
            )}
          >
            <input
              type="radio"
              name={name}
              checked={on}
              disabled={disabled}
              onChange={() => onPick(o.value)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className={cn(
                'h-[18px] w-[18px] shrink-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-brand',
                on ? 'border-[5px] border-brand' : 'border-[1.5px] border-text-muted',
              )}
            />
            <span className="flex flex-col gap-px">
              <span className="text-sm font-medium text-text-primary" style={o.font ? { fontFamily: o.font } : undefined}>
                {o.label}
              </span>
              <span className="text-xs text-text-muted">{o.note}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function AppearanceTab() {
  const theme    = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const chatFont    = useUI((s) => s.chatFont);
  const setChatFont = useUI((s) => s.setChatFont);
  const mascotEnabled    = useUI((s) => s.mascotEnabled);
  const setMascotEnabled = useUI((s) => s.setMascotEnabled);

  // Glass is the see-through window material over the desktop; Solid paints
  // the app on its own ground, the way the call screen already is. Solid is
  // the default (the engine's too, in settings.rs); Glass is the option.
  const [solid, setSolid] = useState<boolean | null>(null);
  useEffect(() => { void tauri.settings.get().then((s) => setSolid(s.window_solid ?? true)).catch(() => setSolid(true)); }, []);
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
    <div className="space-y-8">
      <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Theme</h3>
        <div className="grid max-w-[632px] grid-cols-3 gap-4">
          {THEMES.map(({ value, label }) => {
            const on = theme === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                onClick={() => setTheme(value)}
                className={cn(
                  'flex flex-col gap-2.5 rounded-2xl border bg-bg-surface p-2.5 text-left transition-colors',
                  on ? 'border-brand ring-1 ring-brand' : 'border-border-default hover:border-text-disabled',
                )}
              >
                <span
                  className="flex h-[110px] overflow-hidden rounded-[10px] border"
                  style={{ borderColor: value === 'dark' ? CHARCOAL.line : PAPER.line }}
                >
                  {value === 'light' && <Mini g={PAPER} />}
                  {value === 'dark' && <Mini g={CHARCOAL} />}
                  {value === 'system' && (<><Mini g={PAPER} whole={false} /><Mini g={CHARCOAL} whole={false} /></>)}
                </span>
                <span className={cn('flex items-baseline gap-1.5 pl-0.5 text-sm text-text-primary', on ? 'font-semibold' : 'font-medium')}>
                  {label}
                  {value === 'system' && <span className="text-2xs font-normal text-text-muted">follows {systemName()}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Chat font</h3>
        <Choice<ChatFont>
          name="chat-font"
          value={chatFont}
          onPick={setChatFont}
          options={[
            { value: 'geist', label: 'Geist', note: "Cinderpaw's own typeface", font: "'Geist Variable', Geist, sans-serif" },
            { value: 'system', label: 'System font', note: 'The one your computer uses everywhere else', font: SYSTEM_FONT },
          ]}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Window background</h3>
        <Choice<'solid' | 'glass'>
          name="window-background"
          value={solid === null ? null : solid ? 'solid' : 'glass'}
          onPick={(v) => pickSolid(v === 'solid')}
          disabled={solid === null}
          options={[
            { value: 'solid', label: 'Solid', note: 'Paper in light, charcoal in dark' },
            { value: 'glass', label: 'Glass', note: 'Your wallpaper shows through, softly' },
          ]}
        />
      </section>

      <div className="flex max-w-[616px] items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">Mascot</p>
          <p className="text-xs text-text-muted mt-0.5">
            The little critter that sits on the typing bar
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
    </div>
  );
}
