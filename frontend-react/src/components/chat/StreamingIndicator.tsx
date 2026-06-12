import { useEffect, useState } from 'react';
import type { AgentPhase } from '@/stores/chat';
import { useModel } from '@/stores/model';

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

export function StreamingIndicator({ phase = 'thinking', tool }: StreamingIndicatorProps) {
  const [visible, setVisible] = useState(true);
  const [label, setLabel] = useState(() => phaseLabel(phase, tool));
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

  useEffect(() => {
    // Fade out → swap label → fade in
    setVisible(false);
    const swap = setTimeout(() => {
      if (isModelLoading) {
        const pct = loadProgress ? ` ${Math.round(loadProgress.percentage)}%` : '';
        setLabel(`Loading model…${pct}`);
      } else if (slowStart && phase === 'thinking') {
        setLabel('Processing your message — the first response after loading a model can take a while…');
      } else {
        setLabel(phaseLabel(phase, tool));
      }
      setVisible(true);
    }, 120);
    return () => clearTimeout(swap);
  }, [phase, tool, isModelLoading, loadProgress, slowStart]);

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
