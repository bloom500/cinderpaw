import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, PhoneOff, Headphones } from 'lucide-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { tauri } from '@/lib/tauri';

/**
 * Does a voice call actually work on this machine?
 *
 * A self-test rather than a voice engine, and the distinction is honest rather
 * than modest: the far end echoes, it does not think. What this proves is the
 * part that is hard to prove any other way — that the app can start a LiveKit
 * server, that a second process joins the call, that the microphone reaches it
 * and that audio comes back — with no API key, no downloaded model and no
 * account. Somebody who has just installed Cinderpaw can run it.
 *
 * It stays useful after the real engine lands, for the same reason a network
 * settings panel has a "test connection" button: when a call fails, the first
 * question is whether the pipe or the brain is broken.
 */
export function LiveKitSelfTest() {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live' | 'error'>('idle');
  const [detail, setDetail] = useState<string>('');
  // Which far end answered. Unknown until the call starts, and the screen must
  // not guess: an echo introduced as an assistant is a worse lie than silence.
  const [mode, setMode] = useState<'assistant' | 'echo' | null>(null);
  const room = useRef<Room | null>(null);
  /** Every element `track.attach()` handed us, so every one can be taken back
   *  down. Attaching creates a NEW element per subscribed track, so keeping a
   *  single reference leaks one silent, dead `<audio>` into the page per call —
   *  invisible, and enough to make "is anything playing?" unanswerable. */
  const sinks = useRef<HTMLAudioElement[]>([]);

  const clearSinks = useCallback(() => {
    for (const el of sinks.current) {
      el.srcObject = null;
      el.remove();
    }
    sinks.current = [];
  }, []);

  const hangUp = useCallback(async () => {
    await room.current?.disconnect();
    room.current = null;
    await tauri.raw.endLivekitSelftest().catch(() => {});
    clearSinks();
    setPhase('idle');
    setDetail('');
    setMode(null);
  }, [clearSinks]);

  // A call must not outlive the panel that started it. Without this, closing
  // settings mid-test leaves a server, an agent and an open microphone running
  // with nothing on screen that mentions them.
  useEffect(() => () => void hangUp(), [hangUp]);

  const start = useCallback(async () => {
    setPhase('starting');
    setDetail('');
    try {
      const call = await tauri.raw.startLivekitSelftest();
      const r = new Room();
      room.current = r;

      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.autoplay = true;
        sinks.current.push(el);
        document.body.appendChild(el);
      });
      // The far end going away is not an error the user caused, but it is the
      // difference between "nothing is happening" and "it stopped".
      r.on(RoomEvent.Disconnected, () => {
        setPhase('idle');
        setDetail('');
      });

      await r.connect(call.url, call.token);
      await r.localParticipant.setMicrophoneEnabled(true);
      setMode(call.mode);
      setPhase('live');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setDetail(
        raw === 'livekit-no-node'
          ? 'This needs Node.js installed, which the voice engine runs on. Install it from nodejs.org and try again.'
          : raw.includes('Permission')
            ? 'The microphone was refused. Allow it for Cinderpaw in your system settings.'
            : raw,
      );
      await tauri.raw.endLivekitSelftest().catch(() => {});
    }
  }, []);

  useEffect(() => clearSinks, [clearSinks]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Voice call</p>
          <p className="text-xs text-text-muted mt-0.5">
            Runs the call on this machine. With a Google key you talk to your
            assistant; without one it echoes you back, so the microphone and
            speakers can still be checked.
          </p>
        </div>
        {phase === 'live' ? (
          <button
            type="button"
            onClick={() => void hangUp()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-primary hover:bg-bg-surface"
          >
            <PhoneOff className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={phase === 'starting'}
            onClick={() => void start()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-primary hover:bg-bg-surface disabled:opacity-60"
          >
            {phase === 'starting' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {phase === 'starting' ? 'Starting…' : 'Test'}
          </button>
        )}
      </div>

      {/* Said before the call, not after it howls — and only for the mode that
          howls. An assistant does not repeat you, so warning about feedback
          there is noise that teaches people to ignore the warning. */}
      {phase !== 'error' && mode !== 'assistant' && (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Headphones className="h-3 w-3 shrink-0" />
          Without a key this echoes you — use headphones, or speakers will squeal.
        </p>
      )}

      {phase === 'starting' && (
        <p className="text-xs text-text-muted">
          First run downloads the voice server and sets it up. This takes a minute.
        </p>
      )}

      {phase === 'live' && (
        <p className="text-xs text-text-primary">
          {mode === 'assistant'
            ? 'Connected. Say something — your assistant is listening.'
            : 'Connected, with no key: this is an echo, not an assistant. Say something and you should hear it back.'}
        </p>
      )}

      {phase === 'error' && <p className="text-xs text-error">{detail}</p>}
    </div>
  );
}
