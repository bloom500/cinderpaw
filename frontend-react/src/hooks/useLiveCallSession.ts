import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { tauri } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { captureMicPcm, pcm16Base64 } from '@/lib/micPcm';
import { TARGET_RATE } from '@/lib/audio';
import { forSpeech } from '@/lib/speechText';
import { useSpeechPlayer } from './useSpeechPlayer';
import { LEVEL_CEILING, type CallPhase } from './useCallSession';

/**
 * Hard ceiling on un-sent microphone audio, in samples — four seconds at 16 kHz.
 * Only reachable if the bridge stalls outright; past it, the oldest audio is
 * dropped rather than delivered late, because late audio is what makes the
 * model answer half a sentence and then answer it again.
 */
const MIC_BACKLOG_SAMPLES = TARGET_RATE * 4;
import { t } from '@/lib/i18n';

/**
 * A call where the model hears you directly — Gemini Live, speech to speech.
 *
 * Deliberately a **separate hook** from `useCallSession` rather than a branch
 * inside it. That loop is a turn-taker: record, detect the end of the utterance,
 * transcribe, send, wait for a reply, synthesise it, listen again. Here every one
 * of those steps happens on the far end of one socket, so the whole local job is
 * two streams pointed at each other. The shapes only look alike from the
 * overlay's side, which is why the return type matches and nothing else does.
 *
 * Both sides of the conversation are transcribed by the model, and each finished
 * turn is written into the chat store — so the call leaves scrollback a person
 * can read, the same way Rust files it with the agent's memory.
 */

/** How long a `heard` line lingers after the model finishes answering, so a
 *  question does not vanish from the screen the instant it is answered. */
const HEARD_LINGER_MS = 1_500;

/**
 * The key the Live engine's chosen voice is stored under.
 *
 * The same per-engine map every TTS engine uses (`ttsVoice[engineId]`), because
 * a voice id is only meaningful to the vendor that issued it — Gemini's `Kore`
 * must not carry over to Fish.
 */
export const LIVE_ENGINE_ID = 'gemini-live';

/** How many recent turns travel into the briefing, and how much of each. Enough
 *  to pick up a conversation mid-thought; short enough that the setup message
 *  stays a briefing rather than a transcript. */
const BRIEF_TURNS = 6;
const BRIEF_CHARS = 400;

/**
 * What the model is told before it says a word.
 *
 * This was the whole of "it doesn't know it's in Feral and has no memory": the
 * call opened with nothing but the speech rules, because nobody filled these in.
 * The fields have existed since the engine was written and the one caller passed
 * none of them.
 *
 * The session is stateful, so this is said once and never re-sent — which makes
 * it cheap to be generous here, and expensive to be wrong.
 *
 * Everything is best-effort: a briefing that fails must not stop a call. An
 * absent field is left out entirely rather than sent empty, because "the user
 * was working on: nothing" is worse than silence.
 */
async function briefing() {
  const last = await tauri.raw.getLastTask().catch(() => null);

  // The conversation already on screen, so a call started mid-chat continues the
  // thought instead of opening cold. `forSpeech` strips the markdown the model
  // would otherwise read out loud if it quoted any of it back.
  const recent = useChat
    .getState()
    .messages.slice(-BRIEF_TURNS)
    .map((m) => `${m.role === 'user' ? 'They' : 'You'}: ${forSpeech(m.content).slice(0, BRIEF_CHARS)}`)
    .filter((line) => line.length > 6)
    .join('\n');

  return {
    // Pinned per session, from the same per-engine store the pipeline voices
    // use. Unset on a first call, and Rust then pins its own default rather
    // than letting the server choose one per session.
    voice: useUI.getState().ttsVoice[LIVE_ENGINE_ID],
    currentTask: last?.task?.title ?? undefined,
    workspace: last?.workspace_name ?? undefined,
    context: recent
      ? `Here is the end of the conversation you were having with them in text, just before this call:\n${recent}`
      : undefined,
  };
}

