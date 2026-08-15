import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useNotifications } from '@/stores/notifications';
import { tauri } from '@/lib/tauri';
import { useSpeechPlayer } from './useSpeechPlayer';
import { saveVoiceBlobToDisk, transcribeVoiceBlob } from './useSendMessage';
import {
  rms,
  isVoiced,
  createBargeInDetector,
  isTtsEcho,
  SPEECH_RMS,
  TRAIL_SILENCE_MS,
  MAX_UTTERANCE_MS,
  utteranceEnded,
  type Verdict,
} from '@/lib/vad';
import {
  forSpeech,
  takeSpeakable,
  isLikelyHallucination,
  FIRST_PIECE_CHARS,
  SPEAK_CHUNK_CHARS,
} from '@/lib/speechText';
import { stopActiveStream } from '@/lib/streamControl';
import { ensureWhisperModel } from '@/lib/voiceModel';
import { t } from '@/lib/i18n';

/**
 * A hands-free conversation with the agent: listen → transcribe → send → speak,
 * then listen again, until the user hangs up.
 *
 * `ready` is a state and not a formality. The microphone does not open until the
 * user presses call in the overlay, because the overlay is where they are told
 * which engines are about to handle their voice and whether those engines run on
 * this machine. Recording first and disclosing afterwards would make the notice
 * decorative.
 *
 * What routes the turn is injected (`send`), so a call works identically in Chat
 * mode and in Agent mode — the same choice `ChatInput` already makes for typed
 * and recorded messages.
 *
 * Barge-in is automatic: the microphone stays open while the reply plays and the
 * loop stops speaking when it hears you. The Interrupt button stays for a room
 * loud enough that the threshold never trips.
 */
export type CallPhase = 'idle' | 'ready' | 'listening' | 'thinking' | 'speaking';

/** How often the mic level is sampled. ~16 Hz: fast enough that the trailing
 *  silence is measured to within a frame, slow enough to be free. */
const POLL_MS = 60;

/**
 * Longest pre-roll kept while waiting for an interruption that may never come.
 *
 * The barge-in recorder runs for the whole agent turn, which can be minutes.
 * Restarting it every few seconds while the user is quiet bounds the blob
 * without ever cutting into an utterance, because the restart only happens on
 * the quiet branch.
 */
const PRE_ROLL_MAX_MS = 5_000;

/** The mic level the orb treats as "full". Six times the speech threshold —
 *  normal speech then sits around half, and shouting fills it. Exported so the
 *  Live engine's orb moves at the same scale as this one's. */
export const LEVEL_CEILING = SPEECH_RMS * 6;

/**
 * How long a turn may go **without any sign of progress** before it is treated as
 * hung.
 *
 * Idle time, not total time. The first version was a flat 60 s deadline and it cut
 * a real turn: asked to search the web for a company, the agent was still working
 * — searching, reading, composing — when the deadline killed it. A fixed deadline
 * cannot tell "working" from "dead", and being wrong in that direction destroys
 * the answer the user was waiting for.
 *
 * Any store change counts as progress: streamed tokens, a phase change, a tool
 * starting or finishing. Deliberately generous about what counts, because a false
 * timeout is expensive and a late one merely delays a message on screen.
 */
const REPLY_IDLE_TIMEOUT_MS = 60_000;

/**
 * Silence after which the call says something rather than nothing.
 *
 * Measured on a real call, the gap between "you stopped talking" and "the first
 * sound comes back" is 18–42 s, and effectively all of it is the model: a turn
 * that calls a tool cannot start its reply until the tool returns. Held quiet,
 * that reads as a broken app, not as thinking — so the fix is the one every
 * production voice agent uses, which is to speak first and answer second.
 *
 * It fires only when nothing has been spoken yet, which makes it self-limiting:
 * if replies ever get fast, the condition stops being true and this stops being
 * heard, with no threshold to re-tune.
 *
 * ponytail: one fixed line. A pool of variants, or wording that knows a tool is
 * running ("let me look that up"), is the upgrade if it starts sounding canned.
 */
const FILLER_AFTER_MS = 2_500;

/**
 * How long the line may stay quiet AFTER something has already been said.
 *
 * The first version fired once, at 2.5 s, and never again — so a turn that took
 * forty seconds said "one moment" and then nothing for the remaining
 * thirty-seven. Worse, its condition was "nothing spoken yet", which stops being
 * true the instant the model says its first sentence: a reply that then stopped
 * to run tools for half a minute had no cover at all, because from the loop's
 * point of view it had already spoken.
 *
 * So the rule is about SILENCE, not about the start of a turn: whenever nothing
 * has gone out for this long and the turn is still running, say something. Longer
 * than the opening gap, because interrupting an answer in progress is worse than
 * a pause in the middle of one.
 */
const FILLER_EVERY_MS = 12_000;

