import { useCallback, useEffect, useRef } from 'react';
import { tauri } from '../lib/tauri';
import { events } from '../lib/tauri/events';
import { pcm16ToFloat32 } from '../lib/audio';

/**
 * Plays the PCM stream Rust emits on `feral://tts-chunk`, chunk by chunk.
 *
 * The whole design constraint is in one word: *schedule*. Synthesis runs ~3x
 * faster than playback, so chunks arrive faster than they are consumed. Each one
 * becomes its own `AudioBufferSourceNode` started at a running cursor on the
 * AudioContext clock, so the first sound comes out ~90 ms after the first chunk
 * instead of after the last. Collecting chunks into an array and playing the
 * concatenation at the end would be less code and would spend the entire
 * advantage the streaming provider was built for.
 *
 * Distinct from `useAudioPlayer`, which decodes a whole recorded blob for the
 * transcript bubbles. Nothing here decodes: the bytes are already PCM.
 *
 * `stop()` is the barge-in primitive — it silences what is already scheduled AND
 * tells Rust to stop pulling the rest of the utterance from the provider.
 */

/** Jitter buffer. A first chunk scheduled at `currentTime` exactly can start
 *  mid-render-quantum and drop its opening samples; a webview repaint between
 *  two chunks can leave a gap that sounds like a stutter. ~90 ms is inaudible as
 *  latency and covers both. */
const LEAD_SECONDS = 0.09;

