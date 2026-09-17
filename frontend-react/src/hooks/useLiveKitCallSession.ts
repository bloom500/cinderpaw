import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { tauri } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import type { CallPhase, CallStage } from './useCallSession';
import { callMark, turnMark, resetTurns } from '@/lib/callTiming';

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
 * Keep a raw engine error short enough to sit inside a sentence.
 *
 * These strings arrive from LiveKit and from Rust, and some of them carry a
 * whole stack or a URL with a token in it. One line, no newlines, capped.
 */
export function trimNotice(raw: string, max = 120): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

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
/**
 * The language the person SPEAKS on a call, as BCP-47.
 *
 * Not the interface language: that is `'en'` on every install until somebody
 * changes it, the interface is English by decision this release, and sending
 * `en` told Gemini to expect English from a Romanian speaker. The machine's own
 * locale is the better statement of what is spoken in the room; an interface
 * language that was actually chosen (anything but the `'en'` default) beats it,
 * because that is a person saying so rather than a guess.
 */
function spokenLanguage(uiLanguage: string): string {
  if (uiLanguage && uiLanguage !== 'en') return uiLanguage;
  const os = typeof navigator !== 'undefined' ? navigator.language : '';
  return os || uiLanguage || '';
}

/**
 * What a vendor's refusal means, in a sentence the person can act on.
 *
 * Exported for its test. The two cases here are both measured: the free-tier
 * cut-off, and a model that opens a live session and then refuses audio —
 * Google lists it as live-capable, so the picker offers it and only the call
 * finds out.
 */
export function callFailureLine(raw: string): string {
  const text = raw.trim();
  if (/429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(text)) {
    return 'Google cut the call off: the free tier limits how much voice you get. Wait a few minutes, or add billing to that key.';
  }
  if (/CONTENT_TYPE_AUDIO|not supported for this model/i.test(text)) {
    return 'That model cannot speak: it accepts a live session but refuses audio. Pick another model in the call settings.';
  }
  return text || 'The call reported an error.';
}

