import { useEffect, useState } from 'react';
import { events } from '@/lib/tauri/events';
import { recordArtifact } from '@/lib/callArtifacts';

/**
 * What Cinderpaw is doing right now, as the call hears about it.
 *
 * A speech-to-speech call answers tool calls in Rust and never tells the
 * webview, which is correct for latency and leaves the user watching a still
 * screen for up to a hundred seconds. This reads the work off the one channel it
 * already travels on: every raw line the sidecar prints reaches the webview on
 * `cinderpaw://agent-output`, tool events included, so nothing new has to be sent.
 *
 * Deliberately its own listener rather than the chat store's tool strip. That
 * strip is built inside the send flow, and a Live call never calls send — the
 * message goes to the sidecar from Rust — so no strip is ever assembled for it.
 */

/** A search hit as the sidecar's `web_search` returns it. */
export interface ToolHit {
  title: string;
  url: string;
  host: string;
  /** The abstract under the title, which is what makes a result page look like
   *  a result page rather than a list of links. */
  snippet: string;
  /** Path after the host, shown as the breadcrumb a search engine puts above
   *  the title: `example.com › docs › guide`. */
  crumbs: string;
}

/**
 * Which widget renders this activity.
 *
 * A kind per *category* of work, not per tool. Forty-three tools would be
 * forty-three widgets nobody maintains; four categories cover what the tools
 * actually produce, and a new tool joins by being classified rather than by
 * getting a component. `generic` is the honest fallback — a row with a name and
 * a state, which is still better than nothing and never pretends to more.
 */
export type ToolKind = 'agent' | 'browser' | 'files' | 'terminal' | 'memory' | 'generic';

/**
 * The name the Live call's own request travels under.
 *
 * `ask_cinder` is answered in Rust and never reaches the sidecar's event stream,
 * so it arrives here on the call's status channel instead. It matters because it
 * is the OUTER task: the agent may answer from what it already knows and run no
 * tool at all, and before this the panel was blank for that entire wait — the
 * common case was the one with no feedback.
 */
export const AGENT_TOOL = 'ask_cinder';

/** Tool name → widget. Prefix matching, so `web_search_news` lands correctly. */
const KINDS: Array<[ToolKind, string[]]> = [
  ['browser', ['web_search', 'deep_research', 'read_webpage', 'fetch_url', 'http_request']],
  ['files', ['read_file', 'write_file', 'edit_file', 'list_directory', 'file_search', 'grep', 'scan_workspace', 'notebook']],
  ['terminal', ['shell_exec', 'code_execute', 'git', 'code_quality']],
  ['memory', ['recall', 'remember']],
];

export function kindOf(tool: string): ToolKind {
  if (tool === AGENT_TOOL) return 'agent';
  for (const [kind, names] of KINDS) {
    if (names.some((n) => tool === n || tool.startsWith(`${n}_`))) return kind;
  }
  return 'generic';
}

/** A file the agent touched, with the numbers its tool reported. */
export interface FileFact {
  path: string;
  lines: number | null;
  bytes: number | null;
}

export interface ToolActivity {
  id: string;
  tool: string;
  kind: ToolKind;
  /** The search query, path, or command — whatever this tool is *about*. */
  subject: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  /** Progress line from a tool that reports one, e.g. "fetching page 2". */
  note: string | null;
  hits: ToolHit[];
  files: FileFact[];
  /** Whatever the tool printed — the terminal widget's body. */
  output: string;
  /** The directory a command ran in, when the tool reported one. Shown in the
   *  prompt, because `PS >` with nothing in front of it is a drawing of a
   *  terminal and `PS D:\FeralLocalAI>` is a session. */
  cwd: string;
  /** Facts a memory lookup came back with. */
  facts: string[];
  /** Present when the tool failed, so the panel can say so rather than empty. */
  error: string | null;
}

/** Longest an activity stays on screen after finishing. */
const LINGER_MS = 6_000;
/** Most rows kept — a call can run many tools and the panel is small. */
const MAX = 6;

/** The bit of the arguments worth showing. Query first: it is what a viewer
 *  reads to believe the search is real. */
