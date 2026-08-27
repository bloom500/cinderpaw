import { useEffect, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';
import { GeneralTab }    from '@/components/settings/GeneralTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { HardwareTab }   from '@/components/settings/HardwareTab';
import { ApiServerTab }  from '@/components/settings/ApiServerTab';
import { ByokTab }       from '@/components/settings/ByokTab';
import { AgentSettingsTab } from '@/components/settings/AgentSettingsTab';
import { PrivacyTab }    from '@/components/settings/PrivacyTab';
import { AboutTab }      from '@/components/settings/AboutTab';
// Phase 5 S1: three former top-level pages, whose only door was the sidebar.
// Rendered whole rather than re-cut into settings forms — they are dense
// screens that already own their own scrolling, and re-drawing them here would
// be a rewrite disguised as a move.
const CapabilitiesTab = lazy(() => import('@/pages/ExtensionsPage').then((m) => ({ default: m.ExtensionsPage })));
const AccountsTab     = lazy(() => import('@/pages/ConnectorsPage').then((m) => ({ default: m.ConnectorsPage })));
const MemoryTab       = lazy(() => import('@/pages/MemoryLayersPage'));

type Category =
  | 'general' | 'appearance' | 'hardware' | 'api' | 'byok' | 'agent' | 'privacy' | 'about'
  | 'capabilities' | 'accounts' | 'memory';

/** The three that take the whole pane: they lay themselves out and scroll themselves. */
const FULL_BLEED: Category[] = ['capabilities', 'accounts', 'memory'];

/** Exported so the router's redirects can be checked against it: a redirect to
 *  a category that does not exist is a dead end, and nothing else would catch
 *  it — the tab list would simply fall back to General with no error. */
export const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'general',    label: 'General',     icon: '⚙' },
  { id: 'appearance', label: 'Appearance',  icon: '◐' },
  { id: 'hardware',   label: 'Hardware',    icon: '⌬' },
  { id: 'api',        label: 'API Server',  icon: '⇄' },
  { id: 'byok',       label: 'Cloud Keys',  icon: '⚷' },
  { id: 'agent',      label: 'Agent',       icon: '◈' },
  { id: 'privacy',    label: 'Privacy',     icon: '⚿' },
  // Named for what the user is looking for, not for the subsystem underneath:
  // 'skill', 'extension' and 'connector' are banned from the primary interface
  // by the UX contract. They stay legal inside these screens, which is what
  // progressive disclosure means.
  { id: 'capabilities', label: 'Capabilities', icon: '✦' },
  { id: 'accounts',     label: 'Accounts',     icon: '⚯' },
  { id: 'memory',       label: 'Memory',       icon: '❊' },
  { id: 'about',      label: 'About',       icon: 'ⓘ' },
];

function isCategory(s: string | null): s is Category {
  return s !== null && CATS.some((c) => c.id === s);
}

export function SettingsPage() {
  /**
   * The URL is the only place the open category lives.
   *
   * It used to live in `useState` as well, with an effect syncing the URL back
   * onto it — and that effect ran on `[searchParams, cat]`, so it fired on the
   * click that changed `cat` and put the old category straight back. Anyone who
   * arrived through one of the four redirects (`/extensions`, `/connectors`,
   * `/memory-layers`, `/memory-graph`) was then locked in that category: every
   * other entry in the sidebar visibly did nothing. Settings, unable to leave
   * the first screen it opened on.
   *
   * One source of truth removes the loop rather than patching it, and the URL
   * is the right one — it is what the redirects, deep links and the agent's own
   * navigation already speak.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('cat');
  const cat: Category = isCategory(raw) ? raw : 'general';
  const setCat = (next: Category) => setSearchParams({ cat: next }, { replace: true });
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const fetchByok     = useSettings((s) => s.fetchByok);

  useEffect(() => {
    void fetchSettings();
    void fetchByok();
  }, [fetchSettings, fetchByok]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* #22: thin drag strip — without it the frameless window can't be
          moved while Settings is open (only ChatHeader had a drag region). */}
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="flex flex-1 overflow-hidden">
      {/* `border-default`, not `border-subtle`: the two columns are both glass
          over the same wallpaper, so a hairline drawn in the faintest border
          token disappeared and Settings read as one undivided blob. The next
          step up is still a hairline — it just survives the material. */}
      <aside className="w-44 shrink-0 border-r border-border-default flex flex-col py-2 overflow-y-auto">
        {CATS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            // Colour alone said which category was open. A screen reader read
            // eleven identical buttons.
            aria-current={cat === c.id ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
              cat === c.id
                ? 'bg-bg-active text-text-primary font-medium'
                : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span className="shrink-0">{c.icon}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </aside>
      <div className={cn(
        'flex-1 overflow-hidden',
        FULL_BLEED.includes(cat) ? '' : 'overflow-y-auto p-6 max-w-2xl',
      )}>
        {cat === 'general'    && <GeneralTab />}
        {cat === 'appearance' && <AppearanceTab />}
        {cat === 'hardware'   && <HardwareTab />}
        {cat === 'api'        && <ApiServerTab />}
        {cat === 'byok'       && <ByokTab />}
        {cat === 'agent'      && <AgentSettingsTab />}
        {cat === 'privacy'    && <PrivacyTab />}
        {cat === 'about'      && <AboutTab />}
        <Suspense fallback={null}>
          {cat === 'capabilities' && <CapabilitiesTab />}
          {cat === 'accounts'     && <AccountsTab />}
          {cat === 'memory'       && <MemoryTab />}
        </Suspense>
      </div>
      </div>
    </div>
  );
}
