import { useEffect, useRef, useState } from 'react';
import { events } from '@/lib/tauri/events';

/**
 * What Feral is doing right now, as the call hears about it.
 *
 * A speech-to-speech call answers tool calls in Rust and never tells the
 * webview, which is correct for latency and leaves the user watching a still
 * screen for up to a hundred seconds. This reads the work off the one channel it
 * already travels on: every raw line the sidecar prints reaches the webview on
 * `feral://agent-output`, tool events included, so nothing new has to be sent.
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
}

export interface ToolActivity {
  id: string;
  tool: string;
  /** The search query, path, or URL — whatever this tool is *about*. */
  subject: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  /** Progress line from a tool that reports one, e.g. "fetching page 2". */
  note: string | null;
  hits: ToolHit[];
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
 * Search hits out of a tool result.
 *
 * `data` is the structured array the search tools return; everything else has
 * no hits and simply shows as a finished row. Defensive throughout: this parses
 * another process's output, and a shape change must dim the panel, never throw
 * inside an event handler during a live call.
 */
export function hitsOf(result: unknown): ToolHit[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ToolHit[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const url = typeof r.url === 'string' ? r.url : '';
    // `text` is the DDG shape ("title — snippet"), `title` the SearXNG one.
    const raw = typeof r.text === 'string' ? r.text : typeof r.title === 'string' ? r.title : '';
    const title = raw.split(' — ')[0]?.trim() ?? '';
    if (!url || !title) continue;
    out.push({ title, url, host: hostOf(url) });
    if (out.length >= 8) break;
  }
  return out;
}

export function useLiveToolActivity(enabled: boolean) {
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  /** Rows are keyed by tool name: the sidecar's tool events carry the message
   *  id, not a per-call id, so two calls to the same tool in one turn would
   *  otherwise be indistinguishable. Last one wins, which is what a live
   *  indicator wants anyway. */
  const sweepRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setActivity([]);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;

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
          setActivity((prev) =>
            [
              ...prev.filter((a) => a.tool !== tool),
              {
                id: `${tool}-${Date.now()}`,
                tool,
                subject: subjectOf(line.args),
                status: 'running' as const,
                startedAt: Date.now(),
                endedAt: null,
                note: null,
                hits: [],
                error: null,
              },
            ].slice(-MAX),
          );
        } else if (line.type === 'tool_progress') {
          const note = (line.message || line.stage || '').trim() || null;
          setActivity((prev) =>
            prev.map((a) => (a.tool === tool && a.status === 'running' ? { ...a, note } : a)),
          );
        } else if (line.type === 'tool_done') {
          const res = line.result as { ok?: boolean; content?: string } | null;
          const ok = res?.ok !== false;
          setActivity((prev) =>
            prev.map((a) =>
              a.tool === tool && a.status === 'running'
                ? {
                    ...a,
                    status: ok ? ('done' as const) : ('failed' as const),
                    endedAt: Date.now(),
                    note: null,
                    hits: hitsOf(line.result),
                    // Shown instead of an empty result list, because a search
                    // that failed and a search that found nothing look identical
                    // otherwise — and one of them is a bug.
                    error: ok ? null : (res?.content ?? 'failed').slice(0, 120),
                  }
                : a,
            ),
          );
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    // Finished rows age out on a timer rather than on the next event: the last
    // tool of a turn would otherwise sit on screen until the next call.
    sweepRef.current = window.setInterval(() => {
      const cutoff = Date.now() - LINGER_MS;
      setActivity((prev) => {
        const kept = prev.filter((a) => a.endedAt === null || a.endedAt > cutoff);
        return kept.length === prev.length ? prev : kept;
      });
    }, 1_000);

    return () => {
      cancelled = true;
      unlisten?.();
      if (sweepRef.current !== undefined) clearInterval(sweepRef.current);
    };
  }, [enabled]);

  return activity;
}
