import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNotifications } from '@/stores/notifications';
import { Brain, RefreshCw, Sparkles } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import type { MemoryGraphNodeView, DreamEpisode, MemoryNotesLine } from '@/lib/tauri';
import { stopReasonWords, triggerWords } from '@/lib/rsiWords';
import { cn } from '@/lib/utils';
import { rsiState, type RsiSnapshot, type RsiPhase } from './rsiState';

/**
 * Settings > Memory — the user-friendly surface of Cinderpaw's FMS + RSI systems.
 *
 * We deliberately NO LONGER draw a stylized tree: matching a hand-painted
 * reference procedurally takes more artistic range than a runtime renderer
 * can give, and the result was distracting instead of helpful. Non-technical
 * users care about three things, all surfaced here:
 *
 *   1. What does Cinderpaw remember about me?   → one list, newest first, with
 *      filter chips by kind, a tag, when, and Forget (spec 7.4, 28 Sep).
 *   2. Is Cinderpaw self-improving right now?   → live RSI pill (idle / dreaming /
 *      ratcheted / error) tied to actual engine events.
 *   3. Has Cinderpaw been dreaming?            → recent dream episodes with score
 *      progression so the user sees something actually changing.
 *
 * A live dream pulses the "Cinderpaw's Dreams" panel; a ratchet flashes the
 * best score line. Colours come from the project theme tokens so this page
 * adapts automatically to light / dark mode.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a memory is, in the three words the page filters by (spec 7.4). The
 * engine keeps thirteen categories (memory/semantic.ts); a person asks for
 * fewer. Plans in motion (a goal, a decision, a commitment, a dated event) are
 * Projects; what is neither a preference nor a plan is a Fact, and so is a row
 * whose category the engine did not send (an older engine, an orphan node).
 */
export type MemoryKind = 'preference' | 'fact' | 'project';
const PLANS = new Set(['goal', 'decision', 'commitment', 'event']);
export function kindOf(category: string | undefined): MemoryKind {
  if (category === 'preference') return 'preference';
  return category && PLANS.has(category) ? 'project' : 'fact';
}
const KIND: Record<MemoryKind, { chip: string; tag: string; cls: string }> = {
  preference: { chip: 'Preferences', tag: 'Preference', cls: 'bg-bg-active text-brand' },
  fact:       { chip: 'Facts',       tag: 'Fact',       cls: 'bg-success/15 text-success' },
  project:    { chip: 'Projects',    tag: 'Project',    cls: 'bg-info/15 text-info' },
};

/** "Today", "Yesterday", "3 days ago", "Last week", then the date. Calendar
 *  days, so a fact from 23:50 is "Yesterday" at 00:10. */
