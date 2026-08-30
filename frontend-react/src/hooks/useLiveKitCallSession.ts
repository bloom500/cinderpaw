import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { tauri } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import type { CallPhase } from './useCallSession';

/**
 * A call carried by LiveKit, wearing the same face as the other two engines.
 *
 * The return shape is deliberately identical to `useLiveCallSession` — the
 * overlay is driven by whichever hook the store selects, and a third shape
 * would mean a third set of branches in a component that already has enough.
 *
 * What is different, and is the whole point of the migration: no audio crosses
 * Tauri's IPC. The window speaks WebRTC to a server the app started on
 * loopback, and jitter, packet loss, echo cancellation and barge-in stop being
 * ours to hand-roll. What comes back through Rust is only what a person reads —
 * transcripts, the session's state, and the reason a call stopped.
 */
export const LIVEKIT_ENGINE_ID = 'livekit';

/**
 * What a call will be made with, read from the one place that holds it.
 *
 * Extracted so the warmup and the call cannot drift. Rust binds a warmed chain
 * to these exact values and discards one warmed for anything else — so a
 * warmup assembled even slightly differently from the call is not a small
 * inefficiency, it is a warmup that never applies and a person who still waits
 * the full boot. Two copies of this would drift on the first change.
 *
 * Read at call time rather than captured in a dep: a provider or voice picked
 * while the pre-call screen is open has to apply to THIS call, not the next.
 */
function callArgs() {
  const { s2sProvider, ttsVoice, ttsProvider, whisperModel, sttProvider, language } =
    useUI.getState();
  // In pipeline mode the voice belongs to the TTS ENGINE, not to the row — the
  // row has no voices of its own. Filing it under the row would lose the choice
  // the moment somebody switched engine, which is the same bug that made the
  // old voice pill dead.
  const pipeline = s2sProvider === 'pipeline';
  const voiceKey = pipeline ? ttsProvider : s2sProvider;
  return {
    provider: s2sProvider,
    voice: voiceKey ? (ttsVoice[voiceKey] ?? null) : null,
    pipeline: pipeline
      ? {
          ttsEngine: ttsProvider,
          sttModel: whisperModel,
          sttProvider,
          // Whisper treats language as an override, not a hint, and the app
          // already knows which one the user reads the interface in. Left out,
          // two words of Romanian come back as Japanese.
          sttLanguage: language,
        }
      : undefined,
  };
}

/**
 * Boot the call machinery while the pre-call screen is up, so pressing Call is
 * a join rather than a fifteen-second boot.
 *
 * Fire and forget, and safe to call again — Rust is idempotent and silent
 * about failure, because the call itself will do the same work and report it
 * properly. Exported so the overlay can re-warm when the person changes vendor
 * or voice: the chain that is warm is warm for what was picked when it started.
 */
export function warmLiveKit(): void {
  const a = callArgs();
  void tauri.raw.warmLivekit(a.provider, a.voice, a.pipeline).catch(() => {});
}

/** The far end's own words for what it is doing, mapped to the overlay's four
 *  states. Anything unrecognised leaves the phase alone rather than inventing
 *  one: a wrong state on screen is worse than a stale one. */
function phaseOf(state: string): CallPhase | null {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return null;
  }
}