/** How often the silence is checked. Cheap; the timer does nothing until the
 *  gap is exceeded. */
const FILLER_TICK_MS = 1_000;

/**
 * Hard ceiling, so a turn cannot run forever if something unrelated keeps nudging
 * the store and resetting the idle timer. Long enough for real multi-step work.
 */
const REPLY_MAX_MS = 5 * 60_000;

/**
 * Resolves with `TIMED_OUT` after `idleMs` of no store activity, or after
 * `maxMs` no matter what. Cancel it when the turn ends so the timers die with it.
 */
function hangWatchdog(idleMs: number, maxMs: number) {
  let idle: number | undefined;
  let hard: number | undefined;
  let unsub: () => void = () => {};
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    const arm = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = window.setTimeout(() => resolve(TIMED_OUT), idleMs);
    };
    // Any change at all — the point is to detect silence, not to classify events.
    unsub = useChat.subscribe(arm);
    hard = window.setTimeout(() => resolve(TIMED_OUT), maxMs);
    arm();
  });
  return {
    promise,
    cancel: () => {
      if (idle !== undefined) clearTimeout(idle);
      if (hard !== undefined) clearTimeout(hard);
      unsub();
    },
  };
}

/** Sentinel for the timeout branch — a plain string could collide with a reply. */
const TIMED_OUT = Symbol('reply-timeout');
/** The user talked over the turn — abandon it and take their new question. */
const INTERRUPTED = Symbol('barge-in');

/**
 * What to say while nothing is happening, in order.
 *
 * Not one line repeated: a turn can now be covered four or five times, and the
 * same sentence at twelve-second intervals stops sounding like patience and
 * starts sounding like a fault. They also get vaguer as they go — the later ones
 * are honest about the wait rather than promising it is nearly over, because by
 * the fourth one it plainly is not.
 *
 * The last is reused for everything after it. A turn still running past a minute
 * has a different problem, and the watchdog is what handles that.
 */
const FILLER_KEYS = [
  'call.thinkingAloud',
  'call.stillWorking',
  'call.stillWorkingLong',
  'call.almostThere',
] as const;

function fillerLine(index: number): string {
  return t(FILLER_KEYS[Math.min(index, FILLER_KEYS.length - 1)]);
}

/**
 * Send one line of the loop's reasoning to the terminal running the app.
 *
 * `console.log` here goes to the WebView2 console, which is not the terminal and
 * not the dev-server output — so the only part of a call that could not be
 * observed was the part making the decisions. Fire-and-forget: diagnostics must
 * never be able to break a turn.
 */
const log = (scope: string, message: string) => {
  void tauri.raw.uiLog(scope, message).catch(() => {});
};

/** The turn that just finished, or `undefined` before the first one. */
function lastAssistant() {
  const messages = useChat.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
}

/** Read the reply text of the turn that just finished. */
function lastAssistantText(): string {
  return lastAssistant()?.content ?? '';
}

/**
 * How much reasoning the model has produced this turn.
 *
 * The discriminator for a silence with no events in it. A turn that took 64
 * seconds to say its first word either spent them waiting for a first token, or
 * spent them THINKING — and reasoning never reaches `content`, so the speech
 * pump has nothing to say for the whole of it while the stream is perfectly
 * healthy. The two need opposite fixes, and only this number tells them apart.
 */
function lastAssistantThinkingChars(): number {
  return lastAssistant()?.thinking?.length ?? 0;
}

/**
 * Wait for the sender's final content patch to land.
 *
 * A terminal `streamStatus` can arrive before the batched write that carries the
 * last words, so reading in the same microtask catches the message still empty.
 * One frame plus a tick is what clears it.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 50));
  });
}

/**
 * Resolves with the reply when the current turn stops streaming.
 *
 * Watching the store rather than the send call is what makes one loop serve both
 * pipelines: the chat path awaits its own stream, the Feral Agent path returns
 * as soon as the sidecar has the message. `streamStatus` leaving `streaming` is
 * true for both, and it covers a stopped or failed turn too — the loop must keep
 * the line open when a reply fails, not hang waiting for words that never come.
 */
function replyWhenDone(): { text: Promise<string>; cancel: () => void } {
  let unsub: () => void = () => {};
  const text = new Promise<string>((resolve) => {
    unsub = useChat.subscribe((s, prev) => {
      if (prev.streamStatus === 'streaming' && s.streamStatus !== 'streaming') {
        unsub();
        log('turn', `stream ended with status=${s.streamStatus}`);
        void settled().then(() => resolve(lastAssistantText()));
      }
    });
  });
  return { text, cancel: () => unsub() };
}

