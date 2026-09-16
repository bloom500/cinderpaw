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
export type ToolKind = 'agent' | 'browser' | 'files' | 'terminal' | 'memory' | 'desktop' | 'artifact' | 'generic';

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
  // Both names: the tool was renamed on a branch that has not merged yet, and
  // a widget that only knows one of them goes blank on the other.
  ['desktop', ['computer_use', 'control_app']],
  // Every artifact_* tool. Without this they were 'generic', which draws a
  // wrench and one empty line: the agent writing a report looked identical to
  // the agent doing nothing in particular.
  ['artifact', ['artifact']],
];

export function kindOf(tool: string): ToolKind {
  if (tool === AGENT_TOOL) return 'agent';
  for (const [kind, names] of KINDS) {
    if (names.some((n) => tool === n || tool.startsWith(`${n}_`))) return kind;
  }
  return 'generic';
}

/**
 * What an artifact tool made or changed.
 *
 * Every field comes from the tool's structured `data`. The tool also returns an
 * English sentence, and reading the title out of THAT would have worked today
 * and broken the first time someone rephrased it or translated the UI.
 */
export interface ArtifactFact {
  id: string;
  title: string;
  kind: string;
  version: number;
  /** Only an export has one: where the real file landed. */
  path: string | null;
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
   *  terminal and `PS D:\CinderpawLocalAI>` is a session. */
  cwd: string;
  /** Facts a memory lookup came back with. */
  facts: string[];
  /** What a desktop-control step did and saw — the app window widget's body. */
  desktop: DesktopFact | null;
  /** What an artifact tool made or changed. Read from the tool's `data`, never
   *  parsed out of its English sentence: the sentence is for the model. */
  artifact: ArtifactFact | null;
  /** Present when the tool failed, so the panel can say so rather than empty. */
  error: string | null;
}

/**
 * One step of the agent driving a native application.
 *
 * Every field is what the tool sent or returned, never a guess: the window
 * widget draws the elements at the rectangles the accessibility tree reported,
 * so what the user sees is the app's real layout, not a picture of "an app".
 * The text typed into a field is deliberately NOT here — it may be a password,
 * and the tool redacts it from its own audit for the same reason.
 */
export interface DesktopFact {
  action: string;
  /** The application, as best the tool told us: `launch`'s `app`, or the
   *  `app_name` a `list_windows` result gave for this pid. */
  app: string;
  windowTitle: string;
  /** `list_windows` — every open window, for the taskbar row. */
  windows: Array<{ pid: number; title: string; app: string }>;
  /** `get_tree` / `find_elements` — elements with the rectangles they occupy,
   *  in screen coordinates, so they can be drawn to scale. */
  elements: DesktopElement[];
  /** `click`/`type`/`perform_action` — the element acted on, when a tree seen
   *  earlier knows it. */
  target: DesktopElement | null;
  /** `action_name` for `perform_action`, e.g. "press", "toggle". */
  actionName: string;
}

export interface DesktopElement {
  id: string;
  role: string;
  name: string;
  /** The element's value as the tree reported it: an address bar's URL, a
   *  field's text. Empty for most elements. Never a password: the host
   *  refuses to read secure fields back. */
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * pid → window, remembered from `list_windows` results.
 *
 * A `click` carries only a pid and an element id, so the widget cannot name the
 * app being clicked unless something remembered the answer to the question the
 * agent asked first. Module-level on purpose: the memory has to outlive one
 * activity and one turn.
 */
const windowsByPid = new Map<number, { app: string; title: string }>();
/** element id → element, from the last tree or search that returned it. */
const elementsById = new Map<string, DesktopElement>();
/** The last tree or search, whole: a click's widget redraws it with the
 *  target lit, since the click itself returns no layout. */
let lastElements: DesktopElement[] = [];

function elementOf(row: unknown): DesktopElement | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const rect = (r.bounding_rect && typeof r.bounding_rect === 'object' ? r.bounding_rect : {}) as Record<string, unknown>;
  return {
    id: r.id,
    role: typeof r.role === 'string' ? r.role : '',
    name: typeof r.name === 'string' ? r.name : '',
    value: typeof r.value === 'string' ? r.value : '',
    x: typeof rect.x === 'number' ? rect.x : 0,
    y: typeof rect.y === 'number' ? rect.y : 0,
    w: typeof rect.width === 'number' ? rect.width : 0,
    h: typeof rect.height === 'number' ? rect.height : 0,
  };
}

/** Flatten an accessibility tree, breadth first, to the elements worth drawing. */
function flattenTree(node: unknown, out: DesktopElement[], limit = 40): void {
  const queue: unknown[] = [node];
  while (queue.length > 0 && out.length < limit) {
    const n = queue.shift();
    const el = elementOf(n);
    if (!el) continue;
    if (el.w > 0 && el.h > 0) out.push(el);
    const kids = (n as { children?: unknown }).children;
    if (Array.isArray(kids)) queue.push(...kids);
  }
}

