import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';
import { GeneralTab }    from '@/components/settings/GeneralTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { HardwareTab }   from '@/components/settings/HardwareTab';
import { ApiServerTab }  from '@/components/settings/ApiServerTab';
import { ByokTab }       from '@/components/settings/ByokTab';
import { OpenClawTab }   from '@/components/settings/OpenClawTab';
import { PrivacyTab }    from '@/components/settings/PrivacyTab';
import { AboutTab }      from '@/components/settings/AboutTab';

type Category = 'general' | 'appearance' | 'hardware' | 'api' | 'byok' | 'openclaw' | 'privacy' | 'about';

const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'general',    label: 'General',     icon: '⚙' },
  { id: 'appearance', label: 'Appearance',  icon: '◐' },
  { id: 'hardware',   label: 'Hardware',    icon: '⌬' },
  { id: 'api',        label: 'API Server',  icon: '⇄' },
  { id: 'byok',       label: 'Cloud Keys',  icon: '⚷' },
  { id: 'openclaw',   label: 'OpenClaw',    icon: '🜲' },
  { id: 'privacy',    label: 'Privacy',     icon: '⚿' },
  { id: 'about',      label: 'About',       icon: 'ⓘ' },
];

export function SettingsPage() {
  const [cat, setCat] = useState<Category>('general');
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const fetchByok     = useSettings((s) => s.fetchByok);

  useEffect(() => {
    void fetchSettings();
    void fetchByok();
  }, [fetchSettings, fetchByok]);

  return (
    <div className="flex h-full overflow-hidden">
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
        {cat === 'openclaw'   && <OpenClawTab />}
        {cat === 'privacy'    && <PrivacyTab />}
        {cat === 'about'      && <AboutTab />}
      </div>
    </div>
  );
}
