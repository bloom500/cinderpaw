import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import {
  Globe, Loader2, Check, AlertTriangle, FileText, TerminalSquare, Brain, Wrench, Sparkles, Search,
  ArrowLeft, ArrowRight, RotateCw, MoreHorizontal, X, Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import type { ToolActivity, ToolKind } from '@/hooks/useLiveToolActivity';

/**
 * A screen in the corner of a call, showing what Cinderpaw is actually doing.
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
          the moment the user learns Cinderpaw orchestrates rather than making one
          call — so it is said plainly, and never when it would be a lie. */}
      {running > 1 && (
        <div className="tw-rise flex items-center gap-2 self-start rounded-full border border-border-subtle bg-bg-surface/90 px-3 py-1 text-2xs text-text-secondary backdrop-blur">
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
    // `pointer-events-auto` against the container's `none`: the panel must not
    // swallow clicks meant for the call behind it, but a result title has to be
    // clickable or it is a screenshot of a link.
    <div className="tw-rise pointer-events-auto overflow-hidden rounded-xl border border-border-default bg-bg-surface/95 shadow-2xl backdrop-blur">
      {/* The browser gets a real window's head — traffic lights and a tab —
          because that is the part a viewer recognises before reading anything.
          Every other kind keeps the plain strip: a terminal draws its own tab
          bar, and a file card with fake window chrome would just be noise. */}
      {a.kind === 'browser' ? (
        <header className="flex items-center gap-2 border-b border-border-subtle bg-bg-elevated/40 px-2.5 py-1.5">
          <span className="flex shrink-0 gap-1.5">
            <i className="h-2 w-2 rounded-full bg-[#ff5f57]" />
            <i className="h-2 w-2 rounded-full bg-[#febc2e]" />
            <i className="h-2 w-2 rounded-full bg-[#28c840]" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 rounded-t-md bg-bg-elevated px-2 py-1">
            <EngineMark size={10} />
            <span className="truncate text-micro text-text-secondary">DuckDuckGo</span>
            <X size={9} className="shrink-0 text-text-muted/50" />
          </span>
          <Plus size={10} className="shrink-0 text-text-muted/50" />
          <State a={a} className="ml-auto" />
        </header>
      ) : a.kind === 'terminal' && !a.error ? (
        // No header at all. The terminal draws a complete window — traffic
        // lights, centred title — and a strip above it reading "shell_exec"
        // makes that window a picture inside a frame instead of the thing
        // itself. The elapsed seconds and the state move onto the title bar.
        null
      ) : (
        <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Icon size={13} className={cn('shrink-0', tint)} />
          <span className="shrink-0 text-2xs font-medium text-text-secondary">{a.tool}</span>
          <State a={a} className="ml-auto" />
        </header>
      )}

      <div className={a.kind === 'terminal' && !a.error ? '' : 'px-3 py-2'}>
        {a.error ? (
          // A failure says so. A search that failed and a search that found
          // nothing look identical otherwise, and one of them is a bug.
          <p className="text-2xs text-[var(--warning)]" title={a.error}>
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
          <p className="mt-1.5 truncate text-2xs text-text-muted">{a.note}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The search engine's mark, for attribution.
 *
 * Their actual logo, bundled at `public/duckduckgo.png` rather than fetched:
 * the webview makes no external requests, so a remote favicon renders as a
 * broken square. Two hand-drawn approximations preceded it and both were wrong
 * in ways only visible next to the real thing — the file removes the question.
 *
 * At the sizes it renders — 9px in the tab, 8px beside a result — this reads as
 * the icon it stands for, which is the whole job.
 */
function EngineMark({ size = 10 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full bg-contain bg-no-repeat"
      style={{
        width: size,
        height: size,
        backgroundImage: 'url(/duckduckgo.png)',
        // The file is the horizontal lockup — duck then wordmark, 2400×756 —
        // and only the duck belongs in a 10px slot. Scaling to the container's
        // height and anchoring left shows exactly the leading square, which is
        // the duck, with no second cropped copy of the asset to keep in sync.
        backgroundSize: 'auto 100%',
        backgroundPosition: 'left center',
      }}
    />
  );
}

/**
 * How long it has run and how it ended — the same corner of every widget's head,
 * whether that head is a plain strip, a browser tab bar or a terminal title.
 */
function State({ a, className }: { a: ToolActivity; className?: string }) {
  const running = a.status === 'running';
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      {running && <Elapsed since={a.startedAt} />}
      {running ? (
        <Loader2 size={12} className="animate-spin text-brand" />
      ) : a.status === 'failed' ? (
        <AlertTriangle size={12} className="text-[var(--warning)]" />
      ) : (
        <Check size={12} className="tw-pop text-[var(--success)]" />
      )}
    </span>
  );
}

/**
 * The outer task: what the call handed to Cinderpaw, in its own words.
 *
 * Always present for the whole wait, which is the point — the agent often
 * answers from what it already knows and runs no tool at all, and every one of
 * those turns used to show an empty screen for up to a hundred seconds.
 */
function AgentBody({ a }: { a: ToolActivity }) {
  return (
    <p className="text-2xs leading-relaxed text-text-secondary">
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
          {/* The engine's mark sits left of the field, where the reference puts
              it — it is what identifies the bar before a single word is read. */}
          <EngineMark size={12} />
          <Search size={10} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-2xs text-text-primary" title={a.subject}>
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
                <span className="truncate text-micro text-text-muted">
                  {h.host}
                  {h.crumbs && <span className="text-text-muted/70"> › {h.crumbs}</span>}
                </span>
              </div>
              {/* Link blue, because that is the colour a result title is in
                  every browser anyone has used — and clickable, because a
                  result you cannot open is a screenshot. `open` hands the URL
                  to the OS browser: the webview navigating away would take the
                  call with it. */}
              <button
                type="button"
                onClick={() => void open(h.url)}
                title={h.url}
                className="mt-0.5 block w-full truncate text-left text-xs leading-snug text-[var(--result-link)] hover:underline"
              >
                {h.title}
              </button>
              {h.snippet && (
                <p className="mt-0.5 line-clamp-2 text-micro leading-snug text-text-muted">
                  {h.snippet}
                </p>
              )}
            </li>
          ))}
          {a.hits.length > 3 && (
            <li className="text-micro text-text-muted">+{a.hits.length - 3} more results</li>
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
              <span className="block truncate text-2xs text-text-secondary" title={f.path}>
                {name}
              </span>
              {dir && <span className="block truncate text-micro text-text-muted">{dir}</span>}
            </span>
            {f.lines !== null && (
              <span className="shrink-0 tabular-nums text-micro text-text-muted">{f.lines}L</span>
            )}
          </li>
        );
      })}
      {rows.length > 5 && <li className="pl-5 text-micro text-text-muted">+{rows.length - 5}</li>}
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
  // The real directory the command ran in. The last segment is what a shell
  // prompt shows, and it is what makes this a session rather than a drawing of
  // one: `~ %` on its own is furniture, `my-project %` is a place.
  //
  // No invented fallback. This used to substitute the developer's own
  // checkout path, so a tool call that reported no cwd showed every user a
  // folder from a machine that is not theirs. `~` is the honest answer to
  // "we were not told".
  const folder = a.cwd ? (a.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '~') : '~';

  return (
    <div className="overflow-hidden rounded-lg border border-black/60 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
      {/* Terminal.app's title bar: a soft vertical gradient, the traffic lights
          hard left, and the title centred over them. Centring is the detail that
          identifies it — every other terminal puts its title beside the tab. */}
      <div
        className="relative flex items-center px-2 py-1"
        style={{ background: 'linear-gradient(#3A3A3C, #2C2C2E)' }}
      >
        <span className="z-10 flex shrink-0 gap-[3px]">
          <i className="h-[7px] w-[7px] rounded-full bg-[#FF5F57]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[#FEBC2E]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[#28C840]" />
        </span>
        {/* The shell named here is the one that actually ran the command. The
            window is Terminal.app's; pretending the shell underneath it is zsh
            on a machine running PowerShell would make the one panel whose worth
            is that it does not lie into a costume. */}
        <span className="pointer-events-none absolute inset-x-0 truncate text-center text-micro font-medium text-white/70">
          {folder} · pwsh · 80×24
        </span>
        {/* State on the title bar, where a window puts its own status — the card
            around this one no longer has a header to carry it. */}
        <State a={a} className="z-10 ml-auto" />
      </div>

      <div
        className="bg-[#1E1E1E] px-2.5 py-2 text-micro leading-[1.5]"
        // SF Mono then Menlo: Terminal.app's own faces, in its own order. Named
        // so the widget uses the real thing where it exists instead of whatever
        // generic monospace the browser would pick.
        style={{ fontFamily: '"SF Mono", Menlo, "Cascadia Mono", Consolas, monospace' }}
      >
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          {/* zsh's prompt, which is what a current macOS opens with: the folder,
              then a percent sign. The command itself is plain white. */}
          <span className="shrink-0 text-[#A8C7FA]">{folder}</span>
          <span className="shrink-0 text-white/70">%</span>
          <span className="min-w-0 break-all text-white">{a.subject}</span>
        </div>
        {lines.map((l, i) => (
          <div
            key={i}
            className="tw-row truncate text-white/65"
            style={{ animationDelay: `${Math.min(i, 4) * 35}ms` }}
            title={l}
          >
            {l}
          </div>
        ))}
        {running && (
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 text-[#A8C7FA]">{folder}</span>
            <span className="shrink-0 text-white/70">%</span>
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
        <p className="truncate text-2xs text-text-muted" title={a.subject}>
          “{a.subject}”
        </p>
      )}
      {a.facts.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {a.facts.slice(0, 4).map((f, i) => (
            <li
              key={i}
              className="tw-row rounded-md border border-violet-400/20 bg-violet-400/5 px-2 py-1 text-2xs text-text-secondary"
              style={{ animationDelay: `${Math.min(i, 4) * 45}ms` }}
            >
              <span className="line-clamp-2">{f}</span>
            </li>
          ))}
          {a.facts.length > 4 && (
            <li className="text-micro text-text-muted">+{a.facts.length - 4}</li>
          )}
        </ul>
      )}
    </>
  );
}

/** Everything unclassified: the argument, and nothing invented around it. */
function GenericBody({ a, running, t }: { a: ToolActivity; running: boolean; t: (k: 'call.toolSearching') => string }) {
  return (
    <p className="truncate text-2xs text-text-muted" title={a.subject}>
      {a.subject || (running ? t('call.toolSearching') : '')}
    </p>
  );
}

/**
 * Seconds since a tool started, once it has run long enough to be worth counting.
 *
 * Under the threshold there is nothing to reassure anyone about and a number
 * flickering on and off is noise. Past it, the count is the difference between
 * "this is taking a while" and "this is stuck" — one `ask_cinder` measured
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
  return <span className="tabular-nums text-micro text-text-muted">{Math.floor(ms / 1000)}s</span>;
}
