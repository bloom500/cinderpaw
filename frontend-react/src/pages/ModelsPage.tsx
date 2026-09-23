import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSystemInfo } from '@/stores/systemInfo';
import { useModel } from '@/stores/model';
import { useSettings } from '@/stores/settings';
import { SystemBar } from '@/components/models/SystemBar';
import { LocalModelsTab } from '@/components/models/LocalModelsTab';
import { BrowseTab } from '@/components/models/BrowseTab';
import { ByokTab } from '@/components/settings/ByokTab';
import { cn } from '@/lib/utils';

type Tab = 'local' | 'browse' | 'cloud';
const TABS: readonly Tab[] = ['local', 'browse', 'cloud'];

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Which of the two is open was said in colour alone: a screen reader
      // read "Local Models, Browse HuggingFace" as two plain buttons with no
      // indication that one of them is the view you are already in.
      role="tab"
      aria-selected={active}
      className={cn(
        'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
        active
          ? 'border-brand text-brand'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SystemBar />
      <div role="tablist" aria-label="Models" className="flex px-4 pt-2 border-b border-border-subtle shrink-0">
        <TabButton active={tab === 'local'}  onClick={() => setTab('local')}>Local Models</TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>Browse HuggingFace</TabButton>
        <TabButton active={tab === 'cloud'}  onClick={() => setTab('cloud')}>Cloud</TabButton>
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'local'  ? <LocalModelsTab onBrowse={() => setTab('browse')} /> : null}
        {tab === 'browse' ? <BrowseTab /> : null}
        {tab === 'cloud'  ? <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl"><ByokTab /></div></div> : null}
      </div>
    </div>
  );
}
