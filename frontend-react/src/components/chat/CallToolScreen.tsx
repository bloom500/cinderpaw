import { useEffect, useState } from 'react';
import { Globe, Loader2, Check, AlertTriangle, Search } from 'lucide-react';
import { useT } from '@/lib/i18n';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';

/**
 * A small screen in the corner of a call, showing what Feral is actually doing.
 *
 * Styled as a browser because that is what a viewer reads instantly — an address
 * bar and a list of results says "it is out on the web" without a caption. But
 * every pixel is the agent's real work: the address bar holds the query it
 * actually sent, the rows are the titles and hosts it actually got back, and a
 * failure says so rather than showing an empty page.
 *
 * It is NOT an embedded browser, and could not be. Google and every other search
 * engine send `X-Frame-Options: DENY`, so an iframe pointed at a results page
 * renders blank — and it would show *a* search rather than *the* search the
 * agent ran. Reconstructing the page from the tool's own output is both the only
 * thing that works and the only thing that is true.
 *
 * The panel exists because a call is otherwise a still screen for up to a
 * hundred seconds, and a user cannot tell work from a hang.
 */
export function CallToolScreen({ activity }: { activity: ToolActivity[] }) {
  const t = useT();
  if (activity.length === 0) return null;

  // Newest first: during a long turn the running tool is what the eye wants.
  const rows = [...activity].reverse();

  return (
    <div
      className="pointer-events-none absolute bottom-6 left-6 z-10 w-[22rem] max-w-[calc(100%-3rem)]"
      // Announced politely: it narrates background work and must not interrupt
      // a screen reader mid-sentence during a call.
      aria-live="polite"
    >
      <div className="overflow-hidden rounded-xl border border-border-default bg-bg-surface/95 shadow-2xl backdrop-blur">
        {/* Window chrome. Three dots and an address bar is the whole visual
            trick — it costs nothing and reads as "a browser" from across a
            room, which is exactly the distance a demo is watched from. */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <span className="flex gap-1.5">
            <i className="h-2 w-2 rounded-full bg-rose-400/70" />
            <i className="h-2 w-2 rounded-full bg-amber-400/70" />
            <i className="h-2 w-2 rounded-full bg-emerald-400/70" />
          </span>
          <span className="ml-1 flex-1 truncate rounded-md bg-bg-elevated px-2 py-1 text-[11px] text-text-muted">
            {rows[0].subject || rows[0].tool}
          </span>
        </div>

        <div className="max-h-64 divide-y divide-border-subtle overflow-y-auto">
          {rows.map((a) => (
            <Row key={a.id} activity={a} t={t} />
          ))}
        </div>
      </div>
    </div>
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
  return (
    <span className="ml-auto shrink-0 tabular-nums text-[11px] text-text-muted">
      {Math.floor(ms / 1000)}s
    </span>
  );
}

function Row({ activity: a, t }: { activity: ToolActivity; t: (k: 'call.toolSearching' | 'call.toolFailed' | 'call.toolDone') => string }) {
  const running = a.status === 'running';
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        {running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-brand" />
        ) : a.status === 'failed' ? (
          <AlertTriangle size={12} className="shrink-0 text-amber-400" />
        ) : (
          <Check size={12} className="shrink-0 text-emerald-400" />
        )}
        <span className="shrink-0 font-medium text-text-secondary">{a.tool}</span>
        {a.subject && (
          <span className="truncate text-text-muted" title={a.subject}>
            {a.subject}
          </span>
        )}
        {running && <Elapsed since={a.startedAt} />}
      </div>

      {/* A progress line while it runs, so a slow tool still moves. */}
      {running && a.note && (
        <p className="mt-1 truncate pl-5 text-[11px] text-text-muted">{a.note}</p>
      )}
      {running && !a.note && (
        <p className="mt-1 flex items-center gap-1.5 pl-5 text-[11px] text-text-muted">
          <Search size={10} />
          {t('call.toolSearching')}
        </p>
      )}

      {a.error && (
        <p className="mt-1 truncate pl-5 text-[11px] text-amber-400" title={a.error}>
          {a.error}
        </p>
      )}

      {/* The results, as they came back. Titles and hosts only — a snippet at
          this width is unreadable, and the host is what makes a viewer believe
          the page is real. */}
      {a.hits.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-5">
          {a.hits.slice(0, 4).map((h) => (
            <li key={h.url} className="flex items-baseline gap-1.5">
              <Globe size={9} className="shrink-0 translate-y-0.5 text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-text-secondary" title={h.title}>
                  {h.title}
                </span>
                <span className="block truncate text-[10px] text-brand/70">{h.host}</span>
              </span>
            </li>
          ))}
          {a.hits.length > 4 && (
            <li className="text-[10px] text-text-muted">+{a.hits.length - 4}</li>
          )}
        </ul>
      )}
    </div>
  );
}

