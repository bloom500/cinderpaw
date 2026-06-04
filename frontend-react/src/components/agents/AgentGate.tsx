import { useEffect } from 'react';
import { useAgent } from '@/stores/agent';
import { AgentChat } from './AgentChat';
import { AgentsOnboarding } from './onboarding/AgentsOnboarding';

type GateState =
  | { kind: 'loading' }
  | { kind: 'onboarding' }
  | { kind: 'chat' };

/**
 * Decide what the Agents tab renders.
 *
 * - `loading`    — first hydration of the agent list is in flight; show a
 *                  spinner so we don't flash the onboarding form.
 * - `onboarding` — no agent saved yet. Show the multi-step flow.
 * - `chat`       — at least one agent exists. Show the unified chat UI
 *                  bound to the active agent.
 *
 * Skipping onboarding is intentionally a no-op in V1: there's no useful
 * state to land on without an agent, and the chat view itself is unusable
 * without one. Settings → Agent is the path for managing existing agents.
 */
export function AgentGate() {
  const refresh = useAgent((s) => s.refresh);
  const current = useAgent((s) => s.current);
  const loading = useAgent((s) => s.loading);
  let state: GateState;
  if (loading) {
    state = { kind: 'loading' };
  } else if (current) {
    state = { kind: 'chat' };
  } else {
    state = { kind: 'onboarding' };
  }

  // First mount — hydrate from disk. We depend on `refresh` (stable in
  // zustand) so this only runs once. Earlier we also called refresh
  // from AgentChat; that created a 2-source-of-truth loop. See
  // AgentChat.tsx for the matching comment.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.kind === 'loading') {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm">
        Loading agents…
      </div>
    );
  }

  if (state.kind === 'onboarding') {
    return (
      <AgentsOnboarding
        onDone={() => {
          // DoneStep persists the active agent via the store; the next
          // render of this gate will see `current !== null` and switch
          // to the chat view automatically.
        }}
        onSkip={() => {
          // Intentionally a no-op — see the JSDoc above.
        }}
      />
    );
  }

  return <AgentChat />;
}