export function subjectOf(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  for (const key of ['query', 'url', 'path', 'request', 'command', 'pattern']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Host only — a full URL wraps and reads as noise at this size. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The path as a breadcrumb: `docs › guide`.
 *
 * Search engines show this instead of the raw URL because a path with slashes
 * and extensions reads as machinery, while the same path with separators reads
 * as a place. Two segments at most — the third is always noise at this width.
 */
export function crumbsOf(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).slice(0, 2);
    return parts.map((p) => decodeURIComponent(p).replace(/\.\w+$/, '')).join(' › ');
  } catch {
    return '';
  }
}

/**
 * Search hits out of a tool result.
 *
 * `data` is the structured array the search tools return; everything else has
 * no hits and simply shows as a finished row. Defensive throughout: this parses
 * another process's output, and a shape change must dim the panel, never throw
 * inside an event handler during a live call.
 */
/**
 * Files a tool reported touching.
 *
 * `read_file` and `write_file` return one object with `{ path, lines, bytes }`;
 * `list_directory` returns an array of entries. Both shapes land here so the
 * explorer widget can draw either without knowing which tool ran.
 */
export function filesOf(result: unknown): FileFact[] {
  const data = (result as { data?: unknown } | null)?.data;
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const out: FileFact[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const path = typeof r.path === 'string' ? r.path : typeof r.name === 'string' ? r.name : '';
    if (!path) continue;
    out.push({
      path,
      lines: typeof r.lines === 'number' ? r.lines : null,
      bytes: typeof r.bytes === 'number' ? r.bytes : typeof r.size === 'number' ? r.size : null,
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** What a memory lookup found, as lines the card can show. */
export function factsOf(result: unknown): string[] {
  const data = (result as { data?: { facts?: unknown; hits?: unknown } } | null)?.data;
  const raw = Array.isArray(data?.facts) ? data.facts : Array.isArray(data?.hits) ? data.hits : [];
  const out: string[] = [];
  for (const row of raw) {
    const text =
      typeof row === 'string'
        ? row
        : row && typeof row === 'object'
          ? String((row as Record<string, unknown>).text ?? (row as Record<string, unknown>).fact ?? '')
          : '';
    const trimmed = text.trim();
    if (trimmed) out.push(trimmed);
    if (out.length >= 6) break;
  }
  return out;
}

export function hitsOf(result: unknown): ToolHit[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ToolHit[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const url = typeof r.url === 'string' ? r.url : '';
    // `text` is the DDG shape ("title — snippet"), `title` the SearXNG one,
    // which carries its abstract separately in `content`.
    const raw = typeof r.text === 'string' ? r.text : typeof r.title === 'string' ? r.title : '';
    const [head, ...rest] = raw.split(' — ');
    const title = head?.trim() ?? '';
    if (!url || !title) continue;
    const snippet =
      rest.join(' — ').trim() || (typeof r.content === 'string' ? r.content.trim() : '');
    out.push({
      title,
      url,
      host: hostOf(url),
      snippet,
      crumbs: crumbsOf(url),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function useLiveToolActivity(enabled: boolean) {
  /** Rows are keyed by tool name: the sidecar's tool events carry the message
   *  id, not a per-call id, so two calls to the same tool in one turn would
   *  otherwise be indistinguishable. Last one wins, which is what a live
   *  indicator wants anyway. */
  const [activity, setActivity] = useState<ToolActivity[]>([]);

  useEffect(() => {
    if (!enabled) {
      setActivity([]);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /** Add or replace a row, newest of that tool wins. */
    const begin = (tool: string, subject: string, cwd = '') =>
      setActivity((prev) =>
        [
          ...prev.filter((a) => a.tool !== tool),
          {
            id: `${tool}-${Date.now()}`,
            tool,
            kind: kindOf(tool),
            subject,
            status: 'running' as const,
            startedAt: Date.now(),
            endedAt: null,
            note: null,
            hits: [],
            files: [],
            output: '',
            cwd,
            facts: [],
            error: null,
          },
        ].slice(-MAX),
      );

    /**
     * The Live call's own request, which never travels on the sidecar's stream.
     *
     * Both engines report it, on their own channels and in the same shape, so
     * this is one handler subscribed twice rather than two. It mattered: the
     * panel was written when there was one engine, LiveKit became the default,
     * and the panel simply went blank for every call — the tool was working and
     * looked broken because nothing was listening where it now speaks.
     */
    const onTool = (kind: string, text: string) => {
      if (kind === 'toolCall') begin(AGENT_TOOL, text);
      else if (kind === 'toolResult') {
        // A slow answer is not a failed one. Past its deadline the runtime
        // returns `ok:false` carrying "Still working on that one" so the model
        // has a sentence to say instead of a silence — but the work continues
        // and the answer usually lands seconds later. Reading that as a
        // failure put a red row on screen for the one case where the honest
        // display is "still going": a web search, which is most of them.
        if (/still working/i.test(text)) {
          setActivity((prev) =>
            prev.map((a) =>
              a.tool === AGENT_TOOL && a.status === 'running'
                ? { ...a, note: 'taking longer than usual' }
                : a,
            ),
          );
          return;
        }
        setActivity((prev) =>
          prev.map((a) =>
            a.tool === AGENT_TOOL && a.status === 'running'
              ? {
                  ...a,
                  status: text ? ('failed' as const) : ('done' as const),
                  endedAt: Date.now(),
                  error: text || null,
                }
              : a,
          ),
        );
      }
    };

    const liveOff: Array<() => void> = [];
    const attach = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (cancelled) fn();
        else liveOff.push(fn);
      });

    attach(events.liveStatusEvent.listen((e) => onTool(e.payload.kind, e.payload.text ?? '')));
    // The LiveKit channel hands the payload over directly, not wrapped.
    attach(events.liveKitEvent.listen((e) => onTool(e.kind, e.text ?? '')));

    void events.feralAgentOutputEvent
      .listen((event) => {
        let line: { type?: string; tool?: string; args?: Record<string, unknown>; result?: unknown; message?: string; stage?: string };
        try {
          line = JSON.parse(event.payload.data);
        } catch {
          return; // not JSON, or a partial line — never fatal here
        }
        const tool = typeof line.tool === 'string' ? line.tool : '';
        if (!tool) return;

        if (line.type === 'tool_start') {
          const cwd = typeof line.args?.cwd === 'string' ? line.args.cwd : '';
          begin(tool, subjectOf(line.args), cwd);
        } else if (line.type === 'tool_progress') {
          const note = (line.message || line.stage || '').trim() || null;
          setActivity((prev) =>
            prev.map((a) => (a.tool === tool && a.status === 'running' ? { ...a, note } : a)),
          );
        } else if (line.type === 'tool_done') {
          const res = line.result as { ok?: boolean; content?: string } | null;
          const ok = res?.ok !== false;
          setActivity((prev) =>
            prev.map((a) => {
              if (!(a.tool === tool && a.status === 'running')) return a;
              const done: ToolActivity = {
                    ...a,
                    status: ok ? ('done' as const) : ('failed' as const),
                    endedAt: Date.now(),
                    note: null,
                    hits: hitsOf(line.result),
                    files: filesOf(line.result),
                    facts: factsOf(line.result),
                    // The terminal widget's body. Trimmed hard: a build log is
                    // megabytes and the panel is twenty lines tall.
                    output: ok ? (res?.content ?? '').slice(0, 1200) : '',
                    // Shown instead of an empty result list, because a search
                    // that failed and a search that found nothing look identical
                    // otherwise — and one of them is a bug.
                    error: ok ? null : (res?.content ?? 'failed').slice(0, 120),
              };
              // Filed here rather than in the sweep that ages rows out: this is
              // the one moment the full result exists, and the row that leaves
              // the screen six seconds later is a copy with nothing added.
              recordArtifact(done);
              return done;
            }),
          );
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    // Finished rows age out on a timer rather than on the next event: the last
    // tool of a turn would otherwise sit on screen until the next call.
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - LINGER_MS;
      setActivity((prev) => {
        const kept = prev.filter((a) => a.endedAt === null || a.endedAt > cutoff);
        return kept.length === prev.length ? prev : kept;
      });
    }, 1_000);

    return () => {
      cancelled = true;
      unlisten?.();
      for (const off of liveOff) off();
      clearInterval(sweep);
    };
  }, [enabled]);

  return activity;
}