/** The desktop step's arguments, before its result exists. */
export function desktopOf(args: Record<string, unknown> | undefined): DesktopFact | null {
  if (!args) return null;
  const action = typeof args.action === 'string' ? args.action : '';
  if (!action) return null;
  const known = typeof args.pid === 'number' ? windowsByPid.get(args.pid) : undefined;
  const elementId = typeof args.element_id === 'string' ? args.element_id : '';
  const target = elementsById.get(elementId) ?? null;
  return {
    action,
    app: typeof args.app === 'string' ? args.app : (known?.app ?? ''),
    windowTitle: typeof args.window_title === 'string' ? args.window_title : (known?.title ?? ''),
    windows: [],
    elements: target ? lastElements : [],
    target,
    actionName: typeof args.action_name === 'string' ? args.action_name : '',
  };
}

/** Fold a desktop step's result into what its arguments already said. */
export function desktopDone(fact: DesktopFact | null, result: unknown): DesktopFact | null {
  if (!fact) return null;
  const data = (result as { data?: unknown } | null)?.data;
  const next: DesktopFact = { ...fact, windows: [], elements: [] };
  if (fact.action === 'list_windows' && Array.isArray(data)) {
    for (const row of data) {
      const r = (row ?? {}) as Record<string, unknown>;
      if (typeof r.pid !== 'number') continue;
      const w = { pid: r.pid, title: String(r.title ?? ''), app: String(r.app_name ?? '') };
      windowsByPid.set(w.pid, { app: w.app, title: w.title });
      if (next.windows.length < 8) next.windows.push(w);
    }
  } else if (fact.action === 'get_tree') {
    flattenTree(data, next.elements);
    // The tree's root is the window itself; its name is the best title we have.
    const root = elementOf(data);
    if (root?.name && !next.windowTitle) next.windowTitle = root.name;
  } else if (fact.action === 'find_elements' && Array.isArray(data)) {
    for (const row of data) {
      const el = elementOf(row);
      if (el) next.elements.push(el);
      if (next.elements.length >= 40) break;
    }
  }
  if (next.elements.length > 0) {
    for (const el of next.elements) elementsById.set(el.id, el);
    lastElements = next.elements;
  }
  return next;
}

/** A fresh, running activity for a tool that just started. */
export function startActivity(tool: string, args: Record<string, unknown> | undefined): ToolActivity {
  return {
    id: `${tool}-${Date.now()}`,
    tool,
    kind: kindOf(tool),
    subject: subjectOf(args),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    note: null,
    hits: [],
    files: [],
    output: '',
    cwd: typeof args?.cwd === 'string' ? args.cwd : '',
    facts: [],
    desktop: desktopOf(args),
    artifact: null,
    error: null,
  };
}

/** The same activity, finished: everything the result can tell a widget. */
export function finishActivity(a: ToolActivity, result: unknown): ToolActivity {
  const res = result as { ok?: boolean; content?: string } | null;
  const ok = res?.ok !== false;
  const content = typeof res?.content === 'string' ? res.content : '';
  return {
    ...a,
    status: ok ? 'done' : 'failed',
    endedAt: Date.now(),
    note: null,
    hits: hitsOf(result),
    files: filesOf(result),
    facts: factsOf(result),
    desktop: desktopDone(a.desktop, result),
    artifact: a.kind === 'artifact' ? artifactOf(result) : null,
    // The terminal widget's body. Trimmed hard: a build log is megabytes and
    // the panel is twenty lines tall.
    output: ok ? content.slice(0, 1200) : '',
    // Shown instead of an empty result list, because a search that failed and
    // a search that found nothing look identical otherwise — and one of them
    // is a bug.
    error: ok ? null : (content || 'failed').slice(0, 120),
  };
}

/**
 * Widgets read back from a saved conversation.
 *
 * The file was written by an older or newer build than the one reading it, so
 * every row is checked rather than trusted: a row missing what a widget needs
 * is dropped, and a row that still ran when the app was closed is marked so —
 * nothing on disk can put a spinner on screen that never stops.
 */
