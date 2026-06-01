import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, ExternalLink, RefreshCw, Terminal, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tauri, type OpenClawStatusResult } from '@/lib/tauri';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: OpenClawStatusResult }
  | { kind: 'error'; message: string };

const STATUS_PILL: Record<string, string> = {
  not_installed: 'bg-bg-hover text-text-muted',
  installed_idle: 'bg-bg-hover text-text-muted',
  installed_running: 'bg-blue-500/20 text-blue-400',
  healthy: 'bg-green-500/20 text-green-400',
  unhealthy: 'bg-amber-500/20 text-amber-400',
  error: 'bg-red-500/20 text-red-400',
};

function pillClass(key: string): string {
  return cn('text-xs px-2 py-0.5 rounded-full shrink-0', STATUS_PILL[key] ?? STATUS_PILL.error);
}

function pillLabel(state: LoadState): { key: string; text: string } {
  if (state.kind === 'error') return { key: 'error', text: 'Check failed' };
  if (state.kind === 'loading') return { key: 'not_installed', text: 'Checking…' };
  if (state.kind === 'idle') return { key: 'not_installed', text: 'Not checked' };
  const d = state.data;
  if (!d.installed) return { key: 'not_installed', text: 'Not installed' };
  if (!d.gateway_running) return { key: 'installed_idle', text: 'Installed' };
  if (!d.health_ok) return { key: 'unhealthy', text: 'Gateway up · health failing' };
  return { key: 'healthy', text: 'Healthy' };
}

