import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, ExternalLink, RefreshCw, Terminal, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tauri, type OpenClawStatusResult, type OpenClawTestMessageResult, type TestMessageKind, type OpenClawConnectionView } from '@/lib/tauri';
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
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-text-primary">OpenClaw</h2>
        <p className="text-xs text-text-muted">
          Detect an external OpenClaw agent runtime installed on this machine.
          Feral does not start, configure, or store credentials for OpenClaw.
        </p>
        <p className="text-xs text-amber-400/80">
          OpenClaw-backed agent routing is not yet enabled in this version.
          This panel is read-only detection only.
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
              <KeyValue rows={[
                ['Status', 'Running'],
                ...(state.data.gateway_endpoint
                  ? [['Endpoint', state.data.gateway_endpoint] as [string, string]]
                  : []),
              ]} />
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

      {/* Capabilities card */}
      <Card title="Capabilities">
        {state.kind === 'ready' ? (
          state.data.capabilities.length > 0 ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {state.data.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20"
                  >
                    {cap}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-text-muted">
                Read-only detection only — agent routing not yet enabled.
              </p>
            </div>
          ) : (
            <EmptyHint
              text="No capabilities confirmed yet."
              subtext="OpenClaw must be installed and the gateway must be running."
            />
          )
        ) : (
          <Skeleton lines={2} />
        )}
      </Card>

      {/* Gateway auth */}
      <OpenClawAuthPanel />

      {/* Test message panel */}
      {state.kind !== 'idle' && (
        <TestMessagePanel
          capabilities={state.kind === 'ready' ? state.data.capabilities : []}
          gatewayEndpoint={state.kind === 'ready' ? state.data.gateway_endpoint : null}
        />
      )}

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

// ── TestMessagePanel ──────────────────────────────────────────────────────────

const DEFAULT_TEST_PROMPT = 'Reply with one short sentence confirming the connection is working.';

function canSendTest(capabilities: string[]): boolean {
  return capabilities.includes('gateway') && capabilities.includes('health_check');
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'result'; data: OpenClawTestMessageResult };

type AuthSaveState = 'idle' | 'saving' | 'saved' | 'error';

