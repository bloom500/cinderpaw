import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, X } from 'lucide-react';
import { useUI } from '@/stores/ui';
import { readLocal, writeLocal } from '@/lib/utils';

const BYOK_DISCLAIMER_KEY = 'cinderpaw.agentByokDismissed';

/** One-time note recommending BYOK for agent mode on low-compute machines. */
function AgentByokNote() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(
    () => readLocal(BYOK_DISCLAIMER_KEY) === 'true',
  );
  if (dismissed) return null;

  const dismiss = () => {
    writeLocal(BYOK_DISCLAIMER_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="mt-4 flex items-start gap-2 max-w-md px-3 py-2 rounded-lg border border-border-subtle bg-bg-surface/60 text-text-muted pointer-events-auto">
      <Info size={14} className="shrink-0 mt-0.5 text-text-muted" />
      <p className="text-xs leading-relaxed">
        Local models need significant compute. For smoother performance we
        recommend a cloud model:{' '}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="text-brand hover:underline"
        >
          add a key (BYOK)
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
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  if (!isEmpty || !isAgentMode) return null;

  // The greeting moved into the composer's wrapper, where the centring already
  // knows how tall everything is. What is left here is the one note that has
  // to sit clear of the field.
  return (
    <div className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none">
      <AgentByokNote />
    </div>
  );
}
