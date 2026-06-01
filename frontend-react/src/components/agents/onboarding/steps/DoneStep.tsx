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
  onViewAgents: () => void;
}

export function DoneStep({ agentName, agentId, onViewAgents }: Props) {
  const [warmup, setWarmup] = useState<WarmupState>({ phase: 'idle' });

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;

    async function run() {
      setWarmup({ phase: 'running' });
      // warmupAgent handles all failure cases (gateway down, auth error, timeout)
      // by returning a result with kind != 'ok'. It never throws.
      const result = await tauri.openclaw.warmupAgent(agentId!);
      if (!cancelled) setWarmup({ phase: 'done', result });
    }

    void run();
    return () => { cancelled = true; };
  }, [agentId]);

  const badge = (() => {
    if (warmup.phase === 'running') {
      return (
        <div className="flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          Preparing OpenClaw runtime…
        </div>
      );
    }
    if (warmup.phase === 'done') {
      const ok = warmup.result.kind === 'ok';
      return ok ? (
        <div className="flex items-center gap-1.5 text-xs text-green-400">
          <CheckCircle size={12} />
          OpenClaw ready — this agent is connected.
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-amber-400">
          Setup needed — OpenClaw not running or not authenticated.{' '}
          <span className="text-text-muted">Check Settings → OpenClaw.</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="max-w-md mx-auto space-y-6 pt-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <CheckCircle size={40} className="text-green-400" />
        <h2 className="text-xl font-semibold text-text-primary">
          "{agentName}" is saved
        </h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          Your agent profile has been saved. It's ready to use once you load a model.
        </p>
        {badge}
      </div>

      <div className="rounded-md bg-bg-hover p-4 text-left space-y-1.5">
        <p className="text-xs font-medium text-text-primary">Next steps</p>
        <ol className="text-xs text-text-muted space-y-1 list-decimal list-inside">
          <li>Go to <span className="text-text-secondary font-medium">Models</span> and load a local model.</li>
          <li>Come back to <span className="text-text-secondary font-medium">Agents</span> to run your agent.</li>
        </ol>
      </div>

      <button
        type="button"
        onClick={onViewAgents}
        className="px-5 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
      >
        View my agents
      </button>
    </div>
  );
}