export function OpenClawTab() {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [opening, setOpening] = useState(false);
  const [openDiag, setOpenDiag] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const data = await tauri.openclaw.status();
      setState({ kind: 'ready', data });
    } catch (e) {
      setState({ kind: 'error', message: String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenDocs = useCallback(async () => {
    setOpening(true);
    setDocsError(null);
    try {
      await tauri.openclaw.openDocs();
    } catch (e) {
      setDocsError(String(e));
    } finally {
      setOpening(false);
    }
  }, []);

  const pill = pillLabel(state);
  const isLoading = state.kind === 'loading';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">OpenClaw</h2>
        <p className="text-xs text-text-muted mt-1">
          Detect an external OpenClaw agent runtime installed on this machine.
          Feral does not start, configure, or store credentials for OpenClaw.
        </p>
      </div>

      {/* Status pill + refresh */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={pillClass(pill.key)}>{pill.text}</span>
          {state.kind === 'error' && (
            <span className="text-xs text-red-400 inline-flex items-center gap-1">
              <AlertCircle size={12} /> {state.message}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isLoading}
          className="px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={13} className={cn(isLoading && 'animate-spin')} />
          {isLoading ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>

      {/* Installation card */}
      <Card title="Installation">
        {state.kind === 'ready' && state.data.installed ? (
          <KeyValue rows={[
            ['Status', 'Installed'],
            ['Version', state.data.version ?? 'unknown'],
            ['Path', state.data.binary_path ?? 'unknown'],
          ]} />
        ) : state.kind === 'ready' && !state.data.installed ? (
          <EmptyHint
            text="Feral could not find an openclaw binary on your PATH."
            subtext="Install OpenClaw from its official site, then click Refresh."
          />
        ) : (
          <Skeleton lines={3} />
        )}
      </Card>

      {/* Gateway card */}
      <Card title="Gateway">
        {state.kind === 'ready' ? (
          state.data.installed ? (
            state.data.gateway_running ? (
              <KeyValue rows={[['Status', 'Running']]} />
            ) : (
              <EmptyHint
                text="OpenClaw is installed but the gateway is not running."
                subtext="Start it in a terminal (e.g. `openclaw gateway start`) then refresh."
              />
            )
          ) : (
            <EmptyHint text="Gateway status is only available when OpenClaw is installed." />
          )
        ) : (
          <Skeleton lines={2} />
        )}
      </Card>

      {/* Health card */}
      <Card title="Health">
        {state.kind === 'ready' ? (
          state.data.installed && state.data.health_ok ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-sm text-green-400">
                <CheckCircle size={14} /> Health checks pass
              </div>
              {state.data.health_summary && (
                <p className="text-xs text-text-muted font-mono break-words">
                  {state.data.health_summary}
                </p>
              )}
            </div>
          ) : state.data.installed && !state.data.health_ok ? (
            <EmptyHint
              text="Health endpoint did not return a healthy response."
              subtext="Open the diagnostics below for the raw output (secrets are redacted)."
            />
          ) : (
            <EmptyHint text="Health is only checked when OpenClaw is installed." />
          )
        ) : (
          <Skeleton lines={2} />
        )}
      </Card>

      {/* Next-step recommendation */}
      <Card title="Next step">
        {state.kind === 'ready' ? (
          <p className="text-sm text-text-primary">{state.data.recommended_action}</p>
        ) : (
          <Skeleton lines={2} />
        )}
      </Card>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleOpenDocs()}
          disabled={opening}
          className="px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <ExternalLink size={13} />
          {opening ? 'Opening…' : 'Open install docs'}
        </button>
        {docsError && (
          <span className="text-xs text-red-400 inline-flex items-center gap-1">
            <AlertCircle size={12} /> {docsError}
          </span>
        )}
      </div>

      {/* Diagnostics (collapsible) */}
      {state.kind === 'ready' && state.data.diagnostics.length > 0 && (
        <Collapsible open={openDiag} onOpenChange={setOpenDiag}>
          <div className="rounded-lg border border-border-subtle bg-bg-surface">
            <CollapsibleTrigger className="w-full p-4 flex items-center justify-between text-left text-sm font-medium text-text-primary">
              <span>Diagnostics</span>
              <ChevronDown
                size={14}
                className={cn(
                  'transition-transform text-text-muted',
                  openDiag && 'rotate-180',
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-4">
                <ul className="space-y-3">
                  {state.data.diagnostics.map((d) => (
                    <li
                      key={d.command}
                      className="rounded-md border border-border-subtle bg-bg-primary p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-xs font-mono text-text-primary truncate">
                          $ {d.command}
                        </code>
                        <span className={cn(
                          'text-xs px-2 py-0.5 rounded-full shrink-0',
                          d.ok
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-red-500/20 text-red-400',
                        )}>
                          {d.ok ? `ok · exit ${d.exit_code ?? 0}` : `failed · exit ${d.exit_code ?? '?'}`}
                        </span>
                      </div>
                      {d.error && (
                        <p className="text-xs text-red-400 break-words">{d.error}</p>
                      )}
                      {d.stdout_redacted && (
                        <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-words font-mono">
                          {d.stdout_redacted}
                        </pre>
                      )}
                      {d.stderr_redacted && (
                        <pre className="text-[11px] text-amber-400 whitespace-pre-wrap break-words font-mono">
                          {d.stderr_redacted}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {state.kind === 'ready' && state.data.diagnostics.length === 0 && state.data.installed && (
        <div className="text-xs text-text-muted inline-flex items-center gap-1.5">
          <Terminal size={12} /> No diagnostic probes ran. Click Refresh status to retry.
        </div>
      )}
    </div>
  );
}

// ── small presentational helpers ─────────────────────────────────────────────

function Card({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="text-sm font-medium text-text-primary">{title}</div>
      {children}
    </div>
  );
}

function KeyValue({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 text-sm">
          <span className="text-text-muted">{k}</span>
          <span className="text-text-primary font-mono break-all text-right">{v}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ text, subtext }: { text: string; subtext?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-text-primary">{text}</p>
      {subtext && <p className="text-xs text-text-muted">{subtext}</p>}
    </div>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-bg-hover animate-pulse"
          style={{ width: `${60 + ((i * 17) % 35)}%` }}
        />
      ))}
    </div>
  );
}