export function useSpeechPlayer(sessionId: string) {
  const ctxRef = useRef<AudioContext | null>(null);
  /** ctx.currentTime at which the next chunk should start. */
  const cursorRef = useRef(0);
  /** Odd trailing byte of the previous chunk — see `pcm16ToFloat32`. */
  const carryRef = useRef(new Uint8Array(0));
  const nodesRef = useRef(new Set<AudioBufferSourceNode>());
  /** True once `speak_text` has resolved: no further chunks are coming, so the
   *  last node to end is the end of the utterance. */
  const synthesisDoneRef = useRef(true);
  /** Guards against a late chunk from an utterance the user already barged in
   *  on: incrementing this invalidates everything scheduled before it. */
  const generationRef = useRef(0);
  /** Resolves the pending `speak()` when the audio has actually played out (or
   *  when a barge-in cut it short — a caller waiting on speech must never be
   *  left hanging by an interruption). */
  const playedOutRef = useRef<(() => void) | null>(null);
  /** False between utterances. Stopping the provider cannot unsend the chunks
   *  already in the IPC queue, and scheduling those would play a fragment of the
   *  sentence the user just interrupted. */
  const acceptingRef = useRef(false);
  /** Buffers scheduled in the current utterance, so only the first one logs. */
  const scheduledRef = useRef(0);
  /**
   * Text waiting to be synthesised, and whether a drain loop is already running.
   *
   * A queue rather than concurrent requests: chunks are appended to one audio
   * cursor in arrival order, so two synthesis requests in flight at once would
   * interleave their PCM and produce a sentence spliced through another.
   */
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  /** No more text is coming for this utterance. */
  const feedDoneRef = useRef(true);
  /** PCM bytes emitted across every piece of the current utterance. */
  const totalRef = useRef(0);
  const optsRef = useRef<{ provider?: string; voice?: string }>({});

  const settlePlayback = () => {
    playedOutRef.current?.();
    playedOutRef.current = null;
  };

  const ctx = useCallback(() => {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    return (ctxRef.current ??= new AC());
  }, []);

  const silence = useCallback(() => {
    acceptingRef.current = false;
    scheduledRef.current = 0;
    // Drop anything not yet requested. On a barge-in this is what stops the rest of
    // the reply from being synthesised — and, on a metered engine, paid for.
    queueRef.current = [];
    feedDoneRef.current = true;
    for (const node of nodesRef.current) {
      node.onended = null; // the natural-end handler must not fire on a manual stop
      try { node.stop(); } catch { /* never started, or already finished */ }
    }
    nodesRef.current.clear();
    carryRef.current = new Uint8Array(0);
    cursorRef.current = 0;
    settlePlayback();
  }, []);

  // Attached for the component's whole life, not per utterance: a chunk that
  // arrives between `speak()` being called and a listener being registered is a
  // dropped word, and `listen` is async.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void events.ttsChunkEvent.listen((event) => {
      const { sessionId: id, pcm, sampleRate } = event.payload;
      if (id !== sessionId) return; // another panel's voice
      if (!acceptingRef.current) return; // a straggler from an interrupted utterance

      const generation = generationRef.current;
      const { samples, carry } = pcm16ToFloat32(pcm, carryRef.current);
      carryRef.current = carry;
      if (samples.length === 0) return; // a chunk that was nothing but a split sample

      const audio = ctx();
      if (audio.state === 'suspended') void audio.resume();

      const buffer = audio.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(audio.destination);

      const at = Math.max(cursorRef.current, audio.currentTime + LEAD_SECONDS);
      node.onended = () => {
        nodesRef.current.delete(node);
        // Last buffer of a finished synthesis: the utterance is over.
        if (synthesisDoneRef.current && nodesRef.current.size === 0 && generation === generationRef.current) {
          settlePlayback();
        }
      };
      node.start(at);
      nodesRef.current.add(node);
      cursorRef.current = at + buffer.duration;

      // The last unobserved link in the chain. Rust can prove it produced audio;
      // only this can prove the audio was scheduled on a running clock — and a
      // suspended context or a zero-length buffer looks identical to silence.
      if (++scheduledRef.current === 1) {
        void tauri.raw
          .uiLog(
            'audio',
            `first buffer: ${samples.length} samples @ ${sampleRate}Hz, ` +
              `ctx=${audio.state}, starts in ${(at - audio.currentTime).toFixed(3)}s`,
          )
          .catch(() => {});
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId, ctx]);

  /** One synthesis request at a time, appending to the same audio cursor. */
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (acceptingRef.current) {
        const part = queueRef.current.shift();
        if (part === undefined) break; // nothing queued; more may still arrive
        // Empty strings are normalised away here too, not only at the call site: an
        // empty voice id reaches the vendor as a real (invalid) value and Fish
        // answers 400. Anything that can send "" must not.
        totalRef.current += await tauri.voice.speak(
          sessionId,
          part,
          optsRef.current.provider || undefined,
          optsRef.current.voice || undefined,
        );
      }
    } catch (err) {
      console.error('[speech] synthesis failed', err);
      silence(); // settles the waiter, so nothing awaits a stream that died
    } finally {
      drainingRef.current = false;
      // The utterance is over only when no more text is coming AND the queue ran
      // dry. Checked here rather than by the feeder because this is the one place
      // that knows a request just finished.
      if (feedDoneRef.current && queueRef.current.length === 0) {
        synthesisDoneRef.current = true;
        if (nodesRef.current.size === 0) settlePlayback();
      }
    }
  }, [sessionId, silence]);

  /**
   * Start an utterance that will be fed in pieces. Resets the timeline.
   *
   * This exists because waiting for a whole reply before speaking was, measured
   * across ten real turns, most of the wait: the model took a median of 25 seconds
   * and synthesis did not start until the last token landed. The first sentence
   * usually existed after three. Feeding sentences as they stream turns 25 seconds
   * of silence into about three.
   */
  const beginSpeech = useCallback(
    async (opts?: { provider?: string; voice?: string }) => {
      generationRef.current += 1;
      silence();
      queueRef.current = [];
      totalRef.current = 0;
      feedDoneRef.current = false;
      synthesisDoneRef.current = false;
      optsRef.current = opts ?? {};
      // Resume before the first chunk lands: a context created outside a user
      // gesture starts suspended, and chunks scheduled while suspended play
      // against a clock that is not moving.
      const audio = ctx();
      if (audio.state === 'suspended') await audio.resume();
      // Re-armed as late as possible — after the await, immediately before any
      // request. Arming before it leaves a window in which a straggler from the
      // utterance just interrupted is accepted and scheduled as this one's opening.
      acceptingRef.current = true;
    },
    [ctx, silence],
  );

  /** Add text to the current utterance. Order is preserved; requests never overlap. */
  const feedSpeech = useCallback(
    (text: string) => {
      if (!acceptingRef.current || !text.trim()) return;
      queueRef.current.push(text);
      void drain();
    },
    [drain],
  );

  /**
   * No more text is coming. Resolves with the PCM byte count once every queued
   * piece has been synthesised AND the last buffer has played out.
   *
   * Playback, not synthesis, is the contract a caller needs: a voice loop that
   * reopened the microphone when synthesis ended would start recording over the
   * tail of its own sentence. A barge-in resolves it early, so this cannot be left
   * hanging by an interruption.
   */
  const endSpeech = useCallback(async () => {
    feedDoneRef.current = true;
    const playedOut = new Promise<void>((resolve) => { playedOutRef.current = resolve; });
    // Kick the loop in case the queue is already empty — that is the path where
    // nothing was ever fed, and nobody else would settle the wait.
    void drain();
    await playedOut;
    return totalRef.current;
  }, [drain]);

  /** Barge-in: stop the audio here and stop the synthesis over there. */
  const stop = useCallback(() => {
    generationRef.current += 1;
    silence();
    void tauri.voice.stopSpeaking(sessionId);
  }, [sessionId, silence]);

  useEffect(() => () => {
    silence();
    void ctxRef.current?.close();
    ctxRef.current = null;
  }, [silence]);

  return { beginSpeech, feedSpeech, endSpeech, stop };
}