export function useCallSession(send: (text: string) => Promise<void>) {
  const sessionId = useChat((s) => s.sessionId);
  const [phase, setPhase] = useState<CallPhase>('idle');
  /** The last thing the user said, as transcribed — shown so a wrong
   *  transcription is visible instead of mysterious. */
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  /**
   * Why the last turn produced no speech.
   *
   * A call that answers with silence is indistinguishable from a call that is
   * broken. The reply can be empty for ordinary reasons — no model selected, the
   * stream errored, the agent returned nothing — and every one of those used to
   * end in the loop quietly going back to listening while the user waited for a
   * voice that was never coming.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const { beginSpeech, feedSpeech, endSpeech, stop: stopSpeech, isPlaying } = useSpeechPlayer(sessionId);
  /** Read through a ref so the barge-in poll always asks the live player. */
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // The loop reads these through refs: it is a long-lived async function, and it
  // must see the current send target and the current call, not the ones that
  // existed when it started.
  const sendRef = useRef(send);
  sendRef.current = send;
  /** Bumped by every open/hang-up. The loop exits when it no longer matches. */
  const callRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** Text typed in the call's chat panel, waiting to become the next turn. The
   *  loop stays the only thing that takes turns — two senders racing would put
   *  two questions to the model and speak the answer to one of them. */
  const typedRef = useRef<string | null>(null);
  /**
   * The utterance that interrupted the reply, captured from its first syllable.
   *
   * Same discipline as `typedRef`: the loop stays the only thing that takes
   * turns, so a barge-in hands its audio over here instead of sending it.
   * `whilePlaying` records the phase it was captured in, because only a
   * playback-phase capture can be our own voice coming back.
   */
  const bargedRef = useRef<{ blob: Blob; whilePlaying: boolean } | null>(null);
  /** Everything handed to the player this turn — what an echo would echo.
   *  Bounded: only the recent tail can still be in the air. */
  const lastSpokenRef = useRef('');
  /**
   * Abandons the turn in flight. Set while one is running, a no-op otherwise.
   *
   * There are three ways to interrupt — talking over the reply, pressing
   * Interrupt, typing over it — and all three used to only silence the
   * speaker. The model kept writing behind the silence, so the answer nobody
   * wanted still had to finish before the next question could be asked. One
   * signal, so all three mean the same thing.
   */
  const abandonTurnRef = useRef<() => void>(() => {});

  const takeTyped = () => {
    const text = typedRef.current;
    typedRef.current = null;
    return text;
  };

  const takeBarged = () => {
    const captured = bargedRef.current;
    bargedRef.current = null;
    return captured;
  };

  const releaseMic = useCallback(() => {
    try { recorderRef.current?.stop(); } catch { /* not recording */ }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    setLevel(0);
  }, []);

  /** Record until the VAD says the turn is over. `null` = nothing was said (or
   *  the call ended mid-recording), so there is no turn to take. */
  const listenOnce = useCallback(
    () =>
      new Promise<Blob | null>((resolve) => {
        const stream = streamRef.current;
        const analyser = analyserRef.current;
        if (!stream || !analyser) return resolve(null);

        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        const chunks: Blob[] = [];
        const frame = new Float32Array(analyser.fftSize);
        const startedAt = Date.now();
        let spoke = false;
        let voicedMs = 0;
        let quietSince: number | null = startedAt;
        let verdict: Verdict = 'continue';
        let poll = 0;

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          clearInterval(poll);
          setLevel(0);
          // A hang-up stops the recorder with the verdict still 'continue', so
          // this same path discards a half-recorded turn without a special case.
          resolve(verdict === 'end' ? new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }) : null);
        };

        poll = window.setInterval(() => {
          analyser.getFloatTimeDomainData(frame);
          const loudness = rms(frame);
          setLevel(Math.min(1, loudness / LEVEL_CEILING));
          const now = Date.now();
          // Hysteresis: starting a turn takes a clear voice, continuing one only
          // takes a quiet one. `quietSince === null` is exactly "the previous frame
          // was voiced", so it doubles as the state the rule needs.
          if (isVoiced(loudness, quietSince === null && spoke)) {
            spoke = true;
            voicedMs += POLL_MS;
            quietSince = null;
          } else if (quietSince === null) {
            quietSince = now;
          }
          verdict = utteranceEnded({
            spoke,
            voicedMs,
            silenceMs: quietSince === null ? 0 : now - quietSince,
            elapsedMs: now - startedAt,
          });
          if (verdict !== 'continue') {
            log('vad', `${verdict} voiced=${voicedMs}ms elapsed=${now - startedAt}ms`);
            // Heard something, threw it away for being too short: say so. Silently
            // discarding real speech is the one failure that looks exactly like
            // the microphone not working.
            if (verdict === 'abort' && spoke) setNotice(t('call.tooShort'));
            recorder.stop();
          }
        }, POLL_MS);

        recorder.start();
      }),
    [],
  );

  /**
   * Watch the microphone while the reply plays and cut it off when the user
   * starts talking. Returns the stop function.
   *
   * This is what makes it a conversation rather than an exchange of voicemails:
   * you can interrupt. The microphone is already open — the loop keeps one stream
   * for the whole call — so this costs a timer, not a device.
   */
  const watchForBargeIn = useCallback((onTrip: () => void) => {
    const analyser = analyserRef.current;
    const stream = streamRef.current;
    if (!analyser) return async () => {};
    const frame = new Float32Array(analyser.fftSize);
    const detector = createBargeInDetector();

    // Pre-roll. Detection alone loses the first words: by the time sustained
    // speech is believed and a fresh recorder spins up, "stai, de fapt—" has
    // already become "de fapt—", and the agent answers half a sentence. So a
    // recorder runs from the moment the watch is armed, and when the trigger
    // fires we keep THAT recording — onset included — rather than starting a
    // new one.
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let segmentStartedAt = Date.now();
    const startSegment = () => {
      if (!stream || typeof MediaRecorder === 'undefined') return;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        recorder = null; // no capture available — detection still works
        return;
      }
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(250);
    };
    /** Drop stale pre-roll — only ever called while the user is quiet, since
     *  rotating mid-speech would throw away the onset this exists to keep. */
    const rotateSegment = () => {
      if (!recorder || recorder.state === 'inactive') return;
      recorder.ondataavailable = null;
      try { recorder.stop(); } catch { /* already stopped */ }
      startSegment();
    };
    startSegment();

    let tripped = false;
    let trippedWhilePlaying = false;
    let trippedAt = 0;
    let quietSince: number | null = null;
    let poll = 0;
    let finishing = false;

    /**
     * Resolves once the captured utterance is safely in `bargedRef` — or once
     * we know there will not be one.
     *
     * The turn cannot simply walk away from a trip. Cutting the reply resolves
     * the loop's `await endSpeech()` immediately, so the loop reaches its
     * cleanup while the user is still mid-sentence; tearing the recorder down
     * there would throw away exactly the words this whole mechanism exists to
     * keep. So the caller awaits this instead.
     */
    let settle: () => void = () => {};
    const captured = new Promise<void>((resolve) => { settle = resolve; });

    const finish = () => {
      if (finishing) return captured;
      finishing = true;
      window.clearInterval(poll);
      const active = recorder;
      recorder = null;
      const handOver = () => {
        bargedRef.current = chunks.length
          ? { blob: new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }), whilePlaying: trippedWhilePlaying }
          : null;
        settle();
      };
      if (!active || active.state === 'inactive') {
        handOver();
        return captured;
      }
      active.onstop = handOver;
      try {
        active.stop();
      } catch {
        handOver(); // never leave the turn waiting on a recorder that is gone
      }
      return captured;
    };

    poll = window.setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      const loudness = rms(frame);
      // The orb keeps reacting while speaking, so an interruption that is not
      // quite loud enough is visible instead of mysterious.
      setLevel(Math.min(1, loudness / LEVEL_CEILING));
      const now = Date.now();

      if (!tripped) {
        const playing = isPlayingRef.current();
        if (detector.feed(loudness, playing, now)) {
          tripped = true;
          trippedWhilePlaying = playing;
          trippedAt = now;
          quietSince = null;
          log('vad', `barge-in at rms=${loudness.toFixed(3)} trigger=${detector.trigger().toFixed(3)} playing=${playing}`);
          // Silence the reply immediately; keep recording what is being said.
          stopSpeech();
          // Tell the turn to give up too. Muting an answer the model is still
          // writing is only half an interruption: without this the generation
          // ran to completion behind the silence, and the user's new question
          // queued up behind an answer nobody would ever hear.
          onTrip();
          if (!recorder) { window.clearInterval(poll); settle(); return; }
        } else if (now - segmentStartedAt >= PRE_ROLL_MAX_MS) {
          // Bound the pre-roll so a two-minute turn does not accumulate a
          // two-minute blob. Safe here: this branch is the quiet one.
          rotateSegment();
          segmentStartedAt = now;
        }
        return;
      }

      // Tripped: the reply is already cut, so plain silence detection works.
      if (loudness >= SPEECH_RMS) quietSince = null;
      else quietSince ??= now;
      if ((quietSince && now - quietSince >= TRAIL_SILENCE_MS) || now - trippedAt >= MAX_UTTERANCE_MS) {
        void finish();
      }
    }, POLL_MS);

    /** Stop watching. Awaits the interrupting utterance if one is mid-capture. */
    return () => {
      if (finishing) return captured;
      // Tripped and still recording: let it run to its natural end rather than
      // discarding the sentence the user is in the middle of saying.
      if (tripped && recorder) return finish();
      window.clearInterval(poll);
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try { recorder.stop(); } catch { /* already stopped */ }
      }
      recorder = null;
      settle();
      return captured;
    };
  }, [stopSpeech]);

  const runTurns = useCallback(
    async (call: number) => {
      while (callRef.current === call) {
        /**
         * Where a turn's seconds actually go.
         *
         * The loop logged char counts and statuses and not one duration, so
         * "it feels slow" had no answer — and the numbers on record (STT 0.4s,
         * TTS 2s, model 25s) were measured on a different provider and are not
         * evidence about this one. Four marks, one line at the end of the turn:
         * anything else is guessing which third to optimise.
         */
        let sttStartedAt = 0;
        let sttMs = 0;
        let sentAt = 0;
        let firstSpeechMs = 0;
        /**
         * Armed before the question is sent and released however the turn
         * ends, including the paths that `continue` early (a hung reply, a
         * reply with nothing speakable). Hoisted for exactly that reason: a
         * watcher left running would keep a second recorder on the microphone
         * into the next turn.
         */
        let stopWatching: () => Promise<void> = async () => {};
        try {
          // Typed while the last turn was still running.
          let text = takeTyped();

          // An interruption already recorded what was said, from its first
          // syllable — transcribe THAT rather than opening a new recording,
          // which would start after the fact and lose the words that caused it.
          const barged = text ? null : takeBarged();

          if (!text) {
            let blob: Blob | null;
            if (barged) {
              blob = barged.blob;
            } else {
              setPhase('listening');
              blob = await listenOnce();
            }
            if (callRef.current !== call) return;
            // Typed while listening — `say` stopped the recorder, so the blob is
            // a half-sentence nobody wants transcribed.
            text = takeTyped();
            if (!text && blob) {
              setPhase('thinking');
              sttStartedAt = Date.now();
              // The blob is persisted because cloud STT uploads the saved file.
              // A call turn shows up in the transcript as its text, not as a
              // voice bubble the way the mic button's does.
              // ponytail: no replayable audio for call turns; add the optimistic
              // voice bubble here if someone wants to re-listen to a call.
              const audioPath = await saveVoiceBlobToDisk(blob);
              text = (await transcribeVoiceBlob(blob, audioPath)).trim();
              sttMs = Date.now() - sttStartedAt;
              // Whisper's subtitle boilerplate is not a turn. Passing it on made the
              // agent answer "don't forget to subscribe" as if it had been asked.
              if (isLikelyHallucination(text)) {
                log('stt', `discarded a known hallucination: ${text}`);
                setNotice(t('call.tooShort'));
                text = '';
              }
              // Second line of defence against hearing ourselves. Applied only
              // to a capture taken while audio was playing: speech heard while
              // the model was still generating cannot be our voice, because
              // there was no voice yet. Without this the reply leaks into the
              // microphone, gets transcribed, and comes back as the user's next
              // turn — the agent answering itself, forever.
              if (text && barged?.whilePlaying && isTtsEcho(text, lastSpokenRef.current)) {
                log('stt', `discarded our own voice coming back: ${text}`);
                text = '';
              }
            }
          }
          if (callRef.current !== call) return;
          if (!text) continue; // silence — keep the line open rather than hang up

          setPhase('thinking');
          setHeard(text);
          setNotice(null);

          // Speak the reply AS IT ARRIVES.
          //
          // Measured across ten real turns, the model took a median of 25 seconds
          // and synthesis did not start until its last token — so the user sat in
          // silence for the whole generation even though the first sentence existed
          // after about three. Feeding finished sentences to the player as they
          // stream turns that 25 seconds of nothing into roughly three.
          //
          // The cost is one prosody seam per piece, since each is its own synthesis
          // request. That trade is not close: a seam at a full stop sounds like a
          // breath, and twenty-five seconds of silence sounds broken.
          const engineNow = useUI.getState().ttsProvider ?? undefined;
          const voiceNow = (engineNow ? useUI.getState().ttsVoice[engineNow] : undefined) || undefined;
          await beginSpeech({ provider: engineNow, voice: voiceNow });

          // Every route to the player goes through here, so the echo guard sees
          // the filler lines too — those are our voice as much as the answer is,
          // and a leaked "one moment" coming back as a question is the same bug.
          lastSpokenRef.current = '';
          const speakPiece = (piece: string) => {
            lastSpokenRef.current = `${lastSpokenRef.current} ${piece}`.slice(-2000);
            feedSpeech(piece);
          };

          /**
           * Everything handed to the player so far, as text.
           *
           * Tracked by CONTENT, not by a character offset, and that is not a
           * refinement — an offset is wrong here twice over. Before the send lands,
           * the last assistant message is still the PREVIOUS turn's reply, so an
           * offset of zero reads it as new and speaks the last answer again (it did:
           * the same 135 characters synthesised twice, four seconds apart). And
           * mid-turn `useFeral` clears the streamed content when a tool call starts,
           * so the text can SHRINK — after which any saved offset points into the
           * middle of different words.
           */
          let spoken = '';
          /** Set when the store's text stops being an extension of what we spoke. */
          let desynced = false;
          /** Reset the silence clock. Assigned once the filler timer exists; a
           *  no-op before that, because the pump can feed before it is armed. */
          let onSpoke: () => void = () => {};
          const pump = (finished: boolean) => {
            if (desynced) return;
            const full = forSpeech(lastAssistantText());
            if (!full.startsWith(spoken)) {
              // Rewritten or cleared under us. We cannot know what the listener
              // already heard, so stop streaming rather than risk repeating a
              // sentence — the final flush below is skipped too, for the same reason.
              desynced = true;
              log('turn', 'reply text was rewritten mid-stream — stopped streaming speech');
              return;
            }
            let carry = full.slice(spoken.length);
            for (;;) {
              // The first sentence leaves as soon as it exists; later pieces batch.
              const piece = takeSpeakable(
                carry,
                finished,
                spoken ? SPEAK_CHUNK_CHARS : FIRST_PIECE_CHARS,
              );
              if (!piece) break;
              // The number that decides whether a call feels alive: how long
              // between the question landing and the first word going out. The
              // rest of the reply streams behind it and is not felt.
              if (!firstSpeechMs && sentAt) firstSpeechMs = Date.now() - sentAt;
              speakPiece(piece.speak);
              onSpoke();
              // `spoken` grows by exactly what was fed, including the whitespace
              // `takeSpeakable` trimmed, so the prefix check keeps matching.
              spoken = full.slice(0, full.length - piece.rest.length);
              carry = piece.rest;
              if (!piece.rest) break;
            }
          };

          let unpump: () => void = () => {};
          /** Cleared the moment the turn resolves, however it resolves. */
          let filler: number | undefined;
          const clearFiller = () => { if (filler !== undefined) window.clearInterval(filler); };
          const pending = replyWhenDone();

          // Listen for an interruption across the WHOLE agent turn, not just
          // the tail of it.
          //
          // This used to be armed after the reply text had fully arrived, which
          // put it in the wrong place twice. The player starts speaking from the
          // first finished sentence — inside the race below — so most of the
          // talking was already unguarded. And before that comes the generation
          // wait, measured on this machine at five to twenty seconds, which is
          // precisely when someone realises they asked the wrong thing. Barge-in
          // was unavailable for the longest, most annoying part of every turn.
          //
          // The detector knows which phase it is in (`isPlaying`) and raises its
          // own trigger once our voice is in the room, so arming it this early
          // costs nothing in false interruptions.
          let signalInterrupt: () => void = () => {};
          const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
            signalInterrupt = () => resolve(INTERRUPTED);
          });
          stopWatching = watchForBargeIn(signalInterrupt);
          abandonTurnRef.current = signalInterrupt;

          const turn = (async () => {
            log('turn', `sending ${text.length} chars`);
            sentAt = Date.now();
            await sendRef.current(text);
            const status = useChat.getState().streamStatus;
            log('turn', `send returned, streamStatus=${status}`);
            // Subscribe only now: `send` has replaced the last assistant message
            // with this turn's (empty) one, so the pump can no longer read the
            // previous reply as if it were new text. Subscribing before the send is
            // exactly what spoke the last answer a second time.
            setPhase('speaking');
            spoken = '';
            unpump = useChat.subscribe(() => pump(false));
            pump(false);
            // Keep the line warm for as long as the turn runs, not once at the
            // start. Measured turns: 25 s before the first word with nothing to
            // hear after "one moment", and answers that begin, then stop for
            // half a minute while tools run.
            let lastOut = Date.now();
            let saidFillers = 0;
            filler = window.setInterval(() => {
              // Deliberately NOT stopped by `desynced`. A desync means the reply
              // can no longer be streamed safely — the store's text stopped being
              // an extension of what was said, which happens whenever a tool call
              // clears it mid-answer — and from that point the turn speaks
              // NOTHING, not even the final flush. Measured: seventy seconds of
              // total silence on a call that was working the whole time. When the
              // answer cannot be spoken, this is the only voice left, and it is
              // the one moment it matters most.
              if (callRef.current !== call) return;
              const quietFor = Date.now() - lastOut;
              // Short for the FIRST line only. Keying this on `spoken` instead
              // was wrong in a way that only sounds wrong: "nothing said yet"
              // stays true for the whole pre-answer wait, so the short gap
              // re-applied every time and the call produced five reassurances in
              // twelve seconds. Silence right after a question is the alarming
              // kind and deserves a fast answer; everything after it is spacing.
              const allowed = saidFillers === 0 ? FILLER_AFTER_MS : FILLER_EVERY_MS;
              if (quietFor < allowed) return;
              lastOut = Date.now();
              const line = fillerLine(saidFillers++);
              log('turn', `quiet for ${quietFor}ms — saying "${line}"`);
              speakPiece(line);
            }, FILLER_TICK_MS);
            // Anything the pump sends counts as the line being warm, so a reply
            // that is streaming normally never triggers this at all.
            onSpoke = () => { lastOut = Date.now(); };
            if (status !== 'streaming') {
              pending.cancel();
              await settled();
              const direct = lastAssistantText();
              log('turn', `read reply directly: ${direct.length} chars`);
              return direct;
            }
            const waited = await pending.text;
            log('turn', `reply after stream ended: ${waited.length} chars`);
            return waited;
          })();

          // A call cannot wait forever. Nothing downstream guarantees an answer —
          // a sidecar that never replies, a provider that hangs, a stream that ends
          // without a terminal status — and without this the loop sat in "thinking"
          // until the user gave up, with no way back to listening and nothing on
          // screen explaining the wait. But the watchdog watches for SILENCE, not
          // for elapsed time: a turn that is searching the web is working, and a
          // deadline that cannot tell the difference kills the answer.
          const watchdog = hangWatchdog(REPLY_IDLE_TIMEOUT_MS, REPLY_MAX_MS);
          const reply = await Promise.race([turn, watchdog.promise, interrupted]);
          watchdog.cancel();
          clearFiller();
          if (callRef.current !== call) {
            pending.cancel();
            return;
          }

          if (reply === INTERRUPTED) {
            pending.cancel();
            unpump();
            // Same reasoning as the timeout path: stop the generation rather
            // than abandoning it locally. A stream left running in the backend
            // gets cancelled by the NEXT turn's send, and that `stopped` status
            // lands on the new turn — so walking away from an interrupted reply
            // would poison the reply the user actually wanted.
            log('turn', 'user interrupted — stopping the stream');
            await stopActiveStream(useChat.getState().sessionId).catch(() => {});
            // The outer `finally` awaits the capture, so the interrupting words
            // are already waiting in `bargedRef` when the next turn starts.
            continue;
          }
          if (reply === TIMED_OUT) {
            pending.cancel();
            // Stop the generation, do not just walk away from it. Abandoning it
            // locally left a stream still running in the backend: the NEXT turn's
            // send cancelled that zombie, and the resulting `stopped` status
            // landed on the new turn — so a hung reply silently poisoned the
            // reply after it, which is how one stuck turn broke every following
            // one until the call was restarted.
            log('turn', `no progress for ${REPLY_IDLE_TIMEOUT_MS}ms — stopping the stream`);
            await stopActiveStream(useChat.getState().sessionId).catch(() => {});
            setNotice(t('call.replyTimeout'));
            continue; // back to listening — the line stays open
          }

          unpump();
          const words = forSpeech(reply);
          log('turn', `reply=${reply.length} chars, speakable=${words.length} chars`);
          if (!words) {
            // The turn went through and came back with nothing to say. Naming the
            // reason on screen is the difference between "it is broken" and "no
            // model is selected" — and only the store knows which.
            const { streamStatus, streamError } = useChat.getState();
            // The agent's own error text. It reaches the webview but not the
            // terminal — the sidecar's failures travel as protocol events, not as
            // stdout — so this is the only place the reason is readable at all.
            log('turn', `no speech: status=${streamStatus} error=${streamError ?? 'none'}`);
            setNotice(
              streamStatus === 'error'
                ? // Show the real message, truncated. A generic "it failed" sends
                  // the user hunting through a chat panel for text we already have.
                  streamError?.slice(0, 160) ?? t('call.replyFailed')
                : // `stopped` is not "nothing came back": something cancelled the
                  // generation — usually a turn that was still running when this
                  // one started. Saying "is a model selected?" there sends the
                  // user to check something that was never the problem.
                  streamStatus === 'stopped'
                  ? t('call.replyStopped')
                  : t('call.noReply'),
            );
            continue;
          }
          // Everything the streaming pump has not already handed over — usually the
          // tail after the last full stop, or the whole reply when it arrived in one
          // piece (a reply short enough to finish between two store updates).
          //
          // Skipped when the pump desynced: there we do not know what was already
          // heard, and repeating a sentence is worse than ending a little early.
          if (!desynced) pump(true);
          log('turn', `spoken=${spoken.length} of ${words.length} chars, voice=${voiceNow ?? '<vendor default>'}`);

          try {
            await endSpeech();
          } finally {
            setLevel(0);
            // One line, four numbers, at the only moment all of them are known.
            // `answer` is the whole reply arriving; `firstWord` is what the user
            // actually experiences as the wait, and the gap between the two is
            // how much the streaming pump is already hiding.
            log(
              'timing',
              `stt=${sttMs}ms firstWord=${firstSpeechMs || -1}ms ` +
                `answer=${sentAt ? Date.now() - sentAt : -1}ms turn=${sttStartedAt ? Date.now() - sttStartedAt : -1}ms ` +
                // Thinking against firstWord is the whole diagnosis: a large
                // number here means the wait was reasoning the pump could not
                // speak, not a slow provider.
                `think=${lastAssistantThinkingChars()}chars`,
            );
          }
        } catch (err) {
          console.error('[call] turn failed', err);
          const code = err instanceof Error ? err.message : String(err);
          // Transcription failures are per-turn: say so and listen again. A
          // dropped word should not drop the call.
          if (code === 'model-missing') {
            // Say it is downloading AND actually start the download. Without the
            // second half this branch was a dead end: every turn reported the
            // same message and nothing ever fetched the model.
            void ensureWhisperModel(useUI.getState().whisperModel);
            useNotifications.getState().push('info', t('voice.modelDownloading'));
          }
          else if (code === 'voice-unavailable') useNotifications.getState().push('error', t('voice.unsupported'));
          else if (code === 'stt-cloud-failed') useNotifications.getState().push('error', t('voice.cloudFailed'));
          else useNotifications.getState().push('error', t('call.turnFailed'));
          // On the call screen too, not only as a toast: the overlay is where the
          // user is looking, and a toast can be missed entirely.
          setNotice(code === 'stt-no-key' ? t('voice.provider.title') : t('call.turnFailed'));
        } finally {
          // Whatever happened — answered, timed out, interrupted, threw, hung
          // up — the watcher stops here, and every early `continue` above
          // passes through it. Awaited, because when the user is mid-sentence
          // this is what waits for their words to finish landing.
          abandonTurnRef.current = () => {};
          await stopWatching();
        }
      }
    },
    [listenOnce, beginSpeech, feedSpeech, endSpeech, watchForBargeIn],
  );

  /** Open the overlay. No microphone yet — see `ready` above. */
  const open = useCallback(() => {
    callRef.current += 1;
    setHeard('');
    setNotice(null);
    setPhase('ready');
  }, []);

  /** Accept the call: take the microphone and start the loop. */
  const begin = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      useNotifications.getState().push('error', t('voice.unsupported'));
      setPhase('idle');
      return;
    }
    try {
      // Echo cancellation is not cosmetic here: the loop reopens the mic right
      // after Cubby stops speaking, and it is what stops a call from hearing
      // itself through the speakers. It is also the groundwork for barge-in.
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      useNotifications.getState().push('error', t('voice.permissionDenied'));
      setPhase('idle');
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audio = new AC();
    ctxRef.current = audio;
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(streamRef.current).connect(analyser);
    analyserRef.current = analyser;

    // Start fetching the local STT model now rather than discovering it is
    // missing after the first sentence someone speaks. Idempotent and
    // fire-and-forget: a present model is a no-op, and an absent one downloads
    // while the call is already listening.
    if (useUI.getState().sttProvider === 'local') {
      void ensureWhisperModel(useUI.getState().whisperModel);
    }

    const call = (callRef.current += 1);
    void runTurns(call);
  }, [runTurns]);

  const hangUp = useCallback(() => {
    callRef.current += 1;
    stopSpeech();
    releaseMic();
    setPhase('idle');
  }, [stopSpeech, releaseMic]);

  /** Barge-in: cut the reply short. The loop's `speak` resolves, so the next
   *  turn starts listening immediately. */
  const interrupt = useCallback(() => {
    stopSpeech();
    // Not just the speaker: give up the answer being written, too. Otherwise
    // Interrupt looks like it worked and the call stays busy behind it.
    abandonTurnRef.current();
  }, [stopSpeech]);

  /**
   * Take the next turn with typed text instead of the microphone — the call's
   * chat panel, for a URL or a name that dictation would mangle.
   *
   * It hands the text to the loop rather than sending it directly: sending here
   * would run a second turn alongside the one already in flight, and the reply
   * spoken aloud would be the answer to whichever finished first. Stopping the
   * recorder is what wakes the loop up to collect it.
   */
  const say = useCallback((text: string) => {
    if (!text.trim()) return;
    typedRef.current = text.trim();
    stopSpeech(); // typing over a reply is a barge-in like any other
    abandonTurnRef.current(); // …including giving up the answer in flight
    try { recorderRef.current?.stop(); } catch { /* not listening right now */ }
  }, [stopSpeech]);

  // A call must not outlive the component — an open microphone that nothing is
  // reading is the worst possible leak to ship.
  useEffect(() => () => {
    callRef.current += 1;
    releaseMic();
  }, [releaseMic]);

  return { phase, heard, level, notice, open, begin, hangUp, interrupt, say };
}
