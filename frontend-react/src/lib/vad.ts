/**
 * When a spoken turn is over — the one decision a hands-free call cannot get
 * wrong.
 *
 * Cut too early and you interrupt someone mid-sentence; cut too late and every
 * exchange carries a dead second. Both are the same bug from the user's side:
 * the thing is not listening properly.
 *
 * The policy lives here as a pure function, separate from the microphone, so it
 * can be tested without hardware and tuned without touching the audio graph.
 */

/** Root-mean-square of a time-domain frame — loudness, cheaply. */
export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * Above this RMS counts as speech.
 *
 * A calibration knob, not a constant of nature: it depends on the microphone,
 * the gain the OS applies, and the room. 0.02 is roughly "quiet room, laptop
 * mic, speaking normally" — measured, not derived, and worth re-measuring on
 * hardware that behaves differently rather than assumed to be right.
 */
export const SPEECH_RMS = 0.02;

/**
 * Once someone IS speaking, this quieter level still counts as speech.
 *
 * Borrowed from how Silero-based turn detectors are wired, and it costs nothing:
 * a single threshold that both starts and sustains a turn chops the sentence
 * wherever the voice dips — trailing syllables, unstressed vowels, the end of a
 * question — and each dip long enough to pass `TRAIL_SILENCE_MS` ends the turn
 * mid-thought. Two thresholds make starting deliberate and continuing forgiving.
 *
 * 60% of the start level: far enough below to ride out a dip, far enough above
 * room noise not to keep a turn open forever.
 */
export const CONTINUE_RMS = SPEECH_RMS * 0.6;

/**
 * Is this frame speech, given whether the previous one was?
 *
 * The whole hysteresis rule in one place so the caller cannot apply half of it.
 */
export function isVoiced(loudness: number, wasVoiced: boolean): boolean {
  return loudness >= (wasVoiced ? CONTINUE_RMS : SPEECH_RMS);
}

/**
 * Loudness that counts as "the user started talking over the reply".
 *
 * Deliberately higher than `SPEECH_RMS`. The microphone is open while the reply
 * plays, and `echoCancellation` suppresses the speakers rather than eliminating
 * them — at the plain speech threshold the agent hears its own voice and
 * interrupts itself, which looks exactly like a broken feature. Raise this if
 * that happens on a loud speaker; lower it if a barge-in needs shouting.
 */
export const BARGE_IN_RMS = SPEECH_RMS * 2.5;

/**
 * Consecutive loud frames before a barge-in is believed. At ~60 ms a frame, three
 * is ~180 ms — long enough that a cough, a keyboard, or a leaked syllable of the
 * reply does not cut it off, short enough to feel immediate.
 */
export const BARGE_IN_FRAMES = 3;

/**
 * Total voiced time a recording needs before it is worth transcribing.
 *
 * "Something crossed the threshold once" is not speech — a door, a keyboard, a
 * breath all cross it. And Whisper does not answer "there was nothing there": on
 * near-silence it invents its most common training tails, which is why a quiet
 * room came back as "Thank you." and as "ご視聴ありがとうございました". Each of
 * those became a turn, went to the agent, and burned a round trip on nothing.
 *
 * A third of a second of actual voice is the cheapest way to tell speech from
 * noise, and it is measured here rather than trusted to the transcriber.
 */
export const MIN_VOICED_MS = 250;

export interface UtteranceTiming {
  /** Has anything above `SPEECH_RMS` been heard in this recording yet? */
  spoke: boolean;
  /** Total milliseconds spent above `SPEECH_RMS` in this recording. */
  voicedMs: number;
  /** Milliseconds of continuous quiet up to now. */
  silenceMs: number;
  /** Milliseconds since the recording started. */
  elapsedMs: number;
}

/**
 * `end` — send what was recorded. `abort` — throw it away and keep listening
 * (nothing was said, so there is nothing to transcribe and no turn to take).
 */
export type Verdict = 'continue' | 'end' | 'abort';

/** Quiet needed after speech before the turn is considered finished. Below
 *  ~700 ms this fires inside the natural pauses of a sentence. */
export const TRAIL_SILENCE_MS = 900;
/** Give up waiting for someone who is not speaking. Long enough to think, short
 *  enough that a call left open does not record an empty room forever. */
export const NO_SPEECH_TIMEOUT_MS = 8_000;
/** Hard cap on one turn. Whisper's cost grows with length, and a runaway
 *  recording is nearly always a stuck VAD rather than a very long sentence. */
export const MAX_UTTERANCE_MS = 30_000;

export function utteranceEnded({ spoke, voicedMs, silenceMs, elapsedMs }: UtteranceTiming): Verdict {
  // Enough voice to be a sentence, followed by enough quiet to be a full stop.
  const worthSending = voicedMs >= MIN_VOICED_MS;
  if (spoke && silenceMs >= TRAIL_SILENCE_MS) return worthSending ? 'end' : 'abort';
  // The cap ends a turn that had speech in it; noise, however long it ran, is
  // still not a turn.
  if (elapsedMs >= MAX_UTTERANCE_MS) return worthSending ? 'end' : 'abort';
  if (!spoke && elapsedMs >= NO_SPEECH_TIMEOUT_MS) return 'abort';
  return 'continue';
}
