import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';

export function ApiServerTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const saving   = useSettings((s) => s.saving);
  const [copied, setCopied] = useState(false);

  const enabled = settings?.api_server_enabled ?? false;
  const port    = settings?.api_port ?? 11435;
  const apiUrl  = `http://localhost:${port}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const btnCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors';
  const rowCls = 'flex items-center justify-between gap-4';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">API Server</h2>

      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Enable API server</p>
          <p className="text-xs text-text-muted mt-0.5">Expose models over a local HTTP API</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => update({ api_server_enabled: !enabled })}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0',
            enabled ? 'bg-blue-500' : 'bg-bg-hover',
          )}
        >
          <span className={cn('absolute top-1 w-4 h-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
        </button>
      </div>

      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Port</p>
          <p className="text-xs text-text-muted mt-0.5">Local port the API server listens on</p>
        </div>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => {
            const val = Number(e.target.value);
            if (val >= 1024 && val <= 65535) update({ api_port: val });
          }}
          className="w-24 px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary text-right"
        />
      </div>

      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Format</p>
          <p className="text-xs text-text-muted mt-0.5">Ollama-compatible + OpenAI-compatible</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-text-primary">API URL</p>
        <div className="flex gap-2">
          <input readOnly value={apiUrl} className="flex-1 px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-muted font-mono" />
          <button type="button" onClick={() => void handleCopy()} className={btnCls}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !settings}
          className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
      </div>
    </div>
  );
}