export function whenLabel(now: number, ts: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(ts)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatTimeAgo(now: number, ts: number): string {
  const dt = Math.max(0, now - ts);
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < DAY_MS) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / DAY_MS)}d ago`;
}

/** Every fact, one row each: what it says, its kind, when, and Forget. */
function FactList({
  rows,
  kindOfRow,
  now,
  onForget,
}: {
  rows: MemoryGraphNodeView[];
  kindOfRow: (n: MemoryGraphNodeView) => MemoryKind;
  now: number;
  onForget: (n: MemoryGraphNodeView) => void;
}) {
  return (
    <ul className="flex flex-col rounded-2xl border border-border-default bg-bg-surface">
      {rows.map((n, i) => {
        const k = KIND[kindOfRow(n)];
        return (
          <li key={n.id} className={cn('flex items-center gap-3.5 px-4 py-3.5', i > 0 && 'border-t border-border-subtle')}>
            <span className="min-w-0 flex-1 text-sm text-text-primary">{n.label}</span>
            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-2xs font-semibold ${k.cls}`}>{k.tag}</span>
            <span className="w-20 shrink-0 text-xs text-text-muted">{whenLabel(now, n.touched_at)}</span>
            {/* Everything it knows about you is on this page, so everything on
                it can be taken back. A row with no edge has nothing to send. */}
            {n.edge ? (
              <button
                type="button"
                aria-label={`Forget: ${n.label}`}
                onClick={() => onForget(n)}
                className="h-[30px] shrink-0 rounded-lg border border-border-default bg-bg-elevated px-2.5 text-xs text-text-muted hover:border-error/60 hover:text-error"
              >
                Forget
              </button>
            ) : (
              <span className="w-[62px] shrink-0" aria-hidden />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-[#e8731c]',
  med: 'bg-[#c66a25]',
  low: 'bg-text-muted',
};

/**
 * What Cinderpaw carries into every new conversation: the summary the
 * Reflector writes about the user, and the dated notes the Observer keeps.
 * Everything here can be deleted, and when writing fails the reason is on
 * this screen, not only in a log the person does not have open.
 */
function NotesPanel({
  reply,
  now,
  onDelete,
}: {
  reply: MemoryNotesLine | null;
  now: number;
  onDelete: (id: number) => void;
}) {
  const observer = reply?.health.observer;
  const reflector = reply?.health.reflector;
  return (
    <section className="rounded-lg border border-border-default bg-bg-surface/80 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Brain size={14} className="text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">
          What Cinderpaw remembers
        </h2>
      </header>
      {reply === null ? (
        <p className="text-xs text-text-muted">Notes are not available while the agent is starting.</p>
      ) : (
        <>
          <p className="whitespace-pre-line text-sm text-text-primary">
            {reply.card ?? 'No summary yet. It is written after a few conversations, while Cinderpaw is idle.'}
          </p>
          <div className="mt-2 space-y-1 text-xs">
            {observer && observer.failures > 0 ? (
              <p className="text-error-text">Could not write notes: {observer.lastError}</p>
            ) : observer?.lastOkAt ? (
              <p className="text-text-muted">Last note: {formatTimeAgo(now, observer.lastOkAt)}</p>
            ) : null}
            {reflector && reflector.failures > 0 && (
              <p className="text-error-text">Could not update the summary: {reflector.lastError}</p>
            )}
          </div>
          {reply.notes.length === 0 ? (
            <p className="mt-3 text-xs text-text-muted">No notes yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {reply.notes.map((n) => (
                <li
                  key={n.id}
                  className="group/row flex items-start gap-3 rounded border border-border-subtle bg-bg-primary/40 px-3 py-2"
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[n.priority] ?? PRIORITY_DOT.low}`} />
                  <div className="flex-1 text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-text-muted">
                      <span className="font-mono">{new Date(n.observedAt).toISOString().slice(0, 10)}</span>
                      {n.refDate && <span>for {n.refDate}</span>}
                      {n.source === 'reflector' && (
                        <span className="rounded border border-border-default px-1 text-micro uppercase">summary</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-text-primary">{n.text}</p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete note: ${n.text}`}
                    onClick={() => onDelete(n.id)}
                    className="shrink-0 rounded-md border border-border-default px-2 py-0.5 text-micro text-text-secondary opacity-0 transition-opacity hover:border-error/60 hover:text-error-text focus-visible:opacity-100 group-hover/row:opacity-100"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Dream episode card — last N dream cycles, newest first. */
function DreamCard({ ep, now, bestScore }: { ep: DreamEpisode; now: number; bestScore: number | null }) {
  const improve = bestScore !== null && ep.ratchets > 0;
  return (
    <div className="rounded border border-border-subtle bg-bg-primary/40 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-mono text-brand">
          {ep.iterations} {ep.iterations === 1 ? 'idea tried' : 'ideas tried'}
        </span>
        <span className="text-text-muted">{formatTimeAgo(now, ep.startedAt)}</span>
      </div>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-micro text-text-secondary">
        <span className="text-text-muted">why</span><span>{triggerWords(ep.trigger)}</span>
        <span className="text-text-muted">ended</span><span>{ep.stopReason ? stopReasonWords(ep.stopReason) : 'finished'}</span>
        <span className="text-text-muted">improvements</span><span className={ep.ratchets > 0 ? 'text-warning' : ''}>{ep.ratchets}</span>
        {improve && (
          <>
            <span className="text-text-muted">best score</span>
            <span className="text-warning">{bestScore?.toFixed(1)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Live RSI pill — same data as before, now lives above the Cinderpaw's Dreams
 *  panel so the connection is obvious. */
function RsiHud({ snapshot }: { snapshot: RsiSnapshot }) {
  const phase = snapshot.phase;
  const tone =
    phase === 'dreaming' ? 'border-[#e8731c] text-[#e8731c]'
    : phase === 'ratcheted' ? 'border-warning text-warning'
    : phase === 'error'    ? 'border-error text-error'
                            : 'border-border-default text-text-secondary';
  const dot =
    phase === 'dreaming' ? 'bg-[#e8731c] animate-pulse'
    : phase === 'ratcheted' ? 'bg-warning'
    : phase === 'error'    ? 'bg-error'
                            : 'bg-text-muted';
  // Said the way a person would, not in the engine's words ("RSI", "ratchet",
  // "champion", "params" are all names from the code).
  const label =
    phase === 'dreaming' ? 'Learning'
    : phase === 'ratcheted' ? 'Improved'
    : phase === 'error'    ? 'Learning paused'
                            : 'Resting';
  const detail =
    phase === 'dreaming' ? 'trying better ways to answer you'
    : phase === 'ratcheted' ? 'a better version is now in use'
    : snapshot.lastRatchetAt
      ? `last improved ${formatTimeAgo(Date.now(), snapshot.lastRatchetAt)}`
      : 'no improvements yet';
  return (
    <div className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border bg-bg-surface px-3 py-1.5 text-2xs backdrop-blur-sm ${tone}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <Brain size={12} className="opacity-70" />
      <span className="font-medium">{label}</span>
      <span className="opacity-70">· {detail}</span>
    </div>
  );
}


/**
 * A memory is a fact, and a fact is an EDGE of the graph: `language —is→ Romanian`.
 * The page used to list the graph's nodes, so the same fact showed up as two
 * bare rows, "language" and "Romanian", with the relation nowhere (20 Sep).
 * Each edge becomes one row in the shape the list already understands; a node
 * with no edge at all (there should be none) is kept as it was.
 */
export function factsOf(graph: { nodes: MemoryGraphNodeView[]; edges: { from: string; to: string; relation: string }[] }): MemoryGraphNodeView[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const linked = new Set<string>();
  const rows: MemoryGraphNodeView[] = [];
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    linked.add(from.id);
    linked.add(to.id);
    rows.push({
      id: `${e.from} ${e.relation} ${e.to}`,
      // "language has Romanian" read as a database row. `is` and `has` carry
      // no meaning a colon does not, so those become "Language: Romanian".
      label: /^(is|has)$/i.test(e.relation)
        ? `${from.label.charAt(0).toUpperCase()}${from.label.slice(1).replace(/_/g, ' ')}: ${to.label}`
        : `${from.label} ${e.relation.replace(/_/g, ' ')} ${to.label}`,
      type: e.relation,
      touched_at: Math.max(from.touched_at, to.touched_at),
      edge: { from: e.from, to: e.to, relation: e.relation },
    });
  }
  for (const n of graph.nodes) if (!linked.has(n.id)) rows.push(n);
  return rows;
}

export default function MemoryLayersPage() {
  const [nodes, setNodes] = useState<MemoryGraphNodeView[]>([]);
  const [notesReply, setNotesReply] = useState<MemoryNotesLine | null>(null);
  const [dreamLast, setDreamLast] = useState<DreamEpisode[]>([]);
  const [bestScore, setBestScore] = useState<number | null>(null);
  // True from the first paint. Starting false made the hero announce
  // "Cinderpaw hasn't remembered anything yet" to someone with hundreds of
  // memories, every single time the tab was opened, for as long as the read
  // took -- and it left that sentence standing as a fact when the read failed.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // State, not a ref: mutating a ref never triggers a render and
  // `setNow(n => n)` bails on Object.is, so the HUD pill froze on its
  // initial phase until some unrelated state happened to change.
  const [rsiSnap, setRsiSnap] = useState<RsiSnapshot>(() => rsiState.snapshot());

  // Tick the clock so "Xs ago" stays accurate without prop drilling.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // One subscription covers live RSI phase + drives the HUD pill re-render.
  // The store hands out a fresh snapshot object per update, so this
  // always re-renders when something actually changed.
  useEffect(() => {
    return rsiState.subscribe((snap) => {
      setRsiSnap(snap);
      if (snap.lastRatchetScore !== undefined) setBestScore(snap.lastRatchetScore);
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [graph, telemetry, rsi, notesNow] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.dreamTelemetry(20).catch(() => ({ episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [] })),
        tauri.rsi.status().catch(() => null),
        tauri.memory.notes('list').catch(() => null),
      ]);
      setNodes(factsOf(graph));
      setNotesReply(notesNow);
      setDreamLast(telemetry.last ?? []);
      const status = (rsi as { best_score?: number } | null);
      if (status && typeof status.best_score === 'number') setBestScore(status.best_score);
    } catch (err) {
      // On screen, not only in a console the person does not have open: an
      // unreadable graph and an empty graph look identical otherwise.
      setError(err instanceof Error ? err.message : String(err));
      console.error('[MemoryLayersPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * Forget, with Undo. The row leaves at once; the agent is told only when the
   * undo window ends, so Undo is a real undo and never has to re-add a fact.
   * Only the fact goes: the conversation it came from stays in the history.
   */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const forget = useCallback((n: MemoryGraphNodeView) => {
    const edge = n.edge;
    if (!edge) return;
    setHidden((h) => new Set(h).add(n.id));
    const unhide = () => setHidden((h) => { const next = new Set(h); next.delete(n.id); return next; });
    const timer = setTimeout(() => {
      tauri.raw.memoryForget(edge.from, edge.to, edge.relation)
        .then(() => setTimeout(() => { void refresh(); }, 400))
        .catch((err: unknown) => {
          unhide();
          useNotifications.getState().push('error', 'Could not forget that', err instanceof Error ? err.message : String(err));
        });
    }, 5_000);
    useNotifications.getState().push('info', 'Forgotten', n.label, {
      label: 'Undo',
      run: () => { clearTimeout(timer); unhide(); },
    });
  }, [refresh]);

  /** Delete one note; the reply is the fresh list, so the row cannot linger. */
  const deleteNote = useCallback((id: number) => {
    tauri.memory.notes('delete', id)
      .then((r) => {
        setNotesReply(r);
        if (!r.ok) useNotifications.getState().push('error', 'Could not delete that note', r.error ?? '');
      })
      .catch((err: unknown) => {
        useNotifications.getState().push('error', 'Could not delete that note', err instanceof Error ? err.message : String(err));
      });
  }, []);

  // Newest first, minus what was just forgotten (the Undo window).
  const visible = useMemo(
    () => nodes.filter((n) => !hidden.has(n.id)).sort((a, b) => b.touched_at - a.touched_at),
    [nodes, hidden],
  );
  const [filter, setFilter] = useState<MemoryKind | 'all'>('all');
  // The category rides on the notes reply; an older engine sends none, and
  // every row is then a Fact, which is what it most likely is.
  const categories = notesReply?.categories;
  const kindOfRow = (n: MemoryGraphNodeView) => kindOf(n.edge ? categories?.[n.edge.from] : undefined);
  const shown = filter === 'all' ? visible : visible.filter((n) => kindOfRow(n) === filter);

  const rsiPhase: RsiPhase = rsiSnap.phase;
  const panelGlow =
    rsiPhase === 'dreaming' ? 'shadow-[0_0_24px_-4px_rgba(232,115,28,0.6)]'
    : rsiPhase === 'ratcheted' ? 'shadow-[0_0_24px_-4px_rgba(245,158,11,0.5)]'
    : '';

  return (
    <div className="flex h-full flex-col overflow-hidden text-text-primary">
      {/* Drag region — without it the frameless window can't be moved,
          and the scrollbar extends into the titlebar area. */}
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="flex flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
        {/* ── HEADER ──────────────────────────────────────────────── */}
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold leading-tight text-text-primary">Memory</h1>
            <p className="mt-2 text-base text-text-muted">
              What Cinderpaw remembers about you. Forget anything, any time.
            </p>
          </div>
          <RsiHud snapshot={rsiSnap} />
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh memory"
            className="rounded-lg border border-border-subtle bg-bg-surface p-2 text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </header>

        {/* ── FACTS ──────────────────────────────────────────────── */}
        {error ? (
          <section className="rounded-2xl border border-error/40 bg-error/5 px-5 py-6 text-center">
            <h2 className="text-base font-semibold text-error">
              Could not read the memory graph.
            </h2>
            <p className="mt-1 text-xs text-text-secondary">{error}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="mt-3 rounded-lg border border-border-default px-3 py-1 text-xs
                         text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              Try again
            </button>
          </section>
        ) : loading && visible.length === 0 ? (
          // "Not read yet" is not "empty", and saying the wrong one of those is
          // worse than saying nothing.
          <section className="flex flex-col gap-px overflow-hidden rounded-2xl border border-border-default" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-bg-surface px-4 py-4">
                <div className="h-3 w-2/3 rounded bg-bg-hover animate-pulse" />
              </div>
            ))}
          </section>
        ) : visible.length === 0 ? (
          <section className="rounded-2xl border border-border-default bg-bg-surface px-5 py-6 text-center">
            <p className="text-sm text-text-muted">
              Nothing yet. Tell me about yourself, or just chat and I will learn.
            </p>
          </section>
        ) : (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
              {(['all', 'preference', 'fact', 'project'] as const).map((k) => {
                const on = filter === k;
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter(k)}
                    className={cn(
                      'h-8 rounded-full px-3.5 text-sm transition-colors',
                      on ? 'bg-text-primary font-medium text-bg-primary' : 'border border-border-default text-text-primary hover:bg-text-primary/5',
                    )}
                  >
                    {k === 'all' ? 'All' : KIND[k].chip}
                  </button>
                );
              })}
            </div>
            {shown.length === 0 ? (
              <p className="px-1 text-sm text-text-muted">No {filter === 'all' ? 'memories' : KIND[filter].chip.toLowerCase()} yet.</p>
            ) : (
              <FactList rows={shown} kindOfRow={kindOfRow} now={now} onForget={forget} />
            )}
          </section>
        )}

        {/* ── WHAT IT CARRIES INTO A NEW CONVERSATION ─────────────── */}
        <NotesPanel reply={notesReply} now={now} onDelete={deleteNote} />

        {/* ── CINDERPAW'S DREAMS ────────────────────────────────────── */}
        <section className={`rounded-lg border border-border-default bg-bg-surface/60 p-4 transition-shadow ${panelGlow}`}>
          <header className="mb-3 flex items-center gap-2">
            <Sparkles size={14} className="text-brand" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">
              Cinderpaw's Dreams
            </h2>
            <span className="text-xs text-text-muted">
              {dreamLast.length} {dreamLast.length === 1 ? 'dream' : 'dreams'}
            </span>
          </header>
          {dreamLast.length === 0 ? (
            <p className="text-xs text-text-muted">
              No dreams yet. Leave Cinderpaw alone for about 5 minutes and it starts
              practicing on its own. Each practice shows up here.
            </p>
          ) : (
            <ul className="space-y-2">
              {dreamLast.map((ep, i) => (
                <li key={`${ep.startedAt}-${i}`}>
                  <DreamCard ep={ep} now={now} bestScore={bestScore} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      </div>
    </div>
  );
}
