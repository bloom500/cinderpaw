/**
 * ConnectorsPage — "Connector Surface". Where you connect the Feral agent to
 * the places you already chat (Discord today; Telegram/WhatsApp/Slack soon) so
 * you can talk to your LOCAL assistant from there. Sits right under Extensions.
 *
 * Non-technical-first (docs/32): no jargon. A connector is "an app your
 * assistant can talk through". The bot token is the only technical bit, framed
 * plainly. The allowlist is "who is allowed to message your assistant".
 *
 * Security note shown in the UI: anyone on the allowlist can command the
 * assistant — and its tools — on this machine. Empty allowlist = nobody.
 */

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2, ShieldAlert } from 'lucide-react';
import {
  tauri,
  type ConnectorCatalogEntry,
  type ConnectorView,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';

export function ConnectorsPage() {
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [saved, setSaved] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    Promise.all([tauri.connectors.catalog(), tauri.connectors.list()])
      .then(([cat, list]) => {
        setCatalog(cat);
        setSaved(list);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const refresh = () => tauri.connectors.list().then(setSaved).catch(() => {});
  const savedById = new Map(saved.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Hero */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary tracking-tight">
              Connectors <span aria-hidden="true">🔌</span>
            </h1>
            <p className="text-sm text-text-muted mt-1">
              Talk to your assistant from the apps you already use — it stays on this machine, with your model and your tools.
            </p>
          </div>

          {/* Security banner */}
          <div className="mb-8 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 flex items-start gap-2.5">
            <ShieldAlert size={15} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[12px] text-amber-200/90 leading-relaxed">
              Anyone you add to a connector's allowed list can command your assistant — and everything it can do — on this
              computer. Add only people you trust. Leave the list empty and no one but you can reach it.
            </p>
          </div>

          {loading && (
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-40 rounded-xl bg-bg-hover animate-pulse" />
              ))}
            </div>
          )}

          {error && !loading && (
            <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 flex items-start gap-3">
              <p className="text-sm text-rose-400 flex-1">{error}</p>
              <button
                type="button"
                onClick={load}
                className="text-xs text-text-muted hover:text-text-secondary inline-flex items-center gap-1 shrink-0"
              >
                <RefreshCw size={11} /> Try again
              </button>
            </div>
          )}

          {!loading && !error && (
            <div className="grid grid-cols-2 gap-3">
              {catalog.map((entry) => (
                <ConnectorCard
                  key={entry.id}
                  entry={entry}
                  state={savedById.get(entry.id) ?? null}
                  onChanged={refresh}
                />
              ))}
            </div>
          )}

          <p className="text-xs text-text-muted text-center mt-8">
            More connectors coming in future updates ✨
          </p>
        </div>
      </div>
    </div>
  );
}

// ── One connector card: config (token + allowlist), enable, remove ───────────

function ConnectorCard({
  entry,
  state,
  onChanged,
}: {
  entry: ConnectorCatalogEntry;
  state: ConnectorView | null;
  onChanged: () => void;
}) {
  const [token, setToken] = useState('');
  const [allowlist, setAllowlist] = useState(state?.allowlist.join('\n') ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);

  const hasToken = state?.has_token ?? false;
  const enabled = state?.enabled ?? false;
  const configured = state !== null;

  const parseAllowlist = () =>
    allowlist
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Empty token field means "keep what's saved" (and seed from the Discord
      // extension if nothing is stored yet).
      await tauri.connectors.save(entry.id, token.trim() || null, parseAllowlist());
      setToken('');
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await tauri.connectors.setEnabled(entry.id, !enabled);
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    setBusy(true);
    try {
      await tauri.connectors.remove(entry.id);
      setToken('');
      setAllowlist('');
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setRemoveArmed(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border bg-bg-surface p-4 flex flex-col',
        entry.coming_soon ? 'border-border-subtle opacity-60' : 'border-border-default',
      )}
    >
      <div className="flex items-start gap-3">
        {entry.logo_url && !logoFailed ? (
          <img
            src={entry.logo_url}
            alt=""
            width={32}
            height={32}
            className="w-8 h-8 rounded object-contain shrink-0"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="text-3xl leading-none shrink-0" aria-hidden="true">
            {entry.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-text-primary truncate">{entry.name}</p>
            {entry.coming_soon ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
                Coming soon
              </span>
            ) : (
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  enabled ? 'bg-emerald-400' : 'bg-text-muted/40',
                )}
                title={enabled ? 'On' : 'Off'}
              />
            )}
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{entry.description}</p>
        </div>

        {!entry.coming_soon && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy || (!enabled && !hasToken)}
            aria-label={enabled ? 'Turn off' : 'Turn on'}
            title={!enabled && !hasToken ? 'Add a bot token first' : undefined}
            className={cn(
              'relative h-5 w-9 rounded-full transition-colors shrink-0 mt-0.5 disabled:opacity-40',
              enabled ? 'bg-brand' : 'bg-bg-hover border border-border-default',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </button>
        )}
      </div>

      {!entry.coming_soon && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[11px] text-text-secondary">
              {entry.token_label}
              {hasToken && <span className="text-emerald-400/80"> · saved</span>}
            </span>
            <input
              type="password"
              value={token}
              placeholder={hasToken ? 'Leave blank to keep current token' : ''}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-text-secondary">
              Allowed Discord user IDs
              <span className="text-text-muted"> (one per line — only these people can message your assistant)</span>
            </span>
            <textarea
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              rows={2}
              placeholder="e.g. 215094730484056064"
              className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none resize-y font-mono"
            />
          </label>

          {err && (
            <p className="text-[11px] text-rose-400 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
              {err}
            </p>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50"
            >
              {busy && <Loader2 size={11} className="animate-spin" />}
              Save
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => void remove()}
                onBlur={() => setRemoveArmed(false)}
                className={cn(
                  'inline-flex items-center gap-1 text-[11px]',
                  removeArmed ? 'text-rose-400 font-medium' : 'text-text-muted hover:text-rose-400',
                )}
              >
                <Trash2 size={11} /> {removeArmed ? 'Click again to remove' : 'Remove'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