function TestMessagePanel({
  capabilities,
  gatewayEndpoint,
}: {
  capabilities: string[];
  gatewayEndpoint: string | null;
}) {
  const [prompt, setPrompt]   = useState(DEFAULT_TEST_PROMPT);
  const [test, setTest]       = useState<TestState>({ kind: 'idle' });
  const enabled               = canSendTest(capabilities);
  const sending               = test.kind === 'sending';

  const handleSend = async () => {
    if (!enabled || sending) return;
    setTest({ kind: 'sending' });
    try {
      const result = await tauri.openclaw.testMessage(prompt.trim(), gatewayEndpoint);
      setTest({ kind: 'result', data: result });
    } catch (e) {
      setTest({
        kind: 'result',
        data: {
          kind: 'error',
          response_text: null,
          error_message: String(e),
          endpoint_tried: gatewayEndpoint,
        },
      });
    }
  };

  return (
    <Card title="Send test message">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Send a single explicit message to the detected OpenClaw gateway.
          This is a connection test only — not full agent routing.
        </p>

        {!enabled && (
          <p className="text-xs text-amber-400/80">
            Requires both <code className="font-mono">gateway</code> and{' '}
            <code className="font-mono">health_check</code> capabilities to be confirmed.
          </p>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!enabled || sending}
            className="flex-1 rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!enabled || sending || !prompt.trim()}
            className="px-3 py-1.5 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : 'Send test message'}
          </button>
        </div>

        {test.kind === 'result' && <TestResultDisplay result={test.data} />}
      </div>
    </Card>
  );
}

// ── OpenClawAuthPanel ─────────────────────────────────────────────────────────

function OpenClawAuthPanel() {
  const [view, setView]                   = useState<OpenClawConnectionView | null>(null);
  const [endpointInput, setEndpointInput] = useState('');
  const [tokenInput, setTokenInput]       = useState('');
  const [saveState, setSaveState]         = useState<AuthSaveState>('idle');
  const [saveError, setSaveError]         = useState<string | null>(null);
  const [clearing, setClearing]           = useState(false);

  useEffect(() => {
    void tauri.openclaw.getConnectionSettings().then((v) => {
      setView(v);
      setEndpointInput(v.endpoint_override ?? '');
    });
  }, []);

  const handleSave = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      const ep  = endpointInput.trim();
      const tok = tokenInput.trim() || null;
      await tauri.openclaw.saveConnectionSettings(ep, tok);
      const updated = await tauri.openclaw.getConnectionSettings();
      setView(updated);
      setTokenInput('');
      setSaveState('saved');
    } catch (e) {
      setSaveError(String(e));
      setSaveState('error');
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      await tauri.openclaw.clearToken();
      const updated = await tauri.openclaw.getConnectionSettings();
      setView(updated);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card title="Gateway auth">
      <div className="space-y-4">
        <p className="text-xs text-text-muted">
          Stored in Feral settings only — does not modify OpenClaw config.
        </p>

        {/* Endpoint override */}
        <div className="space-y-1">
          <label className="text-xs text-text-muted">Endpoint override (optional, loopback only)</label>
          <input
            type="text"
            value={endpointInput}
            onChange={(e) => setEndpointInput(e.target.value)}
            placeholder="Endpoint override — e.g. http://localhost:18789"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
        </div>

        {/* Token */}
        <div className="space-y-1.5">
          <label className="text-xs text-text-muted">Gateway token</label>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste gateway token to replace saved token"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
          {view && (
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  view.has_token ? 'bg-green-400' : 'bg-text-muted',
                )}
              />
              <span className="text-xs text-text-muted">
                {view.has_token ? 'Token saved' : 'No token saved'}
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saveState === 'saving'}
            className="px-3 py-1.5 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saveState === 'saving' ? 'Saving…' : 'Save token'}
          </button>
          {view?.has_token && (
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={clearing}
              className="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
            >
              {clearing ? 'Clearing…' : 'Clear token'}
            </button>
          )}
          {saveState === 'error' && saveError && (
            <span className="text-xs text-red-400">{saveError}</span>
          )}
        </div>
      </div>
    </Card>
  );
}

function TestResultDisplay({ result }: { result: OpenClawTestMessageResult }) {
  const kindLabel: Record<TestMessageKind, string> = {
    ok:                 'Connected',
    timeout:            'Timeout',
    unsupported:        'Unsupported',
    capability_missing: 'Capability missing',
    error:              'Error',
  };
  const kindColor: Record<TestMessageKind, string> = {
    ok:                 'bg-green-500/20 text-green-400',
    timeout:            'bg-amber-500/20 text-amber-400',
    unsupported:        'bg-amber-500/20 text-amber-400',
    capability_missing: 'bg-bg-hover text-text-muted',
    error:              'bg-red-500/20 text-red-400',
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-primary p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={cn('text-[11px] px-2 py-0.5 rounded-full', kindColor[result.kind])}>
          {kindLabel[result.kind]}
        </span>
        {result.endpoint_tried && (
          <code className="text-[10px] text-text-muted font-mono truncate">
            {result.endpoint_tried}
          </code>
        )}
      </div>
      {result.response_text && (
        <p className="text-sm text-text-primary whitespace-pre-wrap break-words">
          {result.response_text}
        </p>
      )}
      {result.error_message && (
        <p className="text-xs text-red-400 break-words">{result.error_message}</p>
      )}
      {result.kind === 'unsupported' &&
        result.error_message != null &&
        /401|403|auth/i.test(result.error_message) && (
          <p className="text-xs text-amber-400/90 mt-1">
            Token required — enter your token in the Gateway auth panel above, then retry.
          </p>
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
