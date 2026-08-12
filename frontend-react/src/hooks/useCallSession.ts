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
  BARGE_IN_FRAMES,
  BARGE_IN_RMS,
  SPEECH_RMS,
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

/** The mic level the orb treats as "full". Six times the speech threshold —
 *  normal speech then sits around half, and shouting fills it. */
const LEVEL_CEILING = SPEECH_RMS * 6;

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

/** Read the reply text of the turn that just finished. */
function lastAssistantText(): string {
  const messages = useChat.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].content;
  }
  return '';
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
        // Same batching guard as the direct read: the terminal status can land
        // before the final content patch.
        void Promise.resolve()
          .then(() => new Promise((r) => requestAnimationFrame(() => r(null))))
          .then(() => new Promise((r) => setTimeout(r, 50)))
          .then(() => resolve(lastAssistantText()));
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
  const { beginSpeech, feedSpeech, endSpeech, stop: stopSpeech } = useSpeechPlayer(sessionId);

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

  const takeTyped = () => {
    const text = typedRef.current;
    typedRef.current = null;
    return text;
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
  const watchForBargeIn = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return () => {};
    const frame = new Float32Array(analyser.fftSize);
    let loudFrames = 0;
    const poll = window.setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      const loudness = rms(frame);
      // The orb keeps reacting while speaking, so an interruption that is not
      // quite loud enough is visible instead of mysterious.
      setLevel(Math.min(1, loudness / LEVEL_CEILING));
      loudFrames = loudness >= BARGE_IN_RMS ? loudFrames + 1 : 0;
      if (loudFrames >= BARGE_IN_FRAMES) {
        clearInterval(poll);
        stopSpeech(); // resolves the loop's `await speak`, so the next turn listens
      }
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [stopSpeech]);

  const runTurns = useCallback(
    async (call: number) => {
      while (callRef.current === call) {
        try {
          // Typed while the last turn was still running.
          let text = takeTyped();

          if (!text) {
            setPhase('listening');
            const blob = await listenOnce();
            if (callRef.current !== call) return;
            // Typed while listening — `say` stopped the recorder, so the blob is
            // a half-sentence nobody wants transcribed.
            text = takeTyped();
            if (!text && blob) {
              setPhase('thinking');
              // The blob is persisted because cloud STT uploads the saved file.
              // A call turn shows up in the transcript as its text, not as a
              // voice bubble the way the mic button's does.
              // ponytail: no replayable audio for call turns; add the optimistic
              // voice bubble here if someone wants to re-listen to a call.
              const audioPath = await saveVoiceBlobToDisk(blob);
              text = (await transcribeVoiceBlob(blob, audioPath)).trim();
              // Whisper's subtitle boilerplate is not a turn. Passing it on made the
              // agent answer "don't forget to subscribe" as if it had been asked.
              if (isLikelyHallucination(text)) {
                log('stt', `discarded a known hallucination: ${text}`);
                setNotice(t('call.tooShort'));
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
              feedSpeech(piece.speak);
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
          const pending = replyWhenDone();
          const turn = (async () => {
            log('turn', `sending ${text.length} chars`);
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
            // Only if the pump has still produced nothing by then — a reply that
            // started streaming is already talking and does not need covering.
            filler = window.setTimeout(() => {
              if (spoken || desynced || callRef.current !== call) return;
              log('turn', 'still waiting on the model — saying something');
              feedSpeech(t('call.thinkingAloud'));
            }, FILLER_AFTER_MS);
            if (status !== 'streaming') {
              pending.cancel();
              // One frame plus a tick before reading: the sender may write the
              // final content in a batched flush, and reading in the same
              // microtask as the status change can catch the message still empty.
              await new Promise((r) => requestAnimationFrame(() => r(null)));
              await new Promise((r) => setTimeout(r, 50));
              const settled = lastAssistantText();
              log('turn', `read reply directly: ${settled.length} chars`);
              return settled;
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
          const reply = await Promise.race([turn, watchdog.promise]);
          watchdog.cancel();
          window.clearTimeout(filler);
          if (callRef.current !== call) {
            pending.cancel();
            return;
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

          // Listen for an interruption the whole time it talks.
          const stopWatching = watchForBargeIn();
          try {
            await endSpeech();
          } finally {
            stopWatching();
            setLevel(0);
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
  const interrupt = useCallback(() => stopSpeech(), [stopSpeech]);

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
