import { useEffect } from 'react';
import { useCinderpawGlobal } from '@/hooks/useCinderpaw';
import { ensureCinderpawListener } from '@/lib/cinderpawAgentStream';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useCoworkTeam } from '@/stores/coworkTeam';

export function CinderpawGlobalMount() {
  useCinderpawGlobal();
  const ready = useCinderpawStore((s) => s.isReady);
  useEffect(() => {
    if (!ready) return;
    const initialRoster = useCoworkTeam.getState().roster;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (attempt: number) => {
      if (disposed || (attempt > 0 && useCoworkTeam.getState().roster !== initialRoster)) return;
      try {
        await ensureCinderpawListener();
        if (!disposed) await useCoworkTeam.getState().refresh();
      } catch { /* Retry after the startup listeners have settled. */ }
      // The invoke acknowledges delivery. The roster arrives separately.
      if (!disposed && attempt < 3 && useCoworkTeam.getState().roster === initialRoster) {
        timer = setTimeout(() => void refresh(attempt + 1), 750 * (attempt + 1));
      }
    };
    void refresh(0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready]);
  return null;
}
