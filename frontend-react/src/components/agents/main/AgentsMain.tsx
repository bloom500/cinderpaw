import { useEffect, useState } from 'react';
import { Bot, Plus, AlertCircle, Info } from 'lucide-react';
import { tauri, type AgentConfig } from '@/lib/tauri';
import { ONBOARDING_KEY } from '../agentUtils';
import { AgentCard } from './AgentCard';

interface Props {
  onCreateFirst: () => void;
}

export function AgentsMain({ onCreateFirst }: Props) {
  const [agents, setAgents]       = useState<AgentConfig[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [gatewayUp, setGatewayUp] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await tauri.agents.getAll();
      setAgents(list);
      // Refresh each OpenClaw agent's readiness with a fast gateway probe so the
      // status badge reflects current reachability, not a stale warmup result.
      void refreshReadiness(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Re-probe gateway readiness for every agent, then refresh the list to pick up
  // the persisted `openclaw_ready` updates. All agents run through OpenClaw, so
  // we probe each one (warmup also normalises preferred_runtime to openclaw).
  // Best-effort: failures here never disrupt the page.
  const refreshReadiness = async (list: AgentConfig[]) => {
    const ids = list.filter((a) => a.id).map((a) => a.id!);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => tauri.openclaw.warmupAgent(id).catch(() => null)));
    const fresh = await tauri.agents.getAll().catch(() => null);
    if (fresh) setAgents(fresh);
  };

  useEffect(() => {
    void load();
    tauri.openclaw.detect()
      .then((r) => setGatewayUp(r.installed))
      .catch(() => setGatewayUp(false));
  }, []);

  const handleDelete = async (id: string) => {
    await tauri.agents.delete(id);
    setAgents((prev) => prev.filter((a) => a.id !== id));
  };

  const handleCreateFirst = () => {
    localStorage.removeItem(ONBOARDING_KEY);
    onCreateFirst();
  };

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 rounded-lg bg-bg-hover animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 flex items-start gap-3">
          <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm text-red-400">Couldn't load agents.</p>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-6">
        <Bot size={36} className="text-text-muted" />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-text-primary">No agents yet</h2>
          <p className="text-sm text-text-muted max-w-xs">
            Create your first agent to get started.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCreateFirst}
          className="px-4 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
        >
          Create your first agent
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      {/* Runtime mode banner */}
      <div className="flex items-start gap-2 rounded-md bg-bg-hover p-3">
        <Info size={13} className="text-text-muted shrink-0 mt-0.5" />
        <p className="text-xs text-text-muted">
          These agents run through{' '}
          <span className="text-text-secondary font-medium">OpenClaw</span>{' '}
          on your local model. Open a card below to run an agent or test it directly.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary">My Agents</h1>
        <button
          type="button"
          onClick={handleCreateFirst}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <Plus size={14} /> New agent
        </button>
      </div>

      <div className="space-y-3">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            gatewayUp={gatewayUp}
            onDelete={() => handleDelete(a.id!)}
          />
        ))}
      </div>
    </div>
  );
}
