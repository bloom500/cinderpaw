import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, X } from 'lucide-react';
import { readLocal, writeLocal } from '@/lib/utils';
import { ShareUsageCard } from '@/components/usage/ShareUsageCard';
import { useSettings } from '@/stores/settings';
import { useModel } from '@/stores/model';

const BYOK_DISCLAIMER_KEY = 'cinderpaw.agentByokDismissed';

/** One-time note recommending BYOK for agent mode on low-compute machines. */
function AgentByokNote() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(
    () => readLocal(BYOK_DISCLAIMER_KEY) === 'true',
  );
  // Advice to add a cloud key is wrong once there is one: it stayed on Home
  // beside a working key (UX lab, 19 Oct, item 9). The keys are read here
  // because nothing else loads them before the Models page is opened.
  const hasCloudKey = useSettings((s) => s.byok.some((p) => p.enabled && p.has_api_key));
  const cloudModel = useModel((s) => s.cloudModel);
  useEffect(() => { void useSettings.getState().fetchByok(); }, []);
  if (dismissed || hasCloudKey || cloudModel) return null;

  const dismiss = () => {
    writeLocal(BYOK_DISCLAIMER_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="mt-4 flex items-start gap-2 max-w-md px-3 py-2 rounded-lg border border-border-subtle bg-(--surface-typing) text-text-muted pointer-events-auto">
      <Info size={14} className="shrink-0 mt-0.5 text-text-muted" />
      <p className="text-xs leading-relaxed">
        Local models need significant compute. For smoother performance we
        recommend a cloud model:{' '}
        <button
          type="button"
          onClick={() => navigate('/models?tab=cloud')}
          className="text-brand hover:underline"
        >
          add a cloud key
        </button>
        .
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 -mr-1 -mt-0.5 p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface NewChatEmptyStateProps {
  isEmpty: boolean;
}

export function NewChatEmptyState({ isEmpty }: NewChatEmptyStateProps) {
  if (!isEmpty) return null;

  // Rendered inside the composer's wrapper, under the intent cards, like the
  // greeting: the centring there knows how tall everything is. Pinned to the
  // window's bottom edge instead, it slid under the intent cards on a short
  // window (a Mac, 17 Oct 2026), both see-through, the two texts on top of
  // each other.
  return (
    <div className="flex flex-col items-center px-4 pb-4 pointer-events-none">
      <AgentByokNote />
      {/* Hides itself unless the usage question was never answered. */}
      <ShareUsageCard />
    </div>
  );
}
