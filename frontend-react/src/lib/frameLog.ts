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
