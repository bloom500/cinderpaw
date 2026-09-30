import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { decode, encode, type ToGame } from './emberBridge';
import { GAME_URL } from './emberAvailability';
import { takeNewSparks } from './sparks';
import type { EmberRun } from './useEmberRun';

/** How long the engine gets to say `ready` before the panel says it failed. */
export const READY_TIMEOUT_MS = 15_000;

/** The game above the composer. It stays loaded while its panel is closed
 *  (paused), so reopening during the same task resumes the same round. */
export function EmberPanel({ run, onClosed }: { run: EmberRun; onClosed?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const seen = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const stream = useChat((s) => s.toolCallStream);
  const recordScore = useUI((s) => s.recordEmberScore);
  const round = run.round;

  const post = (m: ToGame) => frame.current?.contentWindow?.postMessage(encode(m), window.location.origin);
  const close = () => {
    run.closePanel();
    onClosed?.();
  };

  // A new round starts clean.
  useEffect(() => {
    seen.current = new Set();
    setReady(false);
    setFailed(false);
    setScore(null);
  }, [round?.since]);

  useEffect(() => {
    if (!round) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const m = decode(e.data);
      if (m?.type === 'ready') {
        setReady(true);
        post({ type: 'start', best: useUI.getState().emberBest });
      } else if (m?.type === 'score') {
        setScore(m.value);
        recordScore(m.value);
      } else if (m?.type === 'close') {
        close();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [round?.since]);

  useEffect(() => {
    if (!round || ready) return;
    const id = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [round?.since, ready]);

  useEffect(() => {
    if (!ready || !round || round.ended) return;
    for (const kind of takeNewSparks(stream, seen.current, round.since)) post({ type: 'spark', kind });
  }, [stream, ready, round]);

  useEffect(() => {
    if (ready && round?.ended) post({ type: 'end', ok: round.ended.ok });
  }, [ready, round?.ended]);

  useEffect(() => {
    if (!ready) return;
    post({ type: run.open ? 'resume' : 'pause' });
    if (run.open) frame.current?.focus();
  }, [run.open, ready]);

  // A round that ended behind a closed panel has nobody watching: keep its
  // score if the game answers, then let it go.
  useEffect(() => {
    if (!round?.ended || run.open) return;
    if (score !== null || !ready) {
      run.closePanel();
      return;
    }
    const id = setTimeout(run.closePanel, 3000);
    return () => clearTimeout(id);
  }, [round?.ended, run.open, score, ready]);

  if (!round) return null;
  return (
    <div
      hidden={!run.open}
      className="relative mb-2 overflow-hidden rounded-2xl border border-border-default bg-[#241a16]"
      style={{ height: 'clamp(160px, 25vh, 260px)' }}
      onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
    >
      <iframe ref={frame} src={GAME_URL} title="Cinderpaw's campfire" className="block h-full w-full border-0" />
      {!ready && !failed && (
        <p className="absolute inset-0 grid place-items-center text-sm text-[#F6EFE6]/80">Lighting the campfire…</p>
      )}
      {failed && (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-[#241a16] p-4 text-center text-sm text-[#F6EFE6]">
          The game didn't start on this computer. The chat works as usual.
        </div>
      )}
      {round.ended && (
        <div className="absolute inset-x-0 bottom-0 flex justify-end p-3">
          <button type="button" onClick={close} className="rounded-full bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
            Back to the answer
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label="Close the game"
        onClick={close}
        className="absolute right-2 top-2 rounded-full p-1 text-[#F6EFE6]/80 hover:bg-white/10"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
