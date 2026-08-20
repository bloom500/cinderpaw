/**
 * ConnectorsPage — "Connector Surface". Where you connect the Cinderpaw agent to
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

import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Trash2, ShieldAlert, Check } from 'lucide-react';
import {
  tauri,
  type ConnectorCatalogEntry,
  type ConnectorView,
  type WhatsappQr,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { ConnectorAccounts } from '@/components/connectors/ConnectorAccounts';

export function ConnectorsPage() {
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [saved, setSaved] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `alive` is checked before every setState: leaving this page while the two
  // calls are still in flight otherwise updated a component that no longer
  // exists, which React reports in the console on the very first visit.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = () => {
    setError(null);
    Promise.all([tauri.connectors.catalog(), tauri.connectors.list()])
      .then(([cat, list]) => {
        if (!alive.current) return;
        setCatalog(cat);
        setSaved(list);
      })
      .catch((e: unknown) => { if (alive.current) setError(String(e)); })
      .finally(() => { if (alive.current) setLoading(false); });
  };

  useEffect(load, []);

  const refresh = () => tauri.connectors.list().then(setSaved).catch(() => {});
  const savedById = new Map(saved.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Hero */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary tracking-tight">
              Accounts <span aria-hidden="true">⚯</span>
            </h1>
            <p className="text-sm text-text-muted mt-1">
              Talk to your assistant from the apps you already use. It stays on this machine, with your model and your tools.
            </p>
          </div>

          {/* Accounts that pair by signing in, rather than by pasting a token.
              They come first because a card mid-pairing is showing a code the
              person is holding in their other hand. */}
          <div className="mb-8">
            <ConnectorAccounts />
          </div>

          {/* Security banner */}
          <div className="mb-8 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 flex items-start gap-2.5">
            <ShieldAlert size={15} className="text-amber-800 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed">
              Anyone you add to a connector's allowed list can command your assistant, and everything it can do, on this
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
              {/* coming_soon connectors stay out of the grid — shelf space
                  advertising an absence (audit 2026-07-10, Part 2). The
                  "More connectors coming" line below covers the promise. */}
              {catalog.filter((entry) => !entry.coming_soon).map((entry) => (
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
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [allowlist, setAllowlist] = useState(state?.allowlist.join('\n') ?? '');
  const [channels, setChannels] = useState(state?.channels.join('\n') ?? '');
  const isPublic = (state?.mode ?? 'owner') === 'public';
  const [mode, setMode] = useState<'owner' | 'public'>(isPublic ? 'public' : 'owner');
  const [knowledgeBase, setKnowledgeBase] = useState(state?.knowledgeBase ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const enabled = state?.enabled ?? false;
  const configured = state !== null;
  const isQr = entry.auth_kind === 'qr';
  const linked = state?.linked ?? false;
  const [waQr, setWaQr] = useState<WhatsappQr | null>(null);
  const [stuckPolls, setStuckPolls] = useState(0); // consecutive polls with no QR on disk
  const [nowMs, setNowMs] = useState(() => Date.now());

  // While a QR connector is on but not yet linked, poll for the pairing QR
  // the sidecar mirrors to disk, and re-fetch the card so `linked` flips as
  // soon as the user scans. The GUI must be able to complete the pairing it
  // starts — no terminal window required.
  useEffect(() => {
    if (!isQr || !enabled || linked) {
      setWaQr(null);
      setStuckPolls(0);
      return;
    }
    let alive = true;
    const tick = () => {
      tauri.connectors
        .whatsappQr()
        .then((q) => {
          if (!alive) return;
          setWaQr(q);
          setStuckPolls((n) => (q ? 0 : n + 1));
        })
        .catch(() => {});
    };
    tick();
    const qrTimer = setInterval(tick, 3000);
    const linkTimer = setInterval(onChanged, 10000);
    return () => {
      alive = false;
      clearInterval(qrTimer);
      clearInterval(linkTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChanged is a fresh closure every render; re-subscribing on it would reset the timers
  }, [isQr, enabled, linked]);

  // 1s clock for the QR countdown — only ticks while a code is on screen.
  useEffect(() => {
    if (!waQr) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waQr]);

  // Baileys rotates the pairing code every ~20s; the sidecar rewrites the
  // file on each rotation, so the countdown just restarts at the next poll.
  const QR_TTL_MS = 20_000;
  const qrSecondsLeft = waQr ? Math.max(0, Math.ceil((waQr.ts + QR_TTL_MS - nowMs) / 1000)) : 0;
  const filled = new Set(state?.filled ?? []);
  // Ready to turn on: QR connectors link on connect; token connectors need every
  // field either already saved or freshly typed.
  const ready = isQr || entry.fields.every((f) => filled.has(f.key) || (secrets[f.key]?.trim() ?? '').length > 0);

  const parseList = (value: string) =>
    value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Only send fields the user actually typed; empty = keep what's saved.
      const payload: Record<string, string> = {};
      for (const f of entry.fields) {
        const v = (secrets[f.key] ?? '').trim();
        if (v) payload[f.key] = v;
      }
      await tauri.connectors.save(
        entry.id,
        payload,
        parseList(allowlist),
        parseList(channels),
        entry.id === 'whatsapp' ? mode : undefined,
        entry.id === 'whatsapp' ? knowledgeBase : undefined,
      );
      setSecrets({});
      onChanged();
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
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
      setSecrets({});
      setAllowlist('');
      setChannels('');
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setRemoveArmed(false);
    }
  };

  // Connector-specific wording for the sender / channel lists.
  const allowLabel =
    entry.id === 'whatsapp' ? 'Allowed phone numbers'
      : entry.id === 'slack' ? 'Allowed Slack member IDs'
        : entry.id === 'discord' ? 'Allowed Discord user IDs'
          : 'Allowed sender IDs';
  const allowHint =
    entry.id === 'whatsapp'
      ? ' (with country code, one per line; only these people can reach your assistant)'
      : ' (one per line; only these people can message your assistant)';
  const channelLabel = entry.id === 'whatsapp' ? 'Group chats to answer' : 'Channels with no @mention needed';
  const channelHint =
    entry.id === 'whatsapp'
      ? ' (group IDs, one per line; private chats are always answered)'
      : ' (channel IDs, one per line; it answers every message here, like a dedicated #bot channel)';
  const channelPlaceholder = entry.id === 'whatsapp' ? 'e.g. 120363012345678901@g.us' : 'e.g. 1479216978496458803';

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
              <span className="text-micro px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
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
            disabled={busy || (!enabled && !ready)}
            aria-label={enabled ? 'Turn off' : 'Turn on'}
            title={!enabled && !ready ? 'Add the required tokens first' : undefined}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors mt-0.5 disabled:opacity-40',
              enabled ? 'bg-brand' : 'bg-bg-hover border border-border-default',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
              )}
            />
          </button>
        )}
      </div>

      {!entry.coming_soon && (
        <div className="mt-3 space-y-2">
          {isQr ? (
            <div className="rounded-md border border-border-default bg-bg-primary px-2.5 py-2 text-2xs leading-relaxed">
              {linked ? (
                <span className="text-emerald-400">✅ Linked to WhatsApp.</span>
              ) : enabled && waQr ? (
                <div className="space-y-1.5">
                  <span className="text-text-muted">
                    Scan with <span className="text-text-secondary">WhatsApp → Settings → Linked devices</span>:
                  </span>
                  <pre
                    aria-label="WhatsApp pairing QR code"
                    className="mx-auto w-fit rounded bg-black text-white p-2 font-mono text-micro leading-[8px] select-none"
                  >
                    {waQr.ascii}
                  </pre>
                  <span className="block text-text-muted tabular-nums" role="timer">
                    {qrSecondsLeft > 0
                      ? `New code in ~${qrSecondsLeft}s. No rush, it refreshes here automatically.`
                      : 'Getting a fresh code…'}
                  </span>
                  <span className="block text-amber-300/90">
                    Use a secondary number. Automation can get a number banned.
                  </span>
                </div>
              ) : enabled && stuckPolls > 10 ? (
                <span className="text-amber-300/90">
                  No pairing code is arriving. Turn the connector off and on to retry.
                </span>
              ) : enabled ? (
                <span className="text-text-muted">
                  <Loader2 size={10} className="inline animate-spin mr-1 -mt-0.5" />
                  Getting a QR code ready…
                </span>
              ) : (
                <span className="text-text-muted">
                  Turn this on and a QR code will appear here. Scan it with{' '}
                  <span className="text-text-secondary">WhatsApp → Settings → Linked devices</span>.{' '}
                  <span className="text-amber-300/90">Use a secondary number. Automation can get a number banned.</span>
                </span>
              )}
            </div>
          ) : (
            entry.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-2xs text-text-secondary">
                  {f.label}
                  {filled.has(f.key) && <span className="text-emerald-400/80"> · saved</span>}
                </span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={secrets[f.key] ?? ''}
                  placeholder={filled.has(f.key) ? 'Leave blank to keep current' : ''}
                  onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none"
                />
              </label>
            ))
          )}

          <label className="block">
            <span className="text-2xs text-text-secondary">
              {allowLabel}
              <span className="text-text-muted">{allowHint}</span>
            </span>
            <textarea
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              rows={2}
              placeholder={entry.id === 'whatsapp' ? 'e.g. 40712345678' : 'e.g. 215094730484056064'}
              className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none resize-y font-mono"
            />
          </label>

          <label className="block">
            <span className="text-2xs text-text-secondary">
              {channelLabel}
              <span className="text-text-muted">{channelHint}</span>
            </span>
            <textarea
              value={channels}
              onChange={(e) => setChannels(e.target.value)}
              rows={2}
              placeholder={channelPlaceholder}
              className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none resize-y font-mono"
            />
          </label>

          {entry.id === 'whatsapp' && (
            <div className="rounded-md border border-border-default bg-bg-primary p-2.5 space-y-2">
              <span className="text-2xs text-text-secondary font-medium">Who can it talk to?</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setMode('owner')}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-2xs border transition-colors',
                    mode === 'owner'
                      ? 'border-brand bg-brand/10 text-text-primary'
                      : 'border-border-default text-text-muted hover:text-text-secondary',
                  )}
                >
                  Only people I allow
                </button>
                <button
                  type="button"
                  onClick={() => setMode('public')}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-2xs border transition-colors',
                    mode === 'public'
                      ? 'border-brand bg-brand/10 text-text-primary'
                      : 'border-border-default text-text-muted hover:text-text-secondary',
                  )}
                >
                  Anyone (sales assistant)
                </button>
              </div>
              {mode === 'public' ? (
                <>
                  <p className="text-micro text-text-muted leading-relaxed">
                    New leads who message you get answered automatically by a sales assistant that can ONLY use the
                    knowledge below. It can't touch your files or this computer. Numbers in your allowed list above still
                    get the full assistant.
                  </p>
                  <label className="block">
                    <span className="text-2xs text-text-secondary">
                      What it can tell people
                      <span className="text-text-muted"> (products, prices, FAQ, hours; answers come only from this)</span>
                    </span>
                    <textarea
                      value={knowledgeBase}
                      onChange={(e) => setKnowledgeBase(e.target.value)}
                      rows={6}
                      placeholder={'e.g.\nWe sell handmade leather bags.\nPrices: tote €120, crossbody €85.\nShipping: 3–5 days in the EU, free over €100.\nFor orders or a callback, leave your name and number.'}
                      className="mt-1 w-full rounded-md border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-brand outline-none resize-y"
                    />
                  </label>
                </>
              ) : (
                <p className="text-micro text-text-muted leading-relaxed">
                  Only the phone numbers in your allowed list above can reach your assistant. Best for personal use.
                </p>
              )}
            </div>
          )}

          {err && (
            <p className="text-2xs text-rose-400 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
              {err}
            </p>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-50 transition-colors',
                justSaved ? 'bg-emerald-500' : 'bg-brand hover:bg-brand/90',
              )}
            >
              {busy ? (
                <Loader2 size={11} className="animate-spin" />
              ) : justSaved ? (
                <Check size={12} />
              ) : null}
              {justSaved ? 'Saved' : 'Save'}
            </button>
            {configured && (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
