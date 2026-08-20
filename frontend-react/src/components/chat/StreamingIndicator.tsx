import { useEffect, useState } from 'react';
import type { AgentPhase } from '@/stores/chat';
import { useModel } from '@/stores/model';
import { events, type StreamProgressEvent } from '@/lib/tauri';

interface StreamingIndicatorProps {
  phase?: AgentPhase;
  tool?: string | null;
}

/** #16: after this long with zero tokens, explain WHY nothing is happening. */
const SLOW_START_MS = 5_000;

function phaseLabel(phase: AgentPhase, tool?: string | null): string {
  if (phase === 'calling' && tool) return `Calling ${tool.replace(/_/g, ' ')}…`;
  if (phase === 'calling') return 'Calling tool…';
  if (phase === 'processing') return 'Processing results…';
  return 'Thinking…';
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function progressLabel(p: StreamProgressEvent): string {
  if (p.phase === 'prefill') return `Prefill · ${formatElapsed(p.elapsedMs)}`;
  if (p.tokensPerSec > 0.5) return `Generating · ${p.tokensPerSec.toFixed(1)} tok/s`;
  return 'Generating…';
}

export function StreamingIndicator({ phase = 'thinking', tool }: StreamingIndicatorProps) {
  const [visible, setVisible] = useState(true);
  // `baseLabel` comes from phase transitions (model load, calling, processing) — faded.
  // `progress` overrides it during 'thinking' phase with live heartbeat data — no fade.
  const [baseLabel, setBaseLabel] = useState(() => phaseLabel(phase, tool));
  const [progress, setProgress] = useState<StreamProgressEvent | null>(null);
  const [slowStart, setSlowStart] = useState(false);
  // #16: the very first message after install rides on a model load and a
  // long prompt prefill — minutes of silence on CPU-only machines, which
  // looks exactly like a hang. Surface the load progress while the model
  // loads, and an explanatory line when no token has arrived for a while.
  const isModelLoading = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);

  useEffect(() => {
    const t = setTimeout(() => setSlowStart(true), SLOW_START_MS);
    return () => clearTimeout(t);
  }, []);

  // Subscribe to progress heartbeats from both paths:
  // - streamProgressEvent: Rust local inference (chat tab, feral://stream-progress)
  // - onStreamProgress: sidecar agent inference (agent tab, filtered feral://agent-output)
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    const set = (e: StreamProgressEvent) => setProgress(e);
    events.streamProgressEvent.listen((e) => set(e.payload)).then((fn) => unlistens.push(fn));
    events.onStreamProgress.listen(set).then((fn) => unlistens.push(fn));
    return () => { unlistens.forEach((u) => u()); setProgress(null); };
  }, []);

  // Phase transitions → fade the base label. Progress ticks don't touch this.
  useEffect(() => {
    setVisible(false);
    const swap = setTimeout(() => {
      if (isModelLoading) {
        const pct = loadProgress ? ` ${Math.round(loadProgress.percentage)}%` : '';
        setBaseLabel(`Loading model…${pct}`);
      } else if (slowStart && phase === 'thinking') {
        setBaseLabel('Processing your message. The first response after loading a model can take a while…');
      } else {
        setBaseLabel(phaseLabel(phase, tool));
      }
      setVisible(true);
    }, 120);
    return () => clearTimeout(swap);
  }, [phase, tool, isModelLoading, loadProgress, slowStart]);

  // Live label: progress wins during thinking; otherwise base label.
  const label = progress && phase === 'thinking' && !isModelLoading
    ? progressLabel(progress)
    : baseLabel;

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-text-muted text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse [animation-delay:300ms]" />
      <span
        style={{ transition: 'opacity 120ms ease' }}
        className={visible ? 'opacity-100' : 'opacity-0'}
      >
        {label}
      </span>
    </div>
  );
}
