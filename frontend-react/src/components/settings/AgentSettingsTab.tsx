import { useEffect, useState } from 'react';
import { Trash2, AlertCircle, Bot, RefreshCw, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAgent } from '@/stores/agent';
import { useNavigate } from 'react-router-dom';
import { TOOL_LABELS } from '@/components/agents/agentUtils';
import { cn } from '@/lib/utils';

export function AgentSettingsTab() {
  const navigate          = useNavigate();
  const list              = useAgent((s) => s.list);
  const current           = useAgent((s) => s.current);
  const loading           = useAgent((s) => s.loading);
  const error             = useAgent((s) => s.error);
  const refresh           = useAgent((s) => s.refresh);
  const setCurrent        = useAgent((s) => s.setCurrent);
  const deleteAgent       = useAgent((s) => s.delete);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConfirmDelete = async () => {
    if (!confirmId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAgent(confirmId);
      setConfirmId(null);
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-text-primary">Agent</h2>
        <p className="text-sm text-text-muted">
          The single active agent that powers your chat. Delete to start over,
          or switch to create a new one through the onboarding flow.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => {
            // Hand the navigation off to AgentsPage — it owns the gate
            // key and the route state needed to guarantee a fresh
            // onboarding flow (re-mounting the gate, clearing the
            // active agent). Doing it from inside this component
            // directly fights React's render order, so we just declare
            // the intent and let AgentsPage consume it.
            useAgent.getState().clear();
            navigate('/agents', { state: { newAgent: true } });
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
        >
          <Plus size={13} />
          New agent
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
          <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {list.length === 0 && !loading ? (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-8 text-center">
          <Bot size={28} className="text-text-muted mx-auto mb-3" />
          <h3 className="text-sm font-medium text-text-primary mb-1">No agent yet</h3>
          <p className="text-xs text-text-muted mb-4">
            Create one to give your chat a personality, tools, and a goal.
          </p>
          <button
            type="button"
            onClick={() => {
              useAgent.getState().clear();
              navigate('/agents');
            }}
            className="px-3 py-1.5 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
          >
            Create agent
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((a) => {
            const isActive = current?.id === a.id;
            return (
              <li
                key={a.id}
                className={cn(
                  'rounded-md border p-3 flex items-start gap-3',
                  isActive
                    ? 'border-brand/30 bg-brand/5'
                    : 'border-border-subtle bg-bg-surface',
                )}
              >
                <Bot size={16} className="text-text-muted mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-text-primary truncate">
                      {a.name}
                    </h4>
                    {isActive && (
                      <span className="text-[10px] uppercase tracking-wider text-brand font-semibold">
                        Active
                      </span>
                    )}
                  </div>
                  {a.system_prompt && (
                    <p className="text-xs text-text-muted mt-1 line-clamp-2">
                      {a.system_prompt}
                    </p>
                  )}
                  {a.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {a.tools.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-hover text-text-muted border border-border-subtle"
                        >
                          {TOOL_LABELS[t]?.label ?? t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => setCurrent(a.id!)}
                      className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                    >
                      Make active
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmId(a.id ?? null)}
                    className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-red-400 transition-colors"
                    aria-label={`Delete ${a.name}`}
                  >
                    <Trash2 size={11} />
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={confirmId !== null}
        onOpenChange={(open) => {
          if (!deleting) {
            if (!open) setConfirmId(null);
            if (!open) setDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this agent?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This permanently removes the agent profile. The chat history
            tied to it stays in your conversations — only the agent
            definition is deleted.
          </p>
          {deleteError && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
              <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{deleteError}</p>
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              onClick={() => { setConfirmId(null); setDeleteError(null); }}
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
    </div>
  );
}
