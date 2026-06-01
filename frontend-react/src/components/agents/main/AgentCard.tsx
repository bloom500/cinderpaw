import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { AgentConfig } from '@/lib/tauri';
import { TOOL_LABELS } from '../agentUtils';

interface Props {
  agent: AgentConfig;
  onDelete: () => Promise<void>;
}

export function AgentCard({ agent, onDelete }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting]       = useState(false);

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h3 className="text-sm font-medium text-text-primary truncate">{agent.name}</h3>
            {agent.tools.length === 0 ? (
              <p className="text-xs text-text-muted">No tools</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((t) => (
                  <span
                    key={t}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-bg-hover text-text-muted border border-border-subtle"
                  >
                    {TOOL_LABELS[t]?.label ?? t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            aria-label={`Delete ${agent.name}`}
            className="shrink-0 p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {!agent.model_id && (
          <p className="text-[11px] text-text-muted">
            No model assigned — load a model in the Models tab to run this agent.
          </p>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!deleting) setConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete "{agent.name}"?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This will permanently remove the agent profile. This cannot be undone.
          </p>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDelete()}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
