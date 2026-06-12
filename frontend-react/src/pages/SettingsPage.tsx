import { useState, useEffect } from 'react';
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

type Category = 'general' | 'appearance' | 'hardware' | 'api' | 'byok' | 'agent' | 'privacy' | 'about';

const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'general',    label: 'General',     icon: '⚙' },
  { id: 'appearance', label: 'Appearance',  icon: '◐' },
  { id: 'hardware',   label: 'Hardware',    icon: '⌬' },
  { id: 'api',        label: 'API Server',  icon: '⇄' },
  { id: 'byok',       label: 'Cloud Keys',  icon: '⚷' },
  { id: 'agent',      label: 'Agent',       icon: '◈' },
  { id: 'privacy',    label: 'Privacy',     icon: '⚿' },
  { id: 'about',      label: 'About',       icon: 'ⓘ' },
];

function isCategory(s: string | null): s is Category {
  return s !== null && CATS.some((c) => c.id === s);
}

export function SettingsPage() {
  const [searchParams] = useSearchParams();
  const initial = searchParams.get('cat');
  const [cat, setCat] = useState<Category>(isCategory(initial) ? initial : 'general');
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const fetchByok     = useSettings((s) => s.fetchByok);

  useEffect(() => {
    void fetchSettings();
    void fetchByok();
  }, [fetchSettings, fetchByok]);

  // Allow deep-links like /settings?cat=agent to switch tabs.
  useEffect(() => {
    const next = searchParams.get('cat');
    if (isCategory(next) && next !== cat) setCat(next);
  }, [searchParams, cat]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* #22: thin drag strip — without it the frameless window can't be
          moved while Settings is open (only ChatHeader had a drag region). */}
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="flex flex-1 overflow-hidden">
      <aside className="w-44 shrink-0 border-r border-border-subtle flex flex-col py-2 overflow-y-auto">
        {CATS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
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
      <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
        {cat === 'general'    && <GeneralTab />}
        {cat === 'appearance' && <AppearanceTab />}
        {cat === 'hardware'   && <HardwareTab />}
        {cat === 'api'        && <ApiServerTab />}
        {cat === 'byok'       && <ByokTab />}
        {cat === 'agent'      && <AgentSettingsTab />}
        {cat === 'privacy'    && <PrivacyTab />}
        {cat === 'about'      && <AboutTab />}
      </div>
      </div>
    </div>
  );
}
