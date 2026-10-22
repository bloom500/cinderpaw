import { tauri } from '@/lib/tauri';

// Janky animations were reported with nothing to show where the time went:
// the webview console is invisible in the installed app, and on 18 Sep the lag
// was state-dependent (long uptime, long chat) so it never reproduced on a
// fresh launch under a profiler. This writes every frame that blocked for
// SLOW_MS or more into ~/.cinderpaw/logs/cinderpaw.log with the script that
// held it, so the next "it felt laggy" comes with a line to read.
// Local file only; nothing leaves the machine.
//
// `long-animation-frame` exists in WebView2 (Chromium 123+). WKWebView (macOS)
// and WebKitGTK do not have it: there the observer is simply not started.
const SLOW_MS = 150;
// ponytail: fixed cap, one line per 2 s; a stuck UI would otherwise flood the log.
const MIN_GAP_MS = 2_000;

interface LoafScript { sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration: number }
interface LoafEntry extends PerformanceEntry { blockingDuration: number; scripts?: LoafScript[] }

export function describeFrame(e: LoafEntry): string {
  const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
  const where = top
    ? ` top=${Math.round(top.duration)}ms ${top.invoker ?? ''} ${top.sourceFunctionName || '?'}@${(top.sourceURL ?? '').split('/').pop() || '?'}`
    : ' top=none (style/layout/paint)';
  return `frame=${Math.round(e.duration)}ms blocking=${Math.round(e.blockingDuration)}ms${where}`;
}

export function startFrameLog(): void {
  if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return;
  let last = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as LoafEntry[]) {
      if (e.duration < SLOW_MS || e.startTime - last < MIN_GAP_MS) continue;
      last = e.startTime;
      void tauri.raw.uiLog('lag', describeFrame(e)).catch(() => {});
    }
  }).observe({ type: 'long-animation-frame', buffered: false });
}

// The log above is for incidents: 150 ms frames, one line per 2 s. It cannot
// say whether a gesture felt smooth, where 20-100 ms frames are what people
// notice (audit R10, 20 Oct). This meter is for the UX lab: inert until a
// driver calls `window.__cinderpawFrames.start()` over the debug port, then it
// keeps every frame interval in memory until `stop()` returns the summary.
// Nothing is written or sent anywhere.
export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  longest: number;
  /** Share of intervals at or under one 60 Hz frame (16.7 ms). */
  smooth: number;
  /** Long animation frames of 50 ms or more (WebView2 only; 0 elsewhere). */
  blocked50: number;
}

export function frameStats(intervals: number[], blocked50 = 0): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    frames: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    longest: round(sorted[sorted.length - 1] ?? 0),
    smooth: sorted.length ? round((sorted.filter((d) => d <= 16.7).length / sorted.length) * 100) : 0,
    blocked50,
  };
}

interface MeterRun { intervals: number[]; blocked: number; raf: number; obs?: PerformanceObserver }

export function installFrameMeter(): void {
  let run: MeterRun | null = null;
  const start = () => {
    if (run) return;
    const r: MeterRun = { intervals: [], blocked: 0, raf: 0 };
    let prev = performance.now();
    const tick = (now: number) => {
      r.intervals.push(now - prev);
      prev = now;
      r.raf = requestAnimationFrame(tick);
    };
    r.raf = requestAnimationFrame((now) => { prev = now; r.raf = requestAnimationFrame(tick); });
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      r.obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= 50) r.blocked++;
      });
      r.obs.observe({ type: 'long-animation-frame', buffered: false });
    }
    run = r;
  };
  const stop = (): FrameStats | null => {
    if (!run) return null;
    cancelAnimationFrame(run.raf);
    run.obs?.disconnect();
    const stats = frameStats(run.intervals, run.blocked);
    run = null;
    return stats;
  };
  (window as unknown as { __cinderpawFrames: unknown }).__cinderpawFrames = { start, stop };
}
