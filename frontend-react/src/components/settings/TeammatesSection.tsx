/**
 * Settings > Agent and team > Team: who exists, what each is doing, and a way
 * to talk to, add or remove one (spec 7.2, canvas "Settings: team").
 *
 * A teammate is made from chat ("make me a teammate who..."), keeps running on
 * its own budget after that conversation, and until this list the person had
 * no screen where it appeared at all. Changing one stays a chat request, where
 * the agent can ask what the change is for; removing one is a button, because
 * "stop this" should never need a model to understand it.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useConversations } from '@/stores/conversations';
import type { CoworkTeammate } from '@/lib/tauri';
import logoUrl from '@/assets/logo.svg';

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
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<CoworkTeammate | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A new chat with the words already in the box (ChatPage reads `compose`):
  // the person finishes the sentence, nothing is sent for them.
  const compose = (text: string) => {
    useConversations.getState().newChat();
    navigate('/chat', { state: { compose: text } });
  };
  // What a teammate is doing right now: the request it is working on, from the
  // live transcript. Nothing running is "Idle", never a guess.
  const workingOn = (id: string) =>
    exchanges.find((e) => e.toAgentId === id && e.status === 'running' && e.kind !== 'approval');

  return (
    <section className="space-y-4 pt-4 border-t border-border-subtle" aria-labelledby="teammates-heading">
      <header className="space-y-1">
        <h3 id="teammates-heading" className="text-base font-semibold text-text-primary">
          Team
        </h3>
        <p className="text-sm text-text-muted">
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
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {roster.map((t) => {
            const job = workingOn(t.id);
            return (
              <li key={t.id} className="flex items-center gap-3.5 rounded-2xl border border-border-default bg-bg-surface p-4">
                <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl bg-bg-active">
                  <img src={logoUrl} alt="" className="h-10 w-10" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h4 className="truncate text-base font-semibold text-text-primary">{t.name}</h4>
                  {t.role && <p className="truncate text-sm text-text-muted">{t.role}</p>}
                  {job ? (
                    <p className="flex items-center gap-1.5 text-xs text-brand">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                      <span className="truncate">Working{job.requestText ? `: ${job.requestText}` : ''}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted">Idle</p>
                  )}
                  {/* What it may touch stays on the card: a teammate made before
                      tools were scoped can write, send and run commands. */}
                  <p
                    className={`truncate text-2xs ${t.tools === null ? 'text-warning' : 'text-text-disabled'}`}
                    title={toolsLine(t)}
                  >
                    Can use: {toolsLine(t)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => compose(`Ask ${t.name} to `)}
                    className="h-8 rounded-[10px] border border-border-default bg-bg-elevated px-3 text-sm text-text-primary hover:bg-bg-hover"
                  >
                    Message
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm(t)}
                    disabled={busy}
                    aria-label={`Remove ${t.name}`}
                    className="rounded-md p-1.5 text-text-muted hover:bg-error/10 hover:text-error disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => compose('Make me a teammate who ')}
              className="flex h-full w-full items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed border-border-default p-4 text-left text-text-muted hover:bg-text-primary/5"
            >
              <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl border-[1.5px] border-dashed border-border-default text-brand">
                <Plus size={20} />
              </span>
              <span className="space-y-0.5">
                <span className="block text-base font-semibold text-text-primary">Add a teammate</span>
                <span className="block text-sm">
                  {roster.length === 0
                    ? 'A helper with one job, like reviewing your pull requests. You describe it in chat.'
                    : 'Give it a name and a job'}
                </span>
              </span>
            </button>
          </li>
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