function callArgs() {
  const { s2sProvider, s2sModel, ttsVoice, ttsProvider, sttModel, sttProvider, language } =
    useUI.getState();
  const spoken = spokenLanguage(language);
  // In pipeline mode the voice belongs to the TTS ENGINE, not to the row — the
  // row has no voices of its own. Filing it under the row would lose the choice
  // the moment somebody switched engine, which is the same bug that made the
  // old voice pill dead.
  const pipeline = s2sProvider === 'pipeline';
  const voiceKey = pipeline ? ttsProvider : s2sProvider;
  return {
    provider: s2sProvider,
    voice: voiceKey ? (ttsVoice[voiceKey] ?? null) : null,
    // The pipeline has no single model — its halves have their own pickers —
    // so it never sends one, and Rust keeps the vendor's pinned default when
    // this is empty.
    model: !pipeline && s2sProvider ? (s2sModel[s2sProvider] || null) : null,
    // Sent for EVERY call, not only the pipeline's. Whatever the agent says on
    // its own while a tool runs has to be said in the language the app is being
    // used in; a Romanian caller hearing "one moment" in English has been
    // handed a different product mid-sentence.
    language: spoken,
    pipeline: pipeline
      ? {
          ttsEngine: ttsProvider,
          // The stored id, which the Rust side resolves against the models
          // THIS build has. Sending it raw was safe while there was one engine
          // and one set of ids; it is not now, and `stt::resolve` is where that
          // decision lives for both doors into local transcription.
          sttModel,
          sttProvider,
          // Whisper treats language as an override, not a hint, and the app
          // already knows which one the user reads the interface in. Left out,
          // two words of Romanian come back as Japanese.
          sttLanguage: spoken,
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
  void tauri.raw.warmLivekit(a.provider, a.voice, a.model, a.pipeline, a.language).catch(() => {});
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

/**
 * Loud enough to be a voice rather than a room.
 *
 * `startMeter` reports a peak in 0..1 off the published track. Breathing and a
 * fan sit well under this; a spoken word goes over it within a frame, which is
 * the whole point — this is the only signal about the caller that arrives
 * without waiting for a vendor.
 */
export const SPEAKING_LEVEL = 0.06;

/**
 * Below this, a voice is over: the level has to fall this far before the line
 * is allowed to stop saying you are being heard.
 *
 * Two thresholds rather than one, because speech is not loud continuously. A
 * single threshold is crossed several times a second by the gaps inside an
 * ordinary sentence — between words, on a consonant, at a breath — so the
 * dots and the invitation underneath them alternated at that rate. Measured on
 * a real call: "it flickers hard".
 */
const QUIET_LEVEL = 0.025;

/**
 * ...and how long a gap may be before it counts as a silence.
 *
 * Hysteresis alone is not enough. A pause between two words drops below even
 * the quiet threshold, and 500 ms is longer than any gap inside a sentence and
 * shorter than the pause before somebody expects an answer.
 */
const QUIET_HOLD_MS = 500;

export function useLiveKitCallSession() {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [stage, setStage] = useState<CallStage>(null);
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  /**
   * True once the vendor has settled the last thing it heard.
   *
   * The screen used to hold that settled sentence while the caller was already
   * saying the next one — on a native-audio model the new transcript lands
   * AFTER the turn, so for those seconds the words on screen are the previous
   * question. It reads as a call that stopped listening. The microphone knows
   * better and knows instantly, so it is what clears the line.
   */
  const turnSettled = useRef(false);
  /** Whether the caller is mid-sentence, with the gaps inside one smoothed over. */
  const [youSpeaking, setYouSpeaking] = useState(false);
  const quietSince = useRef(0);
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
  /** The generation whose `begin` is currently in flight, or `null`.
   *
   *  A plain boolean here was a dead call button. It was set on entry and only
   *  cleared when that `begin` finished, so cancelling during a fifteen second
   *  boot and pressing Call again did nothing at all: the guard was still held
   *  by an attempt the person had already abandoned, and stayed held for the
   *  rest of the boot. Scoping it to the generation keeps the guard that stops
   *  two live calls (same generation, second press refused) while letting a
   *  cancelled one be replaced immediately. */
  const starting = useRef<number | null>(null);

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
    callMark('call_disconnected');
    resetTurns();
    void room.current?.disconnect();
    room.current = null;
    cleanup();
    void tauri.raw.endLivekitCall().catch(() => {});
    setPhase('idle');
    setStage(null);
    setHeard('');
    setLevel(0);
    setYouSpeaking(false);
    setNotice(null);
  }, [cleanup]);

  // Subscribed for the hook's whole life, not per call: the first transcript
  // can land before `connect` resolves, and a listener attached after that has
  // already missed it.
  useEffect(() => {
    const pending = events.liveKitEvent.listen((e) => {
      // Every event, one line, no content. A call that goes quiet leaves no
      // trace anywhere else: Rust forwards these straight to the window and
      // logs none of them, so "it stopped hearing me after two turns" came
      // with nothing to look at. Kind, state and a character COUNT — never a
      // word of what was said, which is the same rule the timing marks keep.
      console.info(
        `[call] ${e.kind}${e.text !== undefined && e.text !== null && e.kind === 'state' ? `=${e.text}` : ''}` +
          `${e.partial === true ? ' partial' : ''}` +
          `${typeof e.text === 'string' && e.kind !== 'state' ? ` ${e.text.length}ch` : ''}`,
      );
      if (e.kind === 'heard' && e.text) {
        callMark('first_transcript');
        turnMark(e.partial ? 'heard' : 'transcribed');
        // On screen immediately, whether or not it has settled — the point of
        // a partial is that it arrives while the person is still speaking.
        setHeard(e.text);
        // Written to the conversation only once it has. A partial is the same
        // sentence mid-revision, so persisting it would file a dozen truncated
        // copies of every utterance in the chat history.
        turnSettled.current = !e.partial;
        if (!e.partial) writeToChat('user', e.text);
      }
      if (e.kind === 'said' && e.text) {
        callMark('first_agent_response');
        const done = turnMark('answered');
        // One line per turn, not per event: this is the only place the shape
        // of a long call is visible, and the whole complaint is that it
        // changes between turn 1 and turn 100. Stage names and milliseconds,
        // never a word of what was said.
        if (done) {
          console.info(
            // `reply` first, because it is the only one of these that is not
            // partly a measure of how long the caller spoke — and so the only
            // one that answers "is this call getting slower".
            `[call] turn ${done.turn}: reply ${done.spans.reply ?? '?'}ms ` +
              `(from your last word), transcript ${done.spans.transcribed ?? '?'}ms, ` +
              `answer started ${done.spans.answering ?? '?'}ms, complete ${done.spans.answered ?? '?'}ms`,
          );
        }
        writeToChat('assistant', e.text);
      }
      if (e.kind === 'state') {
        if (e.text === 'speaking') turnMark('answering');
        const next = phaseOf(e.text ?? '');
        // Never over a state the far end cannot know about. It has no idea
        // the transport is retrying or that this window has not joined yet,
        // and a `listening` from it during either is the wrong thing on
        // screen at exactly the moment the screen is being trusted.
        if (next)
          setPhase((p) =>
            p === 'idle' || p === 'ready' || p === 'connecting' || p === 'reconnecting' ? p : next,
          );
      }
      // A close that carries an error is a refusal, and it must be readable:
      // the model that cannot speak (17 Sep) closed the session and the screen
      // showed nothing but the orb.
      if (e.kind === 'closed' && e.text) {
        setNotice(callFailureLine(e.text));
      }
      if (e.kind === 'error') {
        setNotice(callFailureLine(e.text ?? ''));
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
    setStage(null);
    // The screen appearing IS the signal to boot. Waiting for the button means
    // the person watches the boot; starting here means they read the screen
    // while it happens.
    warmLiveKit();
  }, []);

  const begin = useCallback(async () => {
    // One call at a time, and this guard is the entire fix for two voices
    // answering one question, so it is worth saying why it has to be here.
    //
    // Nothing stopped `begin` from running twice: a second tap on the call
    // button, a re-render, a retry after a slow start. Every entry asked Rust
    // for a call, and Rust minted a NEW room; a new room dispatches a NEW
    // agent, because the worker carries no name and LiveKit dispatches
    // nameless workers on room creation. Meanwhile `room.current` was
    // overwritten below, so the PREVIOUS room object was lost with its
    // microphone still enabled and nobody left holding a reference to
    // disconnect it. Two rooms, two agents, one person's voice reaching both.
    //
    // Scoped to the generation, not to the hook: an attempt the person already
    // hung up on has no claim on the next press.
    if (starting.current === generation.current || room.current) return;
    const mine = ++generation.current;
    starting.current = mine;
    // Before anything is awaited. This is the whole difference between a
    // button that answers and a button that looks broken for fifteen seconds,
    // and it is not a way of hiding the wait: the stages below say where the
    // wait actually is, and the warm chain is what shortens it.
    callMark('call_requested');
    setNotice(null);
    setPhase('connecting');
    setStage('starting');
    callMark('call_ui_ready');
    try {
      // Read at call time, not captured in a dep: a provider picked while
      // the pre-call screen is open has to apply to THIS call, not the
      // next one.
      const args = callArgs();
      const call = await tauri.raw.startLivekitCall(
        args.provider,
        args.voice,
        args.model,
        args.pipeline,
        args.language,
        // The conversation on screen. What `ask_cinder` does during this call
        // runs in it, so the work is in the place the person will look for it
        // afterwards rather than in a session with a process id for a name.
        useChat.getState().sessionId,
      );
      if (mine !== generation.current) {
        // Hung up while starting. Rust has already minted a room and
        // dispatched an agent for it, so leaving now without saying so would
        // leave that agent alive in a room nobody joins, holding a vendor
        // session open and, on a metered key, billing for silence.
        //
        // Unless somebody else is now using that same chain. A later attempt
        // reuses the chain this one booted, and ending it from here would hang
        // up a call that is connected or about to be, which is how a cancel
        // three minutes ago kills a conversation happening now.
        if (starting.current === null && !room.current) {
          void tauri.raw.endLivekitCall().catch(() => {});
        }
        return;
      }
      setStage('joining');
      callMark('room_join_started');
      const r = new Room();
      room.current = r;
      const isCurrent = () => mine === generation.current && room.current === r;

      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (!isCurrent()) return;
        if (track.kind !== Track.Kind.Audio) return;
        callMark('agent_session_started');
        const el = track.attach();
        el.autoplay = true;
        sinks.current.push(el);
        document.body.appendChild(el);
      });
      r.on(RoomEvent.Disconnected, () => { if (isCurrent()) hangUp(); });
      // The transport retrying is not the same as the call being up, and for
      // as long as it was reported as neither, the screen went on saying it
      // was listening to somebody it could not hear. LiveKit only reports
      // `Disconnected` once it has given up, so without these two the whole
      // retry window is a lie on screen.
      r.on(RoomEvent.Reconnecting, () => { if (isCurrent()) setPhase('reconnecting'); });
      r.on(RoomEvent.Reconnected, () => { if (isCurrent()) setPhase('listening'); });

      await r.connect(call.url, call.token);
      if (mine !== generation.current) {
        void r.disconnect();
        return;
      }
      callMark('room_joined');
      setStage('mic');
      await r.localParticipant.setMicrophoneEnabled(true);
      if (mine !== generation.current) {
        void r.disconnect();
        return;
      }
      callMark('microphone_ready');
      setPhase('listening');
      setStage(null);
      meter.current = startMeter(r, (v) => {
        setLevel(v);
        // Speech, not silence: one loud frame is a door slamming, and the
        // threshold is the same one the transcript line uses to decide it is
        // being spoken over.
        if (v > SPEAKING_LEVEL && turnSettled.current) {
          turnSettled.current = false;
          setHeard('');
        }
        // Loud starts it; only a gap long enough to be a silence ends it.
        // `setYouSpeaking` with the same value is a no-op in React, so this
        // runs every animation frame and re-renders on the two that matter.
        if (v > SPEAKING_LEVEL) {
          quietSince.current = 0;
          setYouSpeaking(true);
        } else if (v < QUIET_LEVEL) {
          const now = Date.now();
          if (quietSince.current === 0) quietSince.current = now;
          else if (now - quietSince.current > QUIET_HOLD_MS) setYouSpeaking(false);
        }
      });
    } catch (e) {
      // A cancelled attempt may reject after the next call has connected.
      if (mine !== generation.current) return;
      const failedRoom = room.current;
      room.current = null;
      void failedRoom?.disconnect();
      cleanup();
      const raw = e instanceof Error ? e.message : String(e);
      setNotice(
        raw === 'livekit-no-node'
          ? 'Voice needs Node.js installed. Install it from nodejs.org and try again.'
          : raw.includes('Permission')
            ? 'The microphone was refused. Allow it for Cinderpaw in your system settings.'
            // Anything else was a raw LiveKit or Rust string thrown at the
            // caller: "signal connection failed" and the like, which reads as
            // the app breaking rather than as something they can act on. A
            // sentence they can act on first, the original kept after it, in
            // brackets, because it is the only thing worth quoting in a bug
            // report and dropping it would cost more than it saves.
            : `The call could not start. Check that you are online, then try again. (${trimNotice(raw)})`,
      );
      // Back to the screen with the button on it, which is the only state a
      // failed call can be retried from.
      setPhase('ready');
      setStage(null);
      room.current = null;
      void tauri.raw.endLivekitCall().catch(() => {});
    } finally {
      // Released on every path, success or failure, and only by the attempt
      // that took it: a stale `begin` finishing after a newer one started must
      // not clear the newer one's guard.
      if (starting.current === mine) starting.current = null;
    }
  }, [hangUp, cleanup]);

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
  return { phase, stage, heard, level, youSpeaking, notice, transcribing: false, open, begin, hangUp, interrupt, say };
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
