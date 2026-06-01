import { useState } from 'react';
import { ONBOARDING_KEY } from '@/components/agents/agentUtils';
import { AgentsOnboarding } from '@/components/agents/onboarding/AgentsOnboarding';
import { AgentsMain }       from '@/components/agents/main/AgentsMain';

type View = 'onboarding' | 'main';

function initialView(): View {
  const flag = localStorage.getItem(ONBOARDING_KEY);
  if (flag === 'completed' || flag === 'dismissed') return 'main';
  return 'onboarding';
}

export function AgentsPage() {
  const [view, setView] = useState<View>(initialView);

  return view === 'onboarding'
    ? (
      <AgentsOnboarding
        onDone={() => setView('main')}
        onSkip={() => setView('main')}
      />
    )
    : (
      <AgentsMain
        onCreateFirst={() => setView('onboarding')}
      />
    );
}
