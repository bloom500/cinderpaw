import { useRef, useState } from 'react';
import { Trash2, AlertCircle, ChevronDown, Play, Square, Server, FlaskConical, CheckCircle, Clock, ShieldAlert, Plug } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { tauri, Channel, type AgentConfig, type AgentEvent, type OpenClawTestMessageResult } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { TOOL_LABELS } from '../agentUtils';

interface Props {
  agent: AgentConfig;
  /** Result of the one-shot openclaw_detect call from AgentsMain.
   *  `null` = still loading; `true` = gateway reachable; `false` = not reachable. */
  gatewayUp?: boolean | null;
  onDelete: () => Promise<void>;
}

export function AgentCard({ agent, gatewayUp, onDelete }: Props) {
  const [confirmOpen, setConfirmOpen]   = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState<string | null>(null);
  const [runOpen, setRunOpen]           = useState(false);

  // Runtime status badge — reflects the agent's persisted openclaw_ready
  // flag plus the live gateway-detect result. The badge is intentionally
  // hidden while the gateway status is still loading.
  const runtimeBadge = (() => {
    if (gatewayUp === null || gatewayUp === undefined) return null;
    if (!gatewayUp) {
      return (
        <span
          data-testid="runtime-badge"
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-hover text-text-muted border border-border-subtle"
        >
          Gateway unavailable
        </span>
      );
    }
    if (agent.openclaw_ready === true) {
      return (
        <span
          data-testid="runtime-badge"
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20"
        >
          OpenClaw ready
        </span>
      );
    }
    return (
      <span
        data-testid="runtime-badge"
        className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20"
      >
        Setup needed
      </span>
    );
  })();

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
      setConfirmOpen(false); // only close on success
    } catch (e) {
      setDeleteError(String(e)); // stay open, surface error
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
        {/* Header row */}
        <div className="p-4 space-y-3">
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
              {runtimeBadge && <div className="mt-1">{runtimeBadge}</div>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setRunOpen((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
                aria-expanded={runOpen}
                aria-label={`${runOpen ? 'Hide' : 'Show'} test panel for ${agent.name}`}
              >
                <Play size={11} />
                Test
                <ChevronDown
                  size={11}
                  className={cn('transition-transform', runOpen && 'rotate-180')}
                />
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                aria-label={`Delete ${agent.name}`}
                className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {!agent.model_id && (
            <p className="text-[11px] text-text-muted">
              No model assigned — load a model in the Models tab to run this agent.
            </p>
          )}
        </div>

        {/* Run panel */}
        {runOpen && <AgentRunPanel agent={agent} />}
      </div>

      {/* Delete confirmation */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!deleting) { setConfirmOpen(open); if (!open) setDeleteError(null); }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete "{agent.name}"?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This will permanently remove the agent profile. This cannot be undone.
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

// ── AgentRunPanel ─────────────────────────────────────────────────────────────

type DisplayItem =
  | { type: 'tool_call';   name: string; args: string }
  | { type: 'tool_result'; name: string; ok: boolean; output: string }
  | { type: 'final';       text: string }
  | { type: 'error';       message: string };

function AgentRunPanel({ agent }: { agent: AgentConfig }) {
  const [runtime, setRuntime]       = useState<Runtime>('local');
  const [prompt, setPrompt]         = useState('');
  const [running, setRunning]       = useState(false);
  const [tokenText, setTokenText]   = useState('');
  const [items, setItems]           = useState<DisplayItem[]>([]);
  const [runError, setRunError]     = useState<string | null>(null);
  const channelRef                  = useRef<Channel<string> | null>(null);

  const hasOutput: boolean = !!(tokenText || items.length > 0 || runError);

  const handleRun = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setTokenText('');
    setItems([]);
    setRunError(null);

    const ch = new Channel<string>();
    channelRef.current = ch;

    ch.onmessage = (raw: string) => {
      try {
        const ev = JSON.parse(raw) as AgentEvent;
        if (ev.kind === 'token') {
          setTokenText((t) => t + ev.text);
        } else if (ev.kind === 'tool_call') {
          setItems((prev) => [...prev, {
            type: 'tool_call',
            name: ev.name,
            args: typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args, null, 2),
          }]);
        } else if (ev.kind === 'tool_result') {
          setItems((prev) => [...prev, {
            type: 'tool_result', name: ev.name, ok: ev.ok, output: ev.output,
          }]);
        } else if (ev.kind === 'final') {
          setTokenText(''); // replace streaming buffer with the final answer
          setItems((prev) => [...prev, { type: 'final', text: ev.text }]);
        } else if (ev.kind === 'error') {
          setItems((prev) => [...prev, { type: 'error', message: ev.message }]);
        }
      } catch {
        // malformed event — ignore
      }
    };

    try {
      await tauri.agents.run(agent.id!, prompt.trim(), ch);
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
      channelRef.current = null;
    }
  };

  return (
    <div className="border-t border-border-subtle bg-bg-primary p-4 space-y-3">
      {/* Runtime selector */}
      <RuntimeSelector value={runtime} onChange={setRuntime} disabled={running} />

      {runtime === 'local' ? (
        <LocalTestBody
          agent={agent}
          prompt={prompt}
          setPrompt={setPrompt}
          running={running}
          tokenText={tokenText}
          items={items}
          runError={runError}
          hasOutput={hasOutput}
          onRun={handleRun}
        />
      ) : (
        <OpenClawTestBody
          agent={agent}
          prompt={prompt}
          setPrompt={setPrompt}
        />
      )}
    </div>
  );
}

// ── Runtime selector ─────────────────────────────────────────────────────────

type Runtime = 'local' | 'openclaw';

function RuntimeSelector({
  value,
  onChange,
  disabled,
}: {
  value: Runtime;
  onChange: (r: Runtime) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
        Runtime
      </span>
      <div className="flex rounded-md border border-border-subtle overflow-hidden">
        <RuntimeButton
          active={value === 'local'}
          disabled={disabled}
          onClick={() => onChange('local')}
          icon={<Server size={11} />}
          label="Local Feral"
        />
        <RuntimeButton
          active={value === 'openclaw'}
          disabled={disabled}
          onClick={() => onChange('openclaw')}
          icon={<FlaskConical size={11} />}
          label="OpenClaw (test)"
        />
      </div>
      <span className="text-[10px] text-amber-400/80">
        OpenClaw-backed routing is experimental
      </span>
    </div>
  );
}

function RuntimeButton({
  active, disabled, onClick, icon, label,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2.5 py-1 text-xs transition-colors inline-flex items-center gap-1.5',
        active
          ? 'bg-bg-active text-text-primary font-medium'
          : 'text-text-secondary hover:bg-bg-hover',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Local Feral test body (unchanged behaviour) ──────────────────────────────

function LocalTestBody({
  agent: _agent,
  prompt, setPrompt, running, tokenText, items, runError, hasOutput, onRun,
}: {
  agent: AgentConfig;
  prompt: string;
  setPrompt: (s: string) => void;
  running: boolean;
  tokenText: string;
  items: DisplayItem[];
  runError: string | null;
  hasOutput: boolean;
  onRun: () => Promise<void> | void;
}) {
  return (
    <>
      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
        Local test — Feral agent only, no OpenClaw routing
      </p>

      <div className="flex gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onRun();
            }
          }}
          placeholder="Enter a prompt… (Enter to run, Shift+Enter for newline)"
          rows={2}
          disabled={running}
          className="flex-1 rounded-md border border-bg-hover bg-bg-surface px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted resize-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={running || !prompt.trim()}
          aria-label={running ? 'Stop agent' : 'Run agent'}
          className="shrink-0 px-3 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
        >
          {running ? <Square size={11} /> : <Play size={11} />}
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      {hasOutput && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {tokenText && (
            <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words bg-bg-hover rounded p-2">
              {tokenText}
              {running && <span className="animate-pulse">▌</span>}
            </pre>
          )}
          {items.map((item, i) => {
            if (item.type === 'tool_call') {
              return (
                <div key={i} className="rounded border border-border-subtle bg-bg-surface p-2 space-y-1">
                  <p className="text-[11px] font-medium text-text-muted">
                    🔧 Calling <span className="text-text-primary">{item.name}</span>
                  </p>
                  {item.args && item.args !== '{}' && (
                    <pre className="text-[10px] text-text-muted font-mono whitespace-pre-wrap break-words">
                      {item.args}
                    </pre>
                  )}
                </div>
              );
            }
            if (item.type === 'tool_result') {
              return (
                <div key={i} className={cn(
                  'rounded border p-2 space-y-1',
                  item.ok
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-red-500/20 bg-red-500/5',
                )}>
                  <p className="text-[11px] font-medium text-text-muted">
                    {item.ok ? '✓' : '✗'} Result from <span className="text-text-primary">{item.name}</span>
                  </p>
                  <pre className="text-[10px] text-text-muted font-mono whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                    {item.output}
                  </pre>
                </div>
              );
            }
            if (item.type === 'final') {
              return (
                <div key={i} className="rounded border border-brand/30 bg-brand/5 p-3">
                  <p className="text-[11px] font-medium text-brand mb-1">Answer</p>
                  <p className="text-xs text-text-primary whitespace-pre-wrap break-words">{item.text}</p>
                </div>
              );
            }
            if (item.type === 'error') {
              return (
                <div key={i} className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2">
                  <AlertCircle size={11} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-400">{item.message}</p>
                </div>
              );
            }
            return null;
          })}
          {runError && (
            <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2">
              <AlertCircle size={11} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-400">{runError}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── OpenClaw test-mode body (NEW) ────────────────────────────────────────────

function OpenClawTestBody({
  agent,
  prompt,
  setPrompt,
}: {
  agent: AgentConfig;
  prompt: string;
  setPrompt: (s: string) => void;
}) {
  const [testing, setTesting]       = useState(false);
  const [result, setResult]         = useState<OpenClawTestMessageResult | null>(null);
  const [invokeError, setInvokeErr] = useState<string | null>(null);

  const handleTest = async () => {
    if (!prompt.trim() || testing || !agent.id) return;
    setTesting(true);
    setResult(null);
    setInvokeErr(null);
    try {
      const r = await tauri.openclaw.testAgentMessage(agent.id, prompt.trim(), null);
      setResult(r);
    } catch (e) {
      setInvokeErr(String(e));
    } finally {
      setTesting(false);
    }
  };

  const hasSystemPrompt = agent.system_prompt.trim().length > 0;
  const systemPreview = hasSystemPrompt
    ? agent.system_prompt.length > 200
      ? agent.system_prompt.slice(0, 200).trimEnd() + '…'
      : agent.system_prompt
    : null;

  return (
    <>
      <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
        <p className="text-[11px] font-medium text-amber-400 inline-flex items-center gap-1.5">
          <FlaskConical size={11} /> OpenClaw test mode
        </p>
        <p className="text-[11px] text-text-muted">
          Sends one prompt to the local OpenClaw gateway via{' '}
          <code className="text-text-secondary">POST /v1/chat/completions</code>{' '}
          using model <code className="text-text-secondary">openclaw/default</code>.
          No sessions, no persistence — read-only against your gateway.
        </p>
        {systemPreview && (
          <details className="text-[11px]">
            <summary className="text-text-muted cursor-pointer hover:text-text-secondary">
              System prompt (from agent, sent as <code>system</code> message)
            </summary>
            <pre className="mt-1.5 text-text-secondary font-mono whitespace-pre-wrap break-words bg-bg-primary rounded p-2 max-h-32 overflow-y-auto">
              {systemPreview}
            </pre>
          </details>
        )}
      </div>

      <div className="flex gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleTest();
            }
          }}
          placeholder="Enter one prompt to test… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={testing}
          className="flex-1 rounded-md border border-bg-hover bg-bg-surface px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted resize-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing || !prompt.trim()}
          aria-label="Test with OpenClaw"
          className="shrink-0 px-3 py-2 rounded-md bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
        >
          <FlaskConical size={11} />
          {testing ? 'Sending…' : 'Test with OpenClaw'}
        </button>
      </div>

      {/* Result area */}
      {(result || invokeError) && (
        <OpenClawResultPanel result={result} invokeError={invokeError} />
      )}
    </>
  );
}

function OpenClawResultPanel({
  result,
  invokeError,
}: {
  result: OpenClawTestMessageResult | null;
  invokeError: string | null;
}) {
  if (invokeError) {
    return (
      <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2.5">
        <AlertCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0">
          <p className="text-[11px] font-medium text-red-400">Test failed</p>
          <p className="text-[11px] text-red-400 break-words">{invokeError}</p>
        </div>
      </div>
    );
  }
  if (!result) return null;

  // 401/403 cases are mapped to kind=unsupported by the backend, with a
  // message that includes the OPENCLAW_GATEWAY_TOKEN hint. Detect that
  // specifically so the UI can show a clear auth-required state.
  const msgLower = (result.error_message ?? '').toLowerCase();
  const isAuthRequired = result.kind === 'unsupported'
    && (msgLower.includes('openclaw_gateway_token') || msgLower.includes('gateway.auth'));

  if (result.kind === 'ok') {
    return (
      <div className="rounded border border-green-500/20 bg-green-500/5 p-2.5 space-y-1">
        <p className="text-[11px] font-medium text-green-400 inline-flex items-center gap-1.5">
          <CheckCircle size={12} /> OpenClaw responded
        </p>
        {result.response_text && (
          <p className="text-xs text-text-primary whitespace-pre-wrap break-words">
            {result.response_text}
          </p>
        )}
        {result.endpoint_tried && (
          <p className="text-[10px] text-text-muted font-mono break-all">
            {result.endpoint_tried}
          </p>
        )}
      </div>
    );
  }
  if (result.kind === 'timeout') {
    return (
      <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5">
        <Clock size={12} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0">
          <p className="text-[11px] font-medium text-amber-400">Timeout</p>
          <p className="text-[11px] text-amber-400 break-words">
            {result.error_message ?? 'No response within 15s.'}
          </p>
          {result.endpoint_tried && (
            <p className="text-[10px] text-text-muted font-mono break-all">
              {result.endpoint_tried}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (isAuthRequired) {
    return (
      <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2.5">
        <ShieldAlert size={12} className="text-red-400 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0">
          <p className="text-[11px] font-medium text-red-400">Auth required</p>
          <p className="text-[11px] text-red-400 break-words">
            {result.error_message}
          </p>
          <p className="text-[11px] text-text-muted">
            Set the token in <span className="text-text-secondary">Settings → OpenClaw → Connection</span>,
            then retry.
          </p>
        </div>
      </div>
    );
  }
  if (result.kind === 'unsupported' || result.kind === 'capability_missing') {
    return (
      <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5">
        <Plug size={12} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0">
          <p className="text-[11px] font-medium text-amber-400">Gateway not ready</p>
          <p className="text-[11px] text-amber-400 break-words">
            {result.error_message ?? 'OpenClaw gateway is not reachable.'}
          </p>
          {result.endpoint_tried && (
            <p className="text-[10px] text-text-muted font-mono break-all">
              {result.endpoint_tried}
            </p>
          )}
        </div>
      </div>
    );
  }
  // error
  return (
    <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2.5">
      <AlertCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
      <div className="space-y-1 min-w-0">
        <p className="text-[11px] font-medium text-red-400">Error</p>
        <p className="text-[11px] text-red-400 break-words">
          {result.error_message ?? 'Unknown error.'}
        </p>
        {result.endpoint_tried && (
          <p className="text-[10px] text-text-muted font-mono break-all">
            {result.endpoint_tried}
          </p>
        )}
      </div>
    </div>
  );
}
