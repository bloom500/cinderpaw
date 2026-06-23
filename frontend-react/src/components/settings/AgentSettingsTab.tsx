import { useEffect, useState } from 'react';
import { Trash2, AlertCircle, Bot, RefreshCw, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAgent } from '@/stores/agent';
import { useSettings } from '@/stores/settings';
import { useNavigate } from 'react-router-dom';
import { TOOL_LABELS } from '@/components/agents/agentUtils';
import { cn } from '@/lib/utils';
import { RsiEngineStatusPanel } from './RsiEngineStatusPanel';
import { FractalBenchmarkPanel } from './FractalBenchmarkPanel'; // PROVISIONAL — remove after ship/hold decision

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

      <TokenBudgetToggle />
      <RsiBudgetControl />
      <RsiEngineStatusPanel />
      <FractalBenchmarkPanel />{/* PROVISIONAL — remove after ship/hold decision */}
      <DesktopControlToggle />

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
            useAgent.getState().clear();
            navigate('/chat');
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
              navigate('/chat');
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

/**
 * USD spend cap for the passive RSI background engine. Default $0 = local-only:
 * the free local engine self-improves forever and never spends; any paid cloud
 * spend halts. Raise it to allow bounded cloud spend.
 */
function RsiBudgetControl() {
  const settings    = useSettings((s) => s.settings);
  const setRsiBudget = useSettings((s) => s.setRsiBudget);
  const [busy, setBusy] = useState(false);

  const budget = settings?.rsi_max_cost_usd ?? 0;

  const PRESETS = [
    { label: 'Local only ($0)', value: 0 },
    { label: '$1',  value: 1 },
    { label: '$5',  value: 5 },
    { label: '$20', value: 20 },
  ] as const;

  const setPreset = async (value: number) => {
    if (busy || !settings) return;
    setBusy(true);
    try { await setRsiBudget(value); } catch { /* rolled back */ } finally { setBusy(false); }
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">Background self-improvement budget</p>
        <p className="text-xs text-text-muted mt-0.5">
          Feral quietly improves itself in the background. Local models are free —
          this caps what it may spend on <span className="text-text-secondary">paid cloud models</span>.
          <span className="text-text-secondary"> $0 = never spend cloud money.</span>
        </p>
      </div>
      <div className="flex gap-1 rounded-md border border-border-subtle p-1">
        {PRESETS.map(({ label, value }) => (
          <button
            key={value}
            type="button"
            disabled={busy || !settings}
            onClick={() => void setPreset(value)}
            className={cn(
              'flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
              budget === value ? 'bg-brand text-white' : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Toggle for per-conversation token budget. Default: unlimited (null).
 * When limited, the agent stops at the configured token count and surfaces
 * a budget_exceeded event — useful as a runaway-cost guardrail.
 */
function TokenBudgetToggle() {
  const settings       = useSettings((s) => s.settings);
  const setTokenBudget = useSettings((s) => s.setTokenBudget);
  const [busy, setBusy] = useState(false);

  const budget  = settings?.token_budget_conversation ?? null;
  const limited = budget !== null;

  const toggle = async () => {
    if (busy || !settings) return;
    setBusy(true);
    try {
      // unlimited → 5M cap, limited → back to unlimited
      await setTokenBudget(limited ? null : 5_000_000);
    } catch {
      /* store already rolled back */
    } finally {
      setBusy(false);
    }
  };

  const PRESETS = [
    { label: '1M',  value: 1_000_000 },
    { label: '5M',  value: 5_000_000 },
    { label: '20M', value: 20_000_000 },
    { label: '50M', value: 50_000_000 },
  ] as const;

  const setPreset = async (value: number) => {
    if (busy || !settings) return;
    setBusy(true);
    try {
      await setTokenBudget(value);
    } catch {
      /* store already rolled back */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Token budget</p>
          <p className="text-xs text-text-muted mt-0.5">
            Cap the number of tokens an agent can use per conversation.
            Unlimited by default — you're responsible for your own inference costs.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={limited}
          aria-label="Enable conversation token limit"
          disabled={busy || !settings}
          onClick={() => void toggle()}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0 overflow-hidden disabled:opacity-50',
            limited ? 'bg-brand' : 'bg-neutral-600',
          )}
        >
          <span className={cn('absolute top-1 left-0 w-4 h-4 rounded-full bg-white transition-transform', limited ? 'translate-x-5' : 'translate-x-1')} />
        </button>
      </div>

      {limited && (
        <div className="space-y-2 pt-1 border-t border-border-subtle">
          <p className="text-xs font-medium text-text-primary mt-2">Limit</p>
          <div className="flex gap-1 rounded-md border border-border-subtle p-1">
            {PRESETS.map(({ label, value }) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => void setPreset(value)}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors',
                  budget === value
                    ? 'bg-brand text-white'
                    : 'text-text-secondary hover:bg-bg-hover',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-muted">
            Tokens per conversation. When reached, the agent stops and lets you decide whether to continue.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Opt-in switch for OS-level desktop control (the `control_app` tool). OFF by
 * default, mirroring the `shell_exec` security posture. Flipping it calls the
 * backend, which persists the choice and restarts the sidecar so the tool
 * (de)registers — the agent will only "find" control_app while this is ON.
 */
function DesktopControlToggle() {
  const settings = useSettings((s) => s.settings);
  const setDesktopControl = useSettings((s) => s.setDesktopControl);
  const setDesktopControlYolo = useSettings((s) => s.setDesktopControlYolo);
  const [busy, setBusy] = useState(false);
  const [yoloBusy, setYoloBusy] = useState(false);
  const enabled = settings?.desktop_control_enabled ?? false;
  const yolo = settings?.desktop_control_yolo ?? false;

  const toggle = async () => {
    if (busy || !settings) return;
    setBusy(true);
    try {
      await setDesktopControl(!enabled);
    } catch {
      /* store already rolled back + logged */
    } finally {
      setBusy(false);
    }
  };

  const toggleYolo = async (next: boolean) => {
    if (yoloBusy || !settings || next === yolo) return;
    setYoloBusy(true);
    try {
      await setDesktopControlYolo(next);
    } catch {
      /* store already rolled back + logged */
    } finally {
      setYoloBusy(false);
    }
  };

  const segBtn = (active: boolean) =>
    cn(
      'flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors',
      active ? 'bg-brand text-white' : 'text-text-secondary hover:bg-bg-hover',
    );

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Desktop control</p>
          <p className="text-xs text-text-muted mt-0.5">
            Let the agent read and operate native apps through the OS
            accessibility tree (the <span className="font-mono">control_app</span> tool).
            Off by default.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Enable desktop control"
          disabled={busy || !settings}
          onClick={() => void toggle()}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0 overflow-hidden disabled:opacity-50',
            enabled ? 'bg-brand' : 'bg-neutral-600',
          )}
        >
          <span className={cn('absolute top-1 left-0 w-4 h-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
        </button>
      </div>

      {enabled && (
        <div className="space-y-2 pt-1 border-t border-border-subtle">
          <p className="text-xs font-medium text-text-primary mt-2">Confirmation</p>
          <div className="flex gap-1 rounded-md border border-border-subtle p-1">
            <button
              type="button"
              disabled={yoloBusy}
              onClick={() => void toggleYolo(false)}
              className={segBtn(!yolo)}
              aria-pressed={!yolo}
            >
              Safe — ask before each action
            </button>
            <button
              type="button"
              disabled={yoloBusy}
              onClick={() => void toggleYolo(true)}
              className={segBtn(yolo)}
              aria-pressed={yolo}
            >
              YOLO — no prompts
            </button>
          </div>
          <p className="text-[11px] text-text-muted">
            {yolo
              ? 'YOLO: the agent clicks, types and sends without asking. Launching apps still confirms.'
              : 'Safe: the agent asks you before any click, type or send.'}
          </p>
        </div>
      )}

      <p className="text-[11px] text-text-muted flex items-center gap-1.5">
        <AlertCircle size={11} className="shrink-0" />
        {busy || yoloBusy
          ? 'Restarting the agent…'
          : 'Changes restart the agent briefly so the tool reloads.'}
      </p>
    </div>
  );
}
