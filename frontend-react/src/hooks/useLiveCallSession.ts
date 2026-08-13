import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { tauri } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { captureMicPcm } from '@/lib/micPcm';
import { useSpeechPlayer } from './useSpeechPlayer';
import { LEVEL_CEILING, type CallPhase } from './useCallSession';
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
 * What that costs, and it is worth naming: there is no transcript in the chat
 * store, so the call's turns are not saved and the chat panel has nothing to
 * show. Both sides of the conversation ARE transcribed by the model and arrive
 * here, so writing them into the session is the obvious next step — it needs an
 * inbound sidecar message that records a turn without generating a reply.
 */

/** How long a `heard` line lingers after the model finishes answering, so a
 *  question does not vanish from the screen the instant it is answered. */
const HEARD_LINGER_MS = 1_500;

export function useLiveCallSession() {
  const sessionId = useChat((s) => s.sessionId);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const { beginSpeech, stop: stopSpeech } = useSpeechPlayer(sessionId);

  /** Bumped by every open/hang-up; an async step that finds it changed gives up. */
  const callRef = useRef(0);
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
            setHeard((prev) => (freshRef.current ? text : prev + text));
            freshRef.current = false;
            break;
          case 'outputTranscript':
            // Audio and its transcript arrive together, so this is also the only
            // signal that the reply has started coming back.
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
          case 'turnComplete':
            setPhase('listening');
            freshRef.current = true;
            window.setTimeout(() => {
              if (freshRef.current) setHeard('');
            }, HEARD_LINGER_MS);
            break;
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
      await tauri.raw.startLiveCall(sessionId);
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
      stopMicRef.current = await captureMicPcm((pcm, loudness) => {
        if (callRef.current !== call) return;
        setLevel(Math.min(1, loudness / LEVEL_CEILING));
        // Fire and forget. A dropped frame is a syllable; awaiting each one would
        // make the audio path as slow as the slowest IPC round trip.
        void tauri.raw.sendLiveAudio(pcm).catch(() => {});
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

  // `say` is deliberately absent: the Live session takes audio, tool answers and
  // nothing else, so there is no channel a typed line could travel on. The
  // overlay hides its chat panel when nothing is passed.
  return { phase, heard, level, notice, open, begin, hangUp, interrupt };
}
