import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Cloud, Laptop } from 'lucide-react';
import { useSystemInfo } from '@/stores/systemInfo';
import { useModel } from '@/stores/model';
import { useSettings } from '@/stores/settings';
import { LocalModelsTab } from '@/components/models/LocalModelsTab';
import { BrowseTab } from '@/components/models/BrowseTab';
import { ByokTab } from '@/components/settings/ByokTab';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import type { MascotState } from '@/components/chat/mascot/frames';
import { ModelLogo } from '@/lib/modelLogos';
import { SERIF } from '@/components/models/ui';
import { cn } from '@/lib/utils';

type Tab = 'local' | 'browse' | 'cloud';
const TABS: readonly Tab[] = ['local', 'browse', 'cloud'];

/** In the order the bar shows them: where models live, from far to near. */
const TAB_BAR: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'cloud', label: 'Cloud', icon: <Cloud size={16} /> },
  { id: 'browse', label: 'Hugging Face', icon: <ModelLogo provider="huggingface" className="size-4" /> },
  { id: 'local', label: 'Local', icon: <Laptop size={16} /> },
];

/** What the mascot is doing, and saying, on each tab. */
const HERO: Record<Tab, { state: MascotState; line: string }> = {
  cloud: { state: 'wave', line: 'Bring your own keys. They stay in your computer’s keychain.' },
  browse: { state: 'searching', line: 'Thousands of community models. Find one, and I’ll fetch it for you.' },
  local: { state: 'typing', line: 'Your models. Your machine. All private, all yours.' },
};

export function ModelsPage() {
  // The tab lives in the URL so any button in the app can open Cloud directly
  // (`/models?tab=cloud`): cloud keys moved here from Settings, and every
  // "add a key" link has to land on the cards, not on a page above them.
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'local';
  const setTab = (next: Tab) => setParams({ tab: next }, { replace: true });

  useEffect(() => {
    void useSystemInfo.getState().fetch();
    void useModel.getState().refresh();
    void useSettings.getState().fetchByok();
  }, []);

  const hero = HERO[tab];

  return (
    <div className="h-full overflow-y-auto thin-scrollbar">
      <div className="mx-auto w-full max-w-6xl px-6 pb-12 pt-8 sm:px-10">
        {/* #22: drag region — the frameless window must stay draggable from the
            top of every page, not just the chat header. */}
        <header data-tauri-drag-region className="flex items-end justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold text-text-primary" style={{ fontFamily: SERIF }}>Models</h1>
            <p className="mt-2 max-w-md text-base text-text-secondary">
              Connect your favourite providers and models. Switch between cloud, local, or Hugging Face models.
            </p>

            <div role="tablist" aria-label="Models" className="mt-6 inline-flex rounded-2xl border border-border-subtle bg-bg-surface p-1 shadow-sm">
              {TAB_BAR.map(({ id, label, icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    // Which one is open was said in colour alone: a screen
                    // reader heard three plain buttons.
                    aria-selected={active}
                    onClick={() => setTab(id)}
                    className={cn(
                      'relative inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors sm:px-5',
                      active ? 'text-brand' : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="models-tab"
                        className="absolute inset-0 rounded-xl bg-brand/10 ring-1 ring-brand/20"
                        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                      />
                    )}
                    <span className="relative inline-flex items-center gap-2">{icon}{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="hidden shrink-0 items-end gap-1 lg:flex" aria-hidden>
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="relative mb-16 max-w-[210px] rounded-2xl border border-border-subtle bg-bg-surface px-4 py-3 text-sm leading-snug text-text-secondary shadow-sm"
              >
                {hero.line}
                <span className="absolute -right-1.5 bottom-4 size-3 rotate-45 border-r border-t border-border-subtle bg-bg-surface" />
              </motion.div>
            </AnimatePresence>
            <CinderpawMascot state={hero.state} width={168} />
          </div>
        </header>

        <div className="mt-2 border-t border-border-subtle" />

        <AnimatePresence mode="wait">
          <motion.main
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pt-7"
          >
            {tab === 'local' ? <LocalModelsTab onBrowse={() => setTab('browse')} /> : null}
            {tab === 'browse' ? <BrowseTab /> : null}
            {tab === 'cloud' ? <ByokTab /> : null}
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}