export function useLiveCallSession() {
  const sessionId = useChat((s) => s.sessionId);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const { beginSpeech, stop: stopSpeech } = useSpeechPlayer(sessionId);

  /** Bumped by every open/hang-up; an async step that finds it changed gives up. */
  const callRef = useRef(0);

  /**
   * Microphone frames waiting for the bridge, and whether one send is already
   * out there.
   *
   * The bug this exists for: the mic produces a frame every 128 ms and each one
   * was fired at the Tauri IPC without waiting. Fire-and-forget has no
   * backpressure, so whenever a round trip took longer than 128 ms — and it
   * does, because the model's own 24 kHz reply audio is crossing the same
   * bridge in the other direction — the calls stacked up. The backlog grew for
   * as long as the user kept talking, and a long sentence reached the model
   * half a minute after it was spoken: the model answered the first half, then
   * the rest of the sentence arrived mid-answer and it answered again.
   *
   * One send in flight at a time, everything that arrives meanwhile merged into
   * the next one. The queue is then self-limiting — it holds exactly as much as
   * the bridge is behind — and the payload count drops from eight a second to
   * however many the transport can actually take.
   */
  const micQueue = useRef<Float32Array[]>([]);
  const micBusy = useRef(false);

  /** The turn being spoken, accumulated in refs rather than state: the pieces
   *  arrive many times a second and only the completed pair is ever read. */
  const heardRef = useRef('');
  const saidRef = useRef('');

  const pumpMic = useCallback(async () => {
    if (micBusy.current || micQueue.current.length === 0) return;
    micBusy.current = true;
    const frames = micQueue.current;
    micQueue.current = [];
    let total = 0;
    for (const f of frames) total += f.length;
    const merged = new Float32Array(total);
    let at = 0;
    for (const f of frames) {
      merged.set(f, at);
      at += f.length;
    }
    try {
      await tauri.raw.sendLiveAudio(pcm16Base64(merged));
    } catch {
      // A dropped frame is a syllable; a thrown one must not stop the pump.
    }
    micBusy.current = false;
    // Anything that arrived while that was in flight goes out now.
    void pumpMic();
  }, []);
  const stopMicRef = useRef<(() => void) | null>(null);
  /** The next input transcript starts a new question rather than continuing the
   *  last one. Set when the model finishes a turn. */
  const freshRef = useRef(true);

  const closeMic = useCallback(() => {
    stopMicRef.current?.();
    stopMicRef.current = null;
    setLevel(0);
  }, []);

  // Attached for the hook's whole life, not per call: `listen` is async, and a
  // status that lands between starting the call and registering the listener
  // would be lost — including `closed`, which is the one that must never be.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void events.liveStatusEvent
      .listen((event) => {
        const { sessionId: id, kind, text } = event.payload;
        if (id !== sessionId) return;
        switch (kind) {
          case 'inputTranscript':
            // The model's transcription of what it heard, arriving in pieces.
            heardRef.current = freshRef.current ? text : heardRef.current + text;
            setHeard(heardRef.current);
            freshRef.current = false;
            break;
          case 'outputTranscript':
            // Audio and its transcript arrive together, so this is also the only
            // signal that the reply has started coming back.
            saidRef.current += text;
            setPhase('speaking');
            break;
          case 'interrupted':
            // The model stopped because it heard the user over its own reply.
            // Everything already scheduled has to go — it is a sentence that is
            // no longer being said — and the player must be re-armed, because
            // `stop` disarms it to keep stragglers out.
            stopSpeech();
            void beginSpeech();
            setPhase('listening');
            break;
          case 'turnComplete': {
            // File the spoken exchange in the conversation.
            //
            // Rust already hands the same pair to the sidecar's `record_turn`,
            // so the agent REMEMBERS a call — `recall` finds it, the next call
            // opens informed. What was missing is the half a person can see:
            // the chat panel stayed empty through a ten-minute conversation, so
            // there was no scrollback, nothing to copy, and no way to check
            // what it heard. Two records of one exchange, for two different
            // readers.
            const said = saidRef.current.trim();
            const asked = heardRef.current.trim();
            const now = Date.now();
            if (asked) {
              useChat.getState().addMessage({
                id: `live-u-${now}`, role: 'user', content: asked, createdAt: now,
              });
            }
            if (said) {
              useChat.getState().addMessage({
                id: `live-a-${now}`, role: 'assistant', content: said, createdAt: now + 1,
              });
            }
            saidRef.current = '';
            heardRef.current = '';

            setPhase('listening');
            freshRef.current = true;
            window.setTimeout(() => {
              if (freshRef.current) setHeard('');
            }, HEARD_LINGER_MS);
            break;
          }
          case 'closed':
            // The socket went away. Back to the pre-call screen with the reason
            // on it rather than to a live screen with a dead microphone.
            closeMic();
            stopSpeech();
            setPhase('ready');
            setNotice(text ? text.slice(0, 160) : t('call.liveClosed'));
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId, beginSpeech, stopSpeech, closeMic]);

  /** Open the overlay. No microphone and no socket yet — the pre-call screen is
   *  where the user is told the call leaves the device. */
  const open = useCallback(() => {
    callRef.current += 1;
    setHeard('');
    setNotice(null);
    setPhase('ready');
  }, []);

  /** Accept: connect first, then open the microphone. In that order, because
   *  `start_live_call` resolves only once the model has accepted the session —
   *  taking the microphone before it would record into a socket that may never
   *  open. */
  const begin = useCallback(async () => {
    const call = (callRef.current += 1);
    setNotice(null);
    setHeard('');
    freshRef.current = true;
    setPhase('thinking'); // connecting; the orb's fastest tempo is the honest one

    try {
      await tauri.raw.startLiveCall(sessionId, await briefing());
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setNotice(code === 'live-no-key' ? t('call.liveNoKey') : code.slice(0, 160));
      setPhase('ready');
      return;
    }
    if (callRef.current !== call) {
      void tauri.raw.endLiveCall().catch(() => {});
      return;
    }

    // Armed once for the whole call rather than per utterance: audio streams
    // continuously and there is no synthesis request to bracket. Re-armed only
    // after an interruption, which is the one thing that disarms it.
    await beginSpeech();

    try {
      stopMicRef.current = await captureMicPcm((frame, loudness) => {
        if (callRef.current !== call) return;
        setLevel(Math.min(1, loudness / LEVEL_CEILING));
        micQueue.current.push(frame);
        // Bound the backlog. Coalescing keeps it at one or two frames in normal
        // conditions; this only matters if the bridge stalls for seconds, and
        // then old audio is worth less than catching up — a sentence that
        // arrives thirty seconds late is answered after the model has already
        // replied to half of it, which is exactly the failure being fixed.
        let queued = 0;
        for (const f of micQueue.current) queued += f.length;
        while (queued > MIC_BACKLOG_SAMPLES && micQueue.current.length > 1) {
          queued -= micQueue.current.shift()!.length;
        }
        void pumpMic();
      });
    } catch {
      void tauri.raw.endLiveCall().catch(() => {});
      setNotice(t('voice.permissionDenied'));
      setPhase('ready');
      return;
    }
    if (callRef.current !== call) {
      closeMic();
      void tauri.raw.endLiveCall().catch(() => {});
      return;
    }
    setPhase('listening');
  }, [sessionId, beginSpeech, closeMic]);

  const hangUp = useCallback(() => {
    callRef.current += 1;
    closeMic();
    stopSpeech();
    void tauri.raw.endLiveCall().catch(() => {});
    setPhase('idle');
  }, [closeMic, stopSpeech]);

  /**
   * Silence the reply here. It does not tell the model to stop — barge-in is its
   * job in this engine and it already hears the interruption on the microphone
   * that never closed. This is the button for a room too loud for that to fire.
   */
  const interrupt = useCallback(() => stopSpeech(), [stopSpeech]);

  // An open microphone that nothing is reading is the worst leak to ship, and
  // here it would also leave a socket streaming into a dead handler.
  useEffect(() => () => {
    callRef.current += 1;
    stopMicRef.current?.();
    stopMicRef.current = null;
    void tauri.raw.endLiveCall().catch(() => {});
  }, []);

  /**
   * Type instead of speaking, mid-call.
   *
   * It goes on the session's OWN text channel (`clientContent`), not through the
   * agent: the model is conducting this conversation, so a line routed around it
   * would be answered twice, once by each side. It also stops the playback here
   * — typing over a reply is a barge-in like any other — and the model hears the
   * interruption on the microphone that never closed.
   */
  const say = useCallback((text: string) => {
    if (!text.trim()) return;
    stopSpeech();
    void beginSpeech();
    void tauri.raw.sendLiveText(text.trim()).catch(() => {});
    // Shown immediately: the server transcribes speech back to us, but a typed
    // line never passes through that, so nothing else would put it on screen.
    heardRef.current = text.trim();
    setHeard(heardRef.current);
    freshRef.current = false;
    setPhase('thinking');
  }, [beginSpeech, stopSpeech]);

  return { phase, heard, level, notice, open, begin, hangUp, interrupt, say };
}
