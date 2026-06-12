import { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { tauri } from '@/lib/tauri';

type ProbeState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; up: boolean };

interface Props {
  agentName: string;
  agentId?: string;
  loadedModelName?: string;
  onStartChatting: () => void;
}

export function DoneStep({ agentName, agentId, loadedModelName, onStartChatting }: Props) {
  const [probe, setProbe] = useState<ProbeState>({ phase: 'idle' });

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;

    async function run() {
      setProbe({ phase: 'running' });
      // Cheap reachability probe: returns true when the Feral Agent sidecar
      // is alive and responded to a health check. We don't run a full
      // inference round-trip here — that happens on the first user message.
      const up = await tauri.feralAgent.status().catch(() => false);
      if (!cancelled) setProbe({ phase: 'done', up });
    }

    void run();
    return () => { cancelled = true; };
  }, [agentId]);

  const badge = (() => {
    if (probe.phase === 'running') {
      return (
        <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          Checking Feral Agent…
        </div>
      );
    }
    if (probe.phase === 'done' && probe.up) {
      return (
        <div className="flex items-center justify-center gap-1.5 text-xs text-green-400">
          <CheckCircle size={12} />
          Feral Agent ready
        </div>
      );
    }
    return (
      <div className="text-xs text-text-muted text-center">
        Feral Agent sidecar is not running. Open a chat to start it.
      </div>
    );
  })();

  return (
    <div className="space-y-8 text-center">
      <div className="text-5xl leading-none" aria-hidden="true">🎉</div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          "{agentName}" is ready
        </h2>
        {loadedModelName ? (
          <p className="text-sm text-text-muted">
            Connected to <span className="text-text-secondary font-medium">{loadedModelName}</span>.
          </p>
        ) : probe.phase === 'done' && !probe.up ? null : (
          <p className="text-sm text-text-muted">
            Load a model in the Models tab to start using it.
          </p>
        )}
      </div>

      {badge}

      <button
        type="button"
        onClick={onStartChatting}
        className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand/90 transition-colors"
      >
        Start chatting →
      </button>
    </div>
  );
}
