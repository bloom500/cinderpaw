import { useEffect, useState } from 'react';
import {
  Globe, Loader2, Check, AlertTriangle, FileText, TerminalSquare, Brain, Wrench, Sparkles, Search,
  ArrowLeft, ArrowRight, RotateCw, MoreHorizontal, X, Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import type { ToolActivity, ToolKind } from '@/hooks/useLiveToolActivity';

/**
 * A screen in the corner of a call, showing what Feral is actually doing.
 *
 * Four widgets, one per CATEGORY of work — not one per tool. Forty-three tools
 * would be forty-three components nobody maintains; a browser, an explorer, a
 * terminal and a memory card cover what the tools actually produce, and a new
 * tool joins by being classified rather than by getting a design.
 *
 * Each is drawn as the application it stands for, because that is what a viewer
 * reads instantly from across a room — which is the distance a demo is watched
 * from. But none of them is an embedded app, and the browser could not be:
 * search engines send `X-Frame-Options: DENY`, so an iframe renders blank, and
 * it would show *a* search rather than *the* search the agent ran. Every value
 * here comes from the tool's own output. The moment one is invented, the panel
 * stops being telemetry and becomes an animation of telemetry — which is worth
 * nothing precisely when someone asks whether it is real.
 *
 * Motion is deliberately small: one entrance, one running state, one completion.
 * The keyframes live in `globals.css` under "Call telemetry widgets" and all of
 * them are disabled under `prefers-reduced-motion`.
 */
export function CallToolScreen({ activity }: { activity: ToolActivity[] }) {
  const t = useT();
  if (activity.length === 0) return null;

  // Newest first: during a long turn, the running tool is what the eye wants.
  const rows = [...activity].reverse();
  const running = rows.filter((a) => a.status === 'running').length;

  return (
    <div
      className="pointer-events-none absolute bottom-6 left-6 z-10 flex w-[23rem] max-w-[calc(100%-3rem)] flex-col gap-2"
      // Polite: it narrates background work and must not interrupt a screen
      // reader mid-sentence during a call.
      aria-live="polite"
    >
      {/* The group header, and only when there is a group. Two tools at once is
          the moment the user learns Feral orchestrates rather than making one
          call — so it is said plainly, and never when it would be a lie. */}
      {running > 1 && (
        <div className="tw-rise flex items-center gap-2 self-start rounded-full border border-border-subtle bg-bg-surface/90 px-3 py-1 text-[11px] text-text-secondary backdrop-blur">
          <Loader2 size={11} className="animate-spin text-brand" />
          {running} {t('call.toolsRunning')}
        </div>
      )}

      {rows.map((a) => (
        <Widget key={a.id} activity={a} />
      ))}
    </div>
  );
}

/** Chrome per kind: the icon and the label above the body. */
const CHROME: Record<ToolKind, { icon: typeof Globe; tint: string }> = {
  agent: { icon: Sparkles, tint: 'text-brand' },
  browser: { icon: Globe, tint: 'text-sky-400' },
  files: { icon: FileText, tint: 'text-amber-400' },
  terminal: { icon: TerminalSquare, tint: 'text-emerald-400' },
  memory: { icon: Brain, tint: 'text-violet-400' },
  generic: { icon: Wrench, tint: 'text-text-muted' },
};

/**
 * The shared shell. Rounded, bordered, floating — one card shape for every kind,
 * so a call with four widgets open reads as one system rather than four apps.
 */
function Widget({ activity: a }: { activity: ToolActivity }) {
  const t = useT();
  const { icon: Icon, tint } = CHROME[a.kind];
  const running = a.status === 'running';

  return (
    <div className="tw-rise overflow-hidden rounded-xl border border-border-default bg-bg-surface/95 shadow-2xl backdrop-blur">
      {/* The browser gets a real window's head — traffic lights and a tab —
          because that is the part a viewer recognises before reading anything.
          Every other kind keeps the plain strip: a terminal draws its own tab
          bar, and a file card with fake window chrome would just be noise. */}
      {a.kind === 'browser' ? (
        <header className="flex items-center gap-2 border-b border-border-subtle bg-black/20 px-2.5 py-1.5">
          <span className="flex shrink-0 gap-1.5">
            <i className="h-2 w-2 rounded-full bg-[#ff5f57]" />
            <i className="h-2 w-2 rounded-full bg-[#febc2e]" />
            <i className="h-2 w-2 rounded-full bg-[#28c840]" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 rounded-t-md bg-bg-elevated px-2 py-1">
            <Globe size={9} className="shrink-0 text-sky-400" />
            <span className="truncate text-[10px] text-text-secondary">DuckDuckGo</span>
            <X size={9} className="shrink-0 text-text-muted/50" />
          </span>
          <Plus size={10} className="shrink-0 text-text-muted/50" />
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {running && <Elapsed since={a.startedAt} />}
            <Status running={running} status={a.status} />
          </span>
        </header>
      ) : (
        <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Icon size={13} className={cn('shrink-0', tint)} />
          <span className="shrink-0 text-[11px] font-medium text-text-secondary">{a.tool}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {running && <Elapsed since={a.startedAt} />}
            <Status running={running} status={a.status} />
          </span>
        </header>
      )}

      <div className="px-3 py-2">
        {a.error ? (
          // A failure says so. A search that failed and a search that found
          // nothing look identical otherwise, and one of them is a bug.
          <p className="text-[11px] text-amber-400" title={a.error}>
            {a.error}
          </p>
        ) : a.kind === 'agent' ? (
          <AgentBody a={a} />
        ) : a.kind === 'browser' ? (
          <BrowserBody a={a} running={running} t={t} />
        ) : a.kind === 'files' ? (
          <FilesBody a={a} />
        ) : a.kind === 'terminal' ? (
          <TerminalBody a={a} running={running} />
        ) : a.kind === 'memory' ? (
          <MemoryBody a={a} />
        ) : (
          <GenericBody a={a} running={running} t={t} />
        )}

        {/* A progress line from a tool that reports one — real, when present. */}
        {running && a.note && (
          <p className="mt-1.5 truncate text-[11px] text-text-muted">{a.note}</p>
        )}
      </div>
    </div>
  );
}

/** Running, done, or failed — the same three glyphs everywhere. */
function Status({ running, status }: { running: boolean; status: ToolActivity['status'] }) {
  if (running) return <Loader2 size={12} className="animate-spin text-brand" />;
  if (status === 'failed') return <AlertTriangle size={12} className="text-amber-400" />;
  return <Check size={12} className="tw-pop text-emerald-400" />;
}

/**
 * The outer task: what the call handed to Feral, in its own words.
 *
 * Always present for the whole wait, which is the point — the agent often
 * answers from what it already knows and runs no tool at all, and every one of
 * those turns used to show an empty screen for up to a hundred seconds.
 */
function AgentBody({ a }: { a: ToolActivity }) {
  return (
    <p className="text-[11px] leading-relaxed text-text-secondary">
      <span className="line-clamp-3">{a.subject}</span>
    </p>
  );
}

/**
 * A search results page, in the shape every one of them has: a pill with the
 * query, then per result a breadcrumb, a blue title, and an abstract.
 *
 * That layout is doing the work. It is what makes a viewer read "this is a real
 * search" in the quarter-second they give a corner of the screen — not a logo,
 * which is why there is no logo here. The results come from DuckDuckGo and the
 * engine is named as such: dressing them as Google would be a small lie about
 * provenance in the one panel whose whole value is that it does not lie.
 */
function BrowserBody({ a, running, t }: { a: ToolActivity; running: boolean; t: (k: 'call.toolSearching') => string }) {
  return (
    <>
      {/* Navigation row: dead arrows, then the address bar. The arrows are
          greyed because they are not controls — nobody can click this. They are
          there because a browser without them does not read as a browser. */}
      <div className="flex items-center gap-2 pb-2">
        <span className="flex shrink-0 items-center gap-1.5 text-text-muted/40">
          <ArrowLeft size={11} />
          <ArrowRight size={11} />
          <RotateCw size={10} />
        </span>
        <div
          className={cn(
            'relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-full bg-bg-elevated px-2 py-1',
            // The blue focus ring, breathing. This is the single detail that
            // says a search is being typed right now rather than displayed.
            running ? 'tw-focus' : 'ring-1 ring-inset ring-border-subtle',
          )}
        >
          <Search size={10} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary" title={a.subject}>
            {/* Typed in, not printed. The string is exactly what the agent sent;
                revealing it progressively is what makes a still panel read as
                happening rather than happened. */}
            <span className="tw-type">{a.subject || t('call.toolSearching')}</span>
          </span>
        </div>
        <MoreHorizontal size={12} className="shrink-0 text-text-muted/50" />
      </div>

      {a.hits.length > 0 && (
        <ul className="mt-2.5 space-y-2.5">
          {a.hits.slice(0, 3).map((h, i) => (
            <li
              key={h.url}
              className="tw-row"
              // Capped stagger: past a few rows the delay lands after the eye
              // has already moved on, and reads as lag rather than rhythm.
              style={{ animationDelay: `${Math.min(i, 4) * 45}ms` }}
            >
              {/* Breadcrumb above the title, the way a results page has it: a
                  favicon disc, the host, then the path as places. */}
              <div className="flex items-center gap-1.5">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-bg-elevated">
                  <Globe size={8} className="text-text-muted" />
                </span>
                <span className="truncate text-[10px] text-text-muted">
                  {h.host}
                  {h.crumbs && <span className="text-text-muted/70"> › {h.crumbs}</span>}
                </span>
              </div>
              {/* Link blue, because that is the colour a result title is in
                  every browser anyone has used. */}
              <p
                className="mt-0.5 truncate text-[12px] leading-snug text-[#8ab4f8]"
                title={h.title}
              >
                {h.title}
              </p>
              {h.snippet && (
                <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-text-muted">
                  {h.snippet}
                </p>
              )}
            </li>
          ))}
          {a.hits.length > 3 && (
            <li className="text-[10px] text-text-muted">+{a.hits.length - 3} more results</li>
          )}
        </ul>
      )}
    </>
  );
}

/** A mini explorer: the file, and the numbers its tool reported about it. */
function FilesBody({ a }: { a: ToolActivity }) {
  const rows = a.files.length > 0 ? a.files : a.subject ? [{ path: a.subject, lines: null, bytes: null }] : [];
  if (rows.length === 0) return null;

  return (
    <ul className="space-y-1">
      {rows.slice(0, 5).map((f, i) => {
        const name = f.path.split(/[\\/]/).pop() || f.path;
        const dir = f.path.slice(0, f.path.length - name.length).replace(/[\\/]$/, '');
        return (
          <li
            key={f.path}
            className="tw-row flex items-center gap-2"
            style={{ animationDelay: `${Math.min(i, 4) * 45}ms` }}
          >
            <FileText size={11} className="shrink-0 text-amber-400/70" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-text-secondary" title={f.path}>
                {name}
              </span>
              {dir && <span className="block truncate text-[10px] text-text-muted">{dir}</span>}
            </span>
            {f.lines !== null && (
              <span className="shrink-0 tabular-nums text-[10px] text-text-muted">{f.lines}L</span>
            )}
          </li>
        );
      })}
      {rows.length > 5 && <li className="pl-5 text-[10px] text-text-muted">+{rows.length - 5}</li>}
    </ul>
  );
}

/**
 * A terminal, drawn as one: tab strip, near-black body, a coloured prompt, and
 * a block cursor that blinks while the command is still running.
 *
 * The prompt is what sells it. A bare `$` reads as a code sample; a path
 * segment in front of the command reads as a session someone is sitting at —
 * and the path is the real workspace, not decoration.
 */
function TerminalBody({ a, running }: { a: ToolActivity; running: boolean }) {
  const lines = a.output ? a.output.split('\n').filter(Boolean).slice(-6) : [];
  return (
    <div className="overflow-hidden rounded-md border border-black/40 bg-[#0c0c0c]">
      {/* Tab strip. One tab, named for the shell — the small piece of furniture
          that separates "a terminal" from "a dark box with text in it". */}
      <div className="flex items-center gap-1.5 border-b border-white/5 bg-black/40 px-2 py-1">
        <TerminalSquare size={9} className="text-emerald-400/80" />
        <span className="font-mono text-[9px] text-white/40">powershell</span>
        {running && (
          <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400/80" />
        )}
      </div>

      <div className="px-2 py-1.5 font-mono text-[10.5px] leading-relaxed">
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-emerald-400">❯</span>
          <span className="min-w-0 flex-1 break-all text-white/90">{a.subject}</span>
        </div>
        {lines.map((l, i) => (
          <div
            key={i}
            className="tw-row truncate text-white/45"
            style={{ animationDelay: `${Math.min(i, 4) * 35}ms` }}
            title={l}
          >
            {l}
          </div>
        ))}
        {running && (
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 text-emerald-400">❯</span>
            <span className="tw-caret" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Memory: what was asked, and the facts that came back, as cards. */
function MemoryBody({ a }: { a: ToolActivity }) {
  return (
    <>
      {a.subject && (
        <p className="truncate text-[11px] text-text-muted" title={a.subject}>
          “{a.subject}”
        </p>
      )}
      {a.facts.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {a.facts.slice(0, 4).map((f, i) => (
            <li
              key={i}
              className="tw-row rounded-md border border-violet-400/20 bg-violet-400/5 px-2 py-1 text-[11px] text-text-secondary"
              style={{ animationDelay: `${Math.min(i, 4) * 45}ms` }}
            >
              <span className="line-clamp-2">{f}</span>
            </li>
          ))}
          {a.facts.length > 4 && (
            <li className="text-[10px] text-text-muted">+{a.facts.length - 4}</li>
          )}
        </ul>
      )}
    </>
  );
}

/** Everything unclassified: the argument, and nothing invented around it. */
function GenericBody({ a, running, t }: { a: ToolActivity; running: boolean; t: (k: 'call.toolSearching') => string }) {
  return (
    <p className="truncate text-[11px] text-text-muted" title={a.subject}>
      {a.subject || (running ? t('call.toolSearching') : '')}
    </p>
  );
}

/**
 * Seconds since a tool started, once it has run long enough to be worth counting.
 *
 * Under the threshold there is nothing to reassure anyone about and a number
 * flickering on and off is noise. Past it, the count is the difference between
 * "this is taking a while" and "this is stuck" — one `ask_feral` measured
 * anywhere from seventeen to a hundred seconds, and with no number every one of
 * them feels identical.
 */
const TIMER_AFTER_MS = 3_000;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // One second is the resolution a person reads; faster is a fidget.
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);
  const ms = now - since;
  if (ms < TIMER_AFTER_MS) return null;
  return <span className="tabular-nums text-[10px] text-text-muted">{Math.floor(ms / 1000)}s</span>;
}
