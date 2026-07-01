/**
 * Subscribes to Dream Cycle pulses from the sidecar and surfaces them:
 *   - `started` → mascot enters its `dreaming` pose + an info toast.
 *   - `ended`   → mascot wakes + a success toast summarising the episode.
 *
 * Mount once near the app root (it owns a single global listener).
 */
import { useEffect } from 'react';
import { events } from '@/lib/tauri/events';
import { useDream } from '@/stores/dream';
import { useNotifications } from '@/stores/notifications';

export function useDreamCycle(): void {
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onDreamCycle.listen((e) => {
      if (!alive) return;
      if (e.phase === 'started') {
        useDream.getState().setDreaming(true);
        useNotifications.getState().push(
          'info',
          '💤 Feral is dreaming',
          'Evolving its own configuration in the background while you’re idle.',
        );
      } else {
        useDream.getState().setDreaming(false);
        useDream.getState().setStage(null); // cycle over — clear the stage
        const iters = e.iterations ?? 0;
        useNotifications.getState().push(
          'success',
          '✨ Dream cycle complete',
          `Explored ${iters} iteration${iters === 1 ? '' : 's'} of self-improvement.`,
        );
      }
    });
    // The fine §2.8 stage pulses drive the live stage indicator in the Dreams
    // panel — separate stream so the mascot/toast path above stays untouched.
    const unlistenStageP = events.onDreamStage.listen((e) => {
      if (alive && e.stage) useDream.getState().setStage(e.stage);
    });
    return () => {
      alive = false;
      void unlistenP.then((u) => u()).catch(() => {});
      void unlistenStageP.then((u) => u()).catch(() => {});
    };
  }, []);
}