export function toolsFromPersisted(raw: unknown): ToolActivity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolActivity[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ToolActivity>;
    if (typeof r.tool !== 'string' || typeof r.subject !== 'string') continue;
    const running = r.status === 'running';
    out.push({
      id: typeof r.id === 'string' ? r.id : `${r.tool}-${out.length}`,
      tool: r.tool,
      kind: kindOf(r.tool),
      subject: r.subject,
      status: running ? 'failed' : r.status === 'failed' ? 'failed' : 'done',
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
      endedAt: typeof r.endedAt === 'number' ? r.endedAt : null,
      note: null,
      hits: Array.isArray(r.hits) ? r.hits : [],
      files: Array.isArray(r.files) ? r.files : [],
      output: typeof r.output === 'string' ? r.output : '',
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      facts: Array.isArray(r.facts) ? r.facts : [],
      desktop: r.desktop && typeof r.desktop === 'object' ? r.desktop : null,
      // Same rule as `desktop`: a row written by another build may not have
      // it, and a widget must never render a card it cannot fill.
      artifact: r.artifact && typeof r.artifact === 'object' ? r.artifact : null,
      error: running ? 'interrupted' : typeof r.error === 'string' ? r.error : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Longest an activity stays on screen after finishing. */
const LINGER_MS = 6_000;
/**
 * Longest a row may claim to be running.
 *
 * Past its deadline the runtime answers a slow tool with "still working on
 * that one", and this panel deliberately keeps the row running on that,
 * because the work really is still going. What nothing ever sends is the
 * second result: the request that would have carried it was already answered,
 * so the row spun for as long as the call lasted. Measured at 465 seconds on
 * one, which is not "taking longer than usual", it is a spinner nobody can
 * end — the caller even asked the agent to stop it, and there is nothing on
 * either side that could.
 *
 * Four minutes is past any honest search and well short of that. A row that
 * reaches it says so and stops pretending.
 */
const RUNNING_CEILING_MS = 240_000;
/** Most rows kept — a call can run many tools and the panel is small. */
const MAX = 6;

/** The bit of the arguments worth showing. Query first: it is what a viewer
 *  reads to believe the search is real. */
export function subjectOf(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  // `title` is the artifact tools' subject. It goes LAST of the name-ish keys
  // deliberately: artifact_export takes both a title-bearing id and a `path`,
  // and the path is what the person wants to see once a file exists.
  for (const key of ['query', 'url', 'path', 'request', 'command', 'pattern', 'app', 'window_title', 'title']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * The artifact facts out of a tool result, or null when there are none.
 *
 * Null rather than a half-filled object: a widget that cannot say WHICH
 * artifact should fall back to the generic body, not draw a card headed
 * "undefined".
 */
export function artifactOf(result: unknown): ArtifactFact | null {
  const data = (result as { data?: Record<string, unknown> } | null)?.data;
  if (!data) return null;
  const id = typeof data.id === 'string' ? data.id : '';
  const title = typeof data.title === 'string' ? data.title : '';
  if (!id || !title) return null;
  return {
    id,
    title,
    kind: typeof data.kind === 'string' ? data.kind : 'file',
    version: typeof data.version === 'number' ? data.version : 1,
    path: typeof data.path === 'string' ? data.path : null,
  };
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
    setActivity([]);
    if (!enabled) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /** Add or replace a row, newest of that tool wins. */
    const begin = (tool: string, args?: Record<string, unknown>, subject?: string) =>
      setActivity((prev) => {
        const a = startActivity(tool, args);
        if (subject !== undefined) a.subject = subject;
        return [...prev.filter((r) => r.tool !== tool), a].slice(-MAX);
      });

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
      if (cancelled) return;
      // The call is over. Whatever was running is not running any more, and a
      // row still spinning after the room closed is the panel describing a
      // process that no longer exists.
      if (kind === 'closed') {
        setActivity((prev) =>
          prev.map((a) =>
            a.status === 'running'
              ? { ...a, status: 'done' as const, endedAt: Date.now(), note: 'call ended' }
              : a,
          ),
        );
        return;
      }
      if (kind === 'toolCall') begin(AGENT_TOOL, undefined, text);
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

    void events.cinderpawAgentOutputEvent
      .listen((event) => {
        if (cancelled) return;
        let line: { type?: string; sessionId?: string; tool?: string; args?: Record<string, unknown>; result?: unknown; message?: string; stage?: string };
        try {
          line = JSON.parse(event.payload.data);
        } catch {
          return; // not JSON, or a partial line — never fatal here
        }
        if (!line || typeof line !== 'object') return;
        const tool = typeof line.tool === 'string' ? line.tool : '';
        if (!tool) return;

        if (line.type === 'tool_start') {
          begin(tool, line.args);
        } else if (line.type === 'tool_progress') {
          const note = (typeof line.message === 'string' ? line.message : typeof line.stage === 'string' ? line.stage : '').trim() || null;
          setActivity((prev) =>
            prev.map((a) => (a.tool === tool && a.status === 'running' ? { ...a, note } : a)),
          );
        } else if (line.type === 'tool_done') {
          setActivity((prev) =>
            prev.map((a) => {
              if (!(a.tool === tool && a.status === 'running')) return a;
              const done = finishActivity(a, line.result);
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
      const now = Date.now();
      const cutoff = now - LINGER_MS;
      setActivity((prev) => {
        // A row that has run past the ceiling is closed where it stands. It is
        // not marked failed: the work may well have finished somewhere we
        // cannot see, and calling that a failure would be its own lie.
        const capped = prev.map((a) =>
          a.status === 'running' && now - a.startedAt > RUNNING_CEILING_MS
            ? {
                ...a,
                status: 'done' as const,
                endedAt: now,
                note: 'no answer came back',
              }
            : a,
        );
        const kept = capped.filter((a) => a.endedAt === null || a.endedAt > cutoff);
        const unchanged =
          kept.length === prev.length && kept.every((a, i) => a === prev[i]);
        return unchanged ? prev : kept;
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
