/**
 * Settings > Agent > Teammates: who exists, what each may touch, and a way to
 * remove one.
 *
 * A teammate is made from chat ("make me a teammate who..."), keeps running on
 * its own budget after that conversation, and until this list the person had
 * no screen where it appeared at all. Changing one stays a chat request, where
 * the agent can ask what the change is for; removing one is a button, because
 * "stop this" should never need a model to understand it.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Trash2, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCoworkTeam } from '@/stores/coworkTeam';
import type { CoworkTeammate } from '@/lib/tauri';

function toolsLine(t: CoworkTeammate): string {
  if (t.tools === null) return 'Every tool, including ones that write, send and run commands';
  if (t.tools.length === 0) return 'No tools: thinks and replies only';
  return t.tools.join(', ');
}

export function TeammatesSection() {
  const roster = useCoworkTeam((s) => s.roster);
  const loaded = useCoworkTeam((s) => s.loaded);
  const busy = useCoworkTeam((s) => s.busy);
  const error = useCoworkTeam((s) => s.error);
  const removed = useCoworkTeam((s) => s.removed);
  const refresh = useCoworkTeam((s) => s.refresh);
  const remove = useCoworkTeam((s) => s.remove);
  const [confirm, setConfirm] = useState<CoworkTeammate | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="space-y-3 pt-4 border-t border-border-subtle" aria-labelledby="teammates-heading">
      <header className="space-y-1">
        <h3 id="teammates-heading" className="text-sm font-semibold text-text-primary">
          Teammates
        </h3>
        <p className="text-xs text-text-muted">
          Helpers your agent can hand work to. Each keeps its own role and runs on its own budget,
          even after the chat that made it. To change one, ask in chat.
        </p>
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-3">
          <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}
      {removed && <p className="text-xs text-text-muted" role="status">Removed {removed}.</p>}

      {!loaded && !error ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : loaded && roster.length === 0 ? (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-5 text-center">
          <Users size={22} className="text-text-muted mx-auto mb-2" />
          <p className="text-sm text-text-primary">No teammates yet</p>
          <p className="text-xs text-text-muted mt-1">
            Ask in chat, for example: "make me a teammate who reviews my pull requests".
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {roster.map((t) => (
            <li key={t.id} className="rounded-md border border-border-subtle bg-bg-surface p-3 flex items-start gap-3">
              <Users size={16} className="text-text-muted mt-0.5 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-text-primary truncate">{t.name}</h4>
                {t.role && <p className="text-xs text-text-secondary mt-0.5">{t.role}</p>}
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-text-muted">Can use</dt>
                  <dd className={t.tools === null ? 'text-warning' : 'text-text-secondary'}>{toolsLine(t)}</dd>
                  <dt className="text-text-muted">Model</dt>
                  <dd className="text-text-secondary">{t.model ?? 'Chosen per task'}</dd>
                </dl>
              </div>
              <button
                type="button"
                onClick={() => setConfirm(t)}
                disabled={busy}
                aria-label={`Remove ${t.name}`}
                className="p-1.5 rounded text-text-muted hover:text-error hover:bg-error/10 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {confirm?.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            They stop for good, and messages still waiting for them are cancelled. What they already
            said stays in your chats.
          </p>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm) void remove(confirm.id);
                setConfirm(null);
              }}
              className="px-3 py-1.5 text-sm rounded bg-error text-primary-foreground hover:bg-error/90"
            >
              Remove
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