export function useLiveKitCallSession() {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const room = useRef<Room | null>(null);
  /** Every element `track.attach()` produced, so every one can be removed.
   *  Attaching makes a NEW element per track, so keeping one reference leaks a
   *  dead, silent `<audio>` per call. */
  const sinks = useRef<HTMLAudioElement[]>([]);
  /** The mic meter's teardown, if it is running. */
  const meter = useRef<(() => void) | null>(null);
  /** Bumped by every open and hang-up; an async step that finds it changed
   *  gives up rather than reviving a call the person already ended. */
  const generation = useRef(0);
  /** True from the moment `begin` is entered until its room is connected or
   *  it has failed. `room.current` cannot cover that window on its own: it is
   *  only assigned after an await, and the whole bug was two `begin`s racing
   *  inside exactly that gap. */
  const starting = useRef(false);

  const cleanup = useCallback(() => {
    meter.current?.();
    meter.current = null;
    for (const el of sinks.current) {
      el.srcObject = null;
      el.remove();
    }
    sinks.current = [];
  }, []);

  const hangUp = useCallback(() => {
    generation.current += 1;
    void room.current?.disconnect();
    room.current = null;
    cleanup();
    void tauri.raw.endLivekitCall().catch(() => {});
    setPhase('idle');
    setHeard('');
    setLevel(0);
    setNotice(null);
  }, [cleanup]);

  // Subscribed for the hook's whole life, not per call: the first transcript
  // can land before `connect` resolves, and a listener attached after that has
  // already missed it.
  useEffect(() => {
    const pending = events.liveKitEvent.listen((e) => {
      if (e.kind === 'heard' && e.text) {
        // On screen immediately, whether or not it has settled — the point of
        // a partial is that it arrives while the person is still speaking.
        setHeard(e.text);
        // Written to the conversation only once it has. A partial is the same
        // sentence mid-revision, so persisting it would file a dozen truncated
        // copies of every utterance in the chat history.
        if (!e.partial) writeToChat('user', e.text);
      }
      if (e.kind === 'said' && e.text) writeToChat('assistant', e.text);
      if (e.kind === 'state') {
        const next = phaseOf(e.text ?? '');
        if (next) setPhase((p) => (p === 'idle' || p === 'ready' ? p : next));
      }
      if (e.kind === 'error') {
        setNotice(
          /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(e.text ?? '')
            ? 'Google cut the call off: the free tier limits how much voice you get. Wait a few minutes, or add billing to that key.'
            : (e.text ?? 'The call reported an error.'),
        );
      }
    });
    return () => { void pending.then((un) => un()); };
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** The pre-call screen. No microphone, no server, nothing started. */
  const open = useCallback(() => {
    generation.current += 1;
    setNotice(null);
    setHeard('');
    setPhase('ready');
    // The screen appearing IS the signal to boot. Waiting for the button means
    // the person watches the boot; starting here means they read the screen
    // while it happens.
    warmLiveKit();
  }, []);

  const begin = useCallback(async () => {
    // One call at a time. This guard is the entire fix for two voices
    // answering one question, so it is worth saying why it has to be here.
    //
    // Nothing stopped `begin` from running twice — a second tap on the call
    // button, a re-render, a retry after a slow start. Every entry asked Rust
    // for a call, and Rust's `rejoin` mints a NEW room; a new room dispatches
    // a NEW agent, because the worker carries no name and LiveKit dispatches
    // nameless workers on room creation. Meanwhile `room.current` was
    // overwritten below, so the PREVIOUS room object was lost with its
    // microphone still enabled and nobody left holding a reference to
    // disconnect it. Two rooms, two agents, one person's voice reaching both,
    // and two different answers spoken over each other.
    if (starting.current || room.current) return;
    starting.current = true;
    const mine = ++generation.current;
    setNotice(null);
    try {
      // Read at call time, not captured in a dep: a provider picked while
      // the pre-call screen is open has to apply to THIS call, not the
      // next one.
      const args = callArgs();
      const call = await tauri.raw.startLivekitCall(args.provider, args.voice, args.pipeline);
      if (mine !== generation.current) {
        // Hung up while starting — but Rust has ALREADY minted a room and
        // dispatched an agent for it. Returning without saying so leaves that
        // agent alive in a room nobody will ever join, holding a vendor
        // session open and, on a metered key, billing for silence.
        void tauri.raw.endLivekitCall().catch(() => {});
        return;
      }
      const r = new Room();
      room.current = r;

      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.autoplay = true;
        sinks.current.push(el);
        document.body.appendChild(el);
      });
      r.on(RoomEvent.Disconnected, () => hangUp());

      await r.connect(call.url, call.token);
      await r.localParticipant.setMicrophoneEnabled(true);
      if (mine !== generation.current) {
        void r.disconnect();
        return;
      }
      setPhase('listening');
      meter.current = startMeter(r, setLevel);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setNotice(
        raw === 'livekit-no-node'
          ? 'Voice needs Node.js installed. Install it from nodejs.org and try again.'
          : raw.includes('Permission')
            ? 'The microphone was refused. Allow it for Cinderpaw in your system settings.'
            : raw,
      );
      setPhase('ready');
      void tauri.raw.endLivekitCall().catch(() => {});
    } finally {
      // Released on every path, success or failure. Left set after a failed
      // start, the guard above would refuse every retry and the call button
      // would be dead until the app restarted.
      starting.current = false;
    }
  }, [hangUp]);

  /** Both of these go over LiveKit's own data channel — the window is already
   *  in the room, so there is no second connection to keep alive. */
  const command = useCallback((msg: object) => {
    void room.current?.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(msg)),
      { reliable: true },
    );
  }, []);

  const interrupt = useCallback(() => command({ type: 'interrupt' }), [command]);
  const say = useCallback(
    (text: string) => {
      if (text.trim()) command({ type: 'text', text });
    },
    [command],
  );

  // `transcribing` exists because the other two engines expose it; here the far
  // end transcribes continuously and never reports a gap, so claiming a moment
  // of it would be invention.
  return { phase, heard, level, notice, transcribing: false, open, begin, hangUp, interrupt, say };
}

/**
 * A spoken turn, written into the conversation on screen.
 *
 * A call that leaves no trace is a call you cannot look anything up in
 * afterwards — the one thing text has over speech is that it is still there
 * tomorrow. Both sides go in, in the order they were spoken.
 *
 * The id carries a counter as well as the clock: two turns can land in the same
 * millisecond, and React lists keyed by a duplicate id drop one of them.
 */
let turnSeq = 0;
function writeToChat(role: 'user' | 'assistant', content: string) {
  const text = content.trim();
  if (!text) return;
  const now = Date.now();
  useChat.getState().addMessage({
    id: `livekit-${role[0]}-${now}-${++turnSeq}`,
    role,
    content: text,
    createdAt: now,
  });
}

/**
 * Microphone level, read from the track already being published.
 *
 * Not a second `getUserMedia`: opening the device twice is how a call ends up
 * with two capture streams and an echo canceller that cannot see one of them.
 */
function startMeter(room: Room, onLevel: (v: number) => void): () => void {
  const pub = [...room.localParticipant.audioTrackPublications.values()][0];
  const stream = pub?.track?.mediaStream;
  if (!stream) return () => {};

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  let raf = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    onLevel(peak / 128);
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    void ctx.close();
  };
}
