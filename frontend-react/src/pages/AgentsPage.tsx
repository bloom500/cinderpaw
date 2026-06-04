import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AgentsPageLayout } from '@/components/agents/AgentsPageLayout';
import { AgentGate } from '@/components/agents/AgentGate';
import { useAgent } from '@/stores/agent';

export function AgentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Bumping this on a "New agent" request forces AgentGate to re-mount
  // with a fresh state — without it, calling `useAgent.clear()` from
  // Settings → Agent only flips the gate to onboarding if the gate
  // itself rerenders, which depends on the rest of the route tree.
  // Re-mounting is the most robust way to guarantee the user lands on
  // a clean onboarding flow.
  const [resetKey, setResetKey] = useState(0);

  // Listen for the "New agent" navigation event from AgentSettingsTab.
  // We use a route state hash instead of a global event bus so the
  // intent stays local to the Agents/Settings pair.
  useEffect(() => {
    if (!location.state?.newAgent) return;
    setResetKey(Date.now());
    useAgent.getState().clear();
    // Clear the route state so a refresh of the page doesn't re-trigger.
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, navigate, location.pathname]);

  return (
    <AgentsPageLayout>
      <AgentGate key={resetKey} />
    </AgentsPageLayout>
  );
}
