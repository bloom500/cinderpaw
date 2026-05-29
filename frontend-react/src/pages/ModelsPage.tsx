import { useEffect, useState } from 'react';
import { useSystemInfo } from '@/stores/systemInfo';
import { useModel } from '@/stores/model';
import { SystemBar } from '@/components/models/SystemBar';
import { ByokBanner } from '@/components/models/ByokBanner';
import { LocalModelsTab } from '@/components/models/LocalModelsTab';
import { BrowseTab } from '@/components/models/BrowseTab';
import { cn } from '@/lib/utils';

type Tab = 'local' | 'browse';

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
  const [tab, setTab] = useState<Tab>('local');

  useEffect(() => {
    void useSystemInfo.getState().fetch();
    void useModel.getState().refresh();
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SystemBar />
      <ByokBanner />
      <div className="flex px-4 pt-2 border-b border-border-subtle shrink-0">
        <TabButton active={tab === 'local'}  onClick={() => setTab('local')}>Local Models</TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>Browse HuggingFace</TabButton>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'local'  ? <LocalModelsTab onBrowse={() => setTab('browse')} /> : null}
        {tab === 'browse' ? <BrowseTab /> : null}
      </div>
    </div>
  );
}
