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
  const room = useRef<Room | null>(null);
  /** Where remote audio is played. Created once and reused; a fresh element per
   *  call is how autoplay permission gets asked for twice. */
  const sink = useRef<HTMLAudioElement | null>(null);

  const hangUp = useCallback(async () => {
    await room.current?.disconnect();
    room.current = null;
    await tauri.raw.endLivekitSelftest().catch(() => {});
    setPhase('idle');
    setDetail('');
  }, []);

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
        sink.current = el;
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

  useEffect(
    () => () => {
      sink.current?.remove();
      sink.current = null;
    },
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Voice call self-test</p>
          <p className="text-xs text-text-muted mt-0.5">
            Runs a real call on this machine and echoes you back. No account, no key.
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

      {/* Said before the call, not after it howls. Echo through speakers is a
          feedback loop, and the person who needs this warning most is the one
          testing a microphone for the first time. */}
      {phase !== 'error' && (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Headphones className="h-3 w-3 shrink-0" />
          Use headphones — you will hear yourself, and speakers will squeal.
        </p>
      )}

      {phase === 'starting' && (
        <p className="text-xs text-text-muted">
          First run downloads the voice server and sets it up. This takes a minute.
        </p>
      )}

      {phase === 'live' && (
        <p className="text-xs text-text-primary">Connected. Say something — you should hear it back.</p>
      )}

      {phase === 'error' && <p className="text-xs text-error">{detail}</p>}
    </div>
  );
}
