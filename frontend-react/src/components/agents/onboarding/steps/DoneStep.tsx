import { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { tauri, type OpenClawTestMessageResult } from '@/lib/tauri';

type WarmupState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: OpenClawTestMessageResult };

interface Props {
  agentName: string;
  agentId?: string;
  loadedModelName?: string;
  onViewAgents: () => void;
}

export function DoneStep({ agentName, agentId, loadedModelName, onViewAgents }: Props) {
  const [warmup, setWarmup] = useState<WarmupState>({ phase: 'idle' });

  useEffect(() => {
    if (!agentId) return;
    const id = agentId;
    let cancelled = false;

    async function run() {
      setWarmup({ phase: 'running' });
      const result = await tauri.openclaw.warmupAgent(id);
      if (!cancelled) setWarmup({ phase: 'done', result });
    }

    void run();
    return () => { cancelled = true; };
  }, [agentId]);

  const badge = (() => {
    if (warmup.phase === 'running') {
      return (
        <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          Connecting to OpenClaw…
        </div>
      );
    }
    if (warmup.phase === 'done') {
      const ok = warmup.result.kind === 'ok';
      return ok ? (
        <div className="flex items-center justify-center gap-1.5 text-xs text-green-400">
          <CheckCircle size={12} />
          OpenClaw ready
        </div>
      ) : (
        <div className="text-xs text-amber-400 text-center">
          OpenClaw not connected —{' '}
          <span className="text-text-muted">check Settings → OpenClaw.</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="space-y-8 text-center">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-full bg-green-400/10 flex items-center justify-center">
          <CheckCircle size={28} className="text-green-400" />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          "{agentName}" is ready
        </h2>
        {loadedModelName ? (
          <p className="text-sm text-text-muted">
            Connected to <span className="text-text-secondary font-medium">{loadedModelName}</span>.
          </p>
        ) : (
          <p className="text-sm text-text-muted">
            Load a model in the Models tab to start running it.
          </p>
        )}
      </div>

      {badge}

      <button
        type="button"
        onClick={onViewAgents}
        className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand/90 transition-colors"
      >
        Go to agents
      </button>
    </div>
  );
}
