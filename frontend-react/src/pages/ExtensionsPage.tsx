/**
 * ExtensionsPage — the "App Store for AI" over MCP servers. A full page
 * (like Models), not a drawer: hero header, category chips, an Installed
 * section with on/off switches, and a Discover grid of store cards.
 *
 * Non-technical-first rules (docs/32):
 *   - The words MCP, server, stdio, JSON-RPC never appear in the UI.
 *   - Level 1: card with name, plain-language description, Install / on-off.
 *   - Level 2: "What can it do?" expands the extension's ability list.
 *   - Errors arrive pre-humanized from the backend and are shown as-is.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2, Loader2, RefreshCw, ShieldAlert, ArrowUpRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  tauri,
  type McpCatalogEntry,
  type McpServerView,
  type McpToolView,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';

// Communication channels live in the dedicated Connectors section now, never
// in Extensions — hide them here even if an old install lingers in mcp.json.
const CONNECTOR_IDS = new Set(['discord', 'slack', 'telegram', 'whatsapp']);

export function ExtensionsPage() {
  const [installed, setInstalled] = useState<McpServerView[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('All');
  const openSkills = useUI((s) => s.openSkills);

  // `alive` is checked before every setState: leaving this page while the two
  // calls are still in flight otherwise updated a component that no longer
  // exists, which React reports in the console on the very first visit.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = () => {
    setError(null);
    Promise.all([tauri.mcp.list(), tauri.mcp.catalog()])
      .then(([list, cat]) => {
        if (!alive.current) return;
        setInstalled(list.filter((s) => !CONNECTOR_IDS.has(s.id)));
        setCatalog(cat.filter((c) => !CONNECTOR_IDS.has(c.id)));
      })
      .catch((e: unknown) => { if (alive.current) setError(String(e)); })
      .finally(() => { if (alive.current) setLoading(false); });
  };

  useEffect(load, []);

  const refresh = () =>
    tauri.mcp.list().then((l) => setInstalled(l.filter((s) => !CONNECTOR_IDS.has(s.id)))).catch(() => {});

  const installedIds = new Set(installed.map((s) => s.id));
  const categories = ['All', ...Array.from(new Set(catalog.map((c) => c.category)))];
  const visible = catalog.filter((c) => category === 'All' || c.category === category);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Hero */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary tracking-tight">
              Capabilities <span aria-hidden="true">✦</span>
            </h1>
            <p className="text-sm text-text-muted mt-1">
              What your assistant can do. Install with one click, switch off anytime.
            </p>
          </div>

          {/* Skills live in a drawer, and the sidebar was the only thing that
              ever opened it. Phase 5 removes the sidebar, so the door moves
              here — skills and extensions are two subsystems to us and one
              question to a user: what can it do? */}
          <button
            type="button"
            onClick={openSkills}
            className="mb-8 w-full text-left rounded-xl border border-border-default bg-bg-surface hover:bg-bg-hover transition-colors p-4 flex items-center gap-3"
          >
            <span aria-hidden="true" className="text-lg">✨</span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-text-primary">Skills</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Written instructions your assistant follows for a particular kind of job.
              </span>
            </span>
            <ArrowUpRight size={15} className="text-text-muted shrink-0" />
          </button>

          {loading && (
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-32 rounded-xl bg-bg-hover animate-pulse" />
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
            <>
              {/* Installed */}
              {installed.length > 0 && (
                <section className="mb-10">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
                    Installed
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    {installed.map((s) => (
                      <InstalledCard key={s.id} server={s} onChanged={refresh} />
                    ))}
                  </div>
                </section>
              )}

              {/* Discover */}
              <section>
                <div className="mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2">
                    Discover
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {categories.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(c)}
                        className={cn(
                          'px-2.5 py-1 rounded-full text-2xs font-medium transition-colors whitespace-nowrap',
                          category === c
                            ? 'bg-brand text-on-brand'
                            : 'bg-bg-hover text-text-muted hover:text-text-secondary',
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {visible.map((entry) => (
                    <CatalogCard
                      key={entry.id}
                      entry={entry}
                      installed={installedIds.has(entry.id)}
                      onInstalled={refresh}
                    />
                  ))}
                </div>
                <p className="text-xs text-text-muted text-center mt-8">
                  More extensions coming in future updates ✨
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Installed card: on/off switch, ability list, remove ──────────────────────

function InstalledCard({
  server,
  onChanged,
}: {
  server: McpServerView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tools, setTools] = useState<McpToolView[] | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await tauri.mcp.setEnabled(server.id, !server.enabled);
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const showTools = async () => {
    if (toolsOpen) {
      setToolsOpen(false);
      return;
    }
    setToolsOpen(true);
    if (tools === null) {
      try {
        setTools(await tauri.mcp.listTools(server.id));
      } catch (e) {
        setErr(String(e));
        setToolsOpen(false);
      }
    }
  };

  const remove = async () => {
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    setBusy(true);
    try {
      await tauri.mcp.remove(server.id);
      onChanged();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
      setRemoveArmed(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-default bg-bg-surface p-4 flex flex-col">
      <div className="flex items-start gap-3">
        {server.logo_url && !logoFailed ? (
          <img
            src={server.logo_url}
            alt=""
            width={32}
            height={32}
            className="w-8 h-8 rounded object-contain shrink-0"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="text-3xl leading-none shrink-0" aria-hidden="true">
            {server.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-text-primary truncate">{server.name}</p>
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full shrink-0',
                server.running ? 'bg-emerald-400' : server.enabled ? 'bg-amber-400' : 'bg-text-muted/40',
              )}
              title={server.running ? 'Running' : server.enabled ? 'Starting…' : 'Off'}
            />
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{server.description}</p>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-label={server.enabled ? 'Turn off' : 'Turn on'}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors mt-0.5 disabled:opacity-50',
            server.enabled ? 'bg-brand' : 'bg-bg-hover border border-border-default',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
              server.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
            )}
          />
        </button>
      </div>

      {err && (
        <p className="text-2xs text-rose-400 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5 mt-2">
          {err}
        </p>
      )}

      <div className="flex items-center justify-between mt-3 pt-2 border-t border-border-subtle">
        <button
          type="button"
          onClick={() => void showTools()}
          disabled={!server.running}
          className="inline-flex items-center gap-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-40"
        >
          What can it do? {toolsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          onBlur={() => setRemoveArmed(false)}
          className={cn(
            'inline-flex items-center gap-1 text-2xs',
            removeArmed ? 'text-rose-400 font-medium' : 'text-text-muted hover:text-rose-400',
          )}
        >
          <Trash2 size={11} /> {removeArmed ? 'Click again to remove' : 'Remove'}
        </button>
      </div>

      {toolsOpen && (
        <div className="mt-2 space-y-1.5">
          {tools === null && <p className="text-2xs text-text-muted">Loading…</p>}
          {tools?.map((t) => (
            <div key={t.name}>
              <p className="text-2xs font-medium text-text-secondary">{prettyToolName(t.name)}</p>
              {t.description && (
                <p className="text-micro text-text-muted line-clamp-2">{t.description}</p>
              )}
            </div>
          ))}
          {tools?.length === 0 && (
            <p className="text-2xs text-text-muted">This extension hasn't shared its abilities yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Catalog card: one-click install, inline config when needed ───────────────

function CatalogCard({
  entry,
  installed,
  onInstalled,
}: {
  entry: McpCatalogEntry;
  installed: boolean;
  onInstalled: () => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Install gate: catalog extensions run third-party code on the user's machine
  // outside Cinderpaw's sandbox (S1 supply-chain). Make that an informed, conscious
  // choice — never a silent one-click — before the install actually spawns it.
  const install = async () => {
    // Needs config the user hasn't provided yet → expand the inline form.
    if (entry.fields.length > 0 && !configOpen) {
      setConfigOpen(true);
      return;
    }
    setConfirmOpen(true);
  };

  const doInstall = async () => {
    setConfirmOpen(false);
    setBusy(true);
    setErr(null);
    try {
      await tauri.mcp.install(entry.id, values);
      onInstalled();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border border-border-default bg-bg-surface p-4 flex flex-col',
        'hover:border-brand/40 transition-colors',
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
            <span className="text-micro px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
              {entry.category}
            </span>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{entry.description}</p>
        </div>
      </div>

      {configOpen && !installed && (
        <div className="mt-3 space-y-2">
          {entry.fields.map((f) => (
            <label key={f.key} className="block">
              <span className="text-2xs text-text-secondary">
                {f.label}
                {f.optional && <span className="text-text-muted"> (optional)</span>}
              </span>
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none"
              />
            </label>
          ))}
        </div>
      )}

      {err && (
        <p className="text-2xs text-rose-400 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5 mt-2">
          {err}
        </p>
      )}

      <div className="mt-auto pt-3">
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy || installed}
          className={cn(
            'w-full text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5',
            installed
              ? 'bg-bg-hover text-text-muted cursor-default'
              : 'bg-brand text-on-brand hover:bg-brand/90',
          )}
        >
          {busy && <Loader2 size={11} className="animate-spin" />}
          {installed
            ? '✓ Installed'
            : // A bare spinner for up to ten minutes reads as frozen. Say what
              // it is actually waiting for — which is the user, in another window.
              busy && entry.browser_login
              ? 'Waiting for you to sign in…'
              : busy
                ? 'Connecting…'
                : configOpen
                  ? 'Confirm & Install'
                  : 'Install'}
        </button>
      </div>

      {/* S1: informed-consent gate. Plain language (no "npm/npx" jargon per the
          non-technical-first rule), but honest that third-party code runs. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert size={16} className="text-amber-400" />
              Add “{entry.name}”?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-text-secondary">
            <p>
              This extension runs third-party software made by its publisher on your
              computer to do its job. It runs with your account’s access, outside
              Cinderpaw’s protected area.
            </p>
            {/* Said BEFORE the install starts, not after. A browser window
                opening by itself looks like something went wrong, and the
                install cannot finish until the user goes and completes the
                sign-in — so they have to know it is coming and that it is
                theirs to finish. */}
            {entry.browser_login && (
              <p className="rounded-lg bg-bg-hover px-3 py-2 text-text-secondary">
                A browser window will open for you to sign in to {entry.name} and
                approve access. Finish that, and this will connect on its own —
                it waits for you, so take the time you need.
              </p>
            )}
            <p className="text-text-muted">
              Only add extensions from publishers you trust.
            </p>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-bg-hover text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doInstall()}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand text-on-brand hover:bg-brand/90"
            >
              Add it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "read_file" → "Read file" — keep ability names human at level 1. */
function prettyToolName(name: string): string {
  const words = name.replace(/[_-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
