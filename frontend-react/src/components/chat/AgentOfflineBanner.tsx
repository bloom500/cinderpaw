/**
 * #11: "agent offline" banner. Shown in Agent mode after the sidecar exits
 * (`feral://agent-exit`). While the Rust supervisor is auto-restarting it
 * shows a spinner; if the supervisor gave up, it tells the user to restart
 * the app. Cleared automatically when `feral://agent-ready` fires again.
 */

import { Loader2, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFeralStore } from '@/stores/feral';

const STARTUP_WARNING_DELAY_MS = 15_000;

export function AgentOfflineBanner() {
  const offline = useFeralStore((s) => s.offline);
  const restarting = useFeralStore((s) => s.restarting);
  const isReady = useFeralStore((s) => s.isReady);
  const [startupSlow, setStartupSlow] = useState(false);

  useEffect(() => {
    if (offline || isReady) {
      setStartupSlow(false);
      return;
    }
    const timer = window.setTimeout(
      () => setStartupSlow(true),
      STARTUP_WARNING_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [offline, isReady]);

  /**
   * The sidecar takes 40–70 seconds to announce itself, and the window is
   * interactive long before that. Nothing covered the gap: `offline` is false
   * because it has not exited, `isReady` is false because it has not arrived,
   * and the banner showed neither — so anything the user tried in that window
   * failed with "feral-agent is not running", which is true and reads as
   * broken when the truth is "not yet".
   *
   * They are different states and deserve different words. This one is the
   * only one that resolves on its own.
   */
  if (!offline && !isReady && startupSlow) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 border-b border-border-subtle bg-bg-elevated px-4 py-2 text-xs text-text-secondary"
      >
        <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
        <span>
          Feral Agent is starting — it loads its memory first, which takes a
          moment on a large workspace. Messages sent now will fail until it
          is up.
        </span>
      </div>
    );
  }

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
