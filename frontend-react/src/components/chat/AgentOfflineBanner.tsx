/**
 * #11: "agent offline" banner. Shown in Agent mode after the sidecar exits
 * (`feral://agent-exit`). While the Rust supervisor is auto-restarting it
 * shows a spinner; if the supervisor gave up, it tells the user to restart
 * the app. Cleared automatically when `feral://agent-ready` fires again.
 */

import { Loader2, WifiOff } from 'lucide-react';
import { useFeralStore } from '@/stores/feral';

export function AgentOfflineBanner() {
  const offline = useFeralStore((s) => s.offline);
  const restarting = useFeralStore((s) => s.restarting);
  if (!offline) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-4 py-2 border-b border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs"
    >
      {restarting ? (
        <>
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>
            Feral Agent went offline — restarting automatically. Messages sent now
            will fail until it&apos;s back.
          </span>
        </>
      ) : (
        <>
          <WifiOff size={13} className="shrink-0" />
          <span>
            Feral Agent is offline and automatic restarts were suspended after
            repeated crashes. Restart the app to bring Agent mode back.
          </span>
        </>
      )}
    </div>
  );
}
