import { useEffect, useState } from 'react';
import type { AgentPhase } from '@/stores/chat';

interface StreamingIndicatorProps {
  phase?: AgentPhase;
  tool?: string | null;
}

function phaseLabel(phase: AgentPhase, tool?: string | null): string {
  if (phase === 'calling' && tool) return `Calling ${tool.replace(/_/g, ' ')}…`;
  if (phase === 'calling') return 'Calling tool…';
  if (phase === 'processing') return 'Processing results…';
  return 'Thinking…';
}

export function StreamingIndicator({ phase = 'thinking', tool }: StreamingIndicatorProps) {
  const [visible, setVisible] = useState(true);
  const [label, setLabel] = useState(() => phaseLabel(phase, tool));

  useEffect(() => {
    // Fade out → swap label → fade in
    setVisible(false);
    const swap = setTimeout(() => {
      setLabel(phaseLabel(phase, tool));
      setVisible(true);
    }, 120);
    return () => clearTimeout(swap);
  }, [phase, tool]);

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
