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
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    if (!Number.isFinite(frame[i])) return 0;
    sum += frame[i] * frame[i];
  }
  const loudness = Math.sqrt(sum / frame.length);
  return Number.isFinite(loudness) ? loudness : 0;
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
 *
 * This is the FLOOR of the barge-in trigger, not the trigger itself: see
 * `createBargeInDetector`, which lifts it against the room actually measured
 * and again while audio is playing.
 */
export const BARGE_IN_RMS = SPEECH_RMS * 2.5;

/**
 * Consecutive loud frames before a barge-in is believed. At ~60 ms a frame, three
 * is ~180 ms — long enough that a cough, a keyboard, or a leaked syllable of the
 * reply does not cut it off, short enough to feel immediate.
 *
 * @deprecated Superseded by the windowed majority in `createBargeInDetector`.
 * A consecutive count resets to zero on the dip between two syllables, so it
 * needs a louder, more continuous shout than real speech provides. Kept only
 * because it names the timescale the majority window still uses.
 */
export const BARGE_IN_FRAMES = 3;

// ── Barge-in: hearing the user over our own voice ────────────────────────────
//
// The hard part is not detecting speech, it is detecting speech that is NOT
// ours. `echoCancellation` does not reliably cancel same-application playback
// on Windows, so the reply bleeds into the microphone at a level that varies
// with the speaker, the volume and the room. A single fixed threshold cannot
// be right for both "quiet room, laptop mic" and "external speakers at
// eighty percent" — too low and the agent interrupts itself, too high and a
// barge-in needs shouting.
//
// So the trigger is derived per call instead of declared:
//   - a quiet-phase noise floor, measured only while nothing is playing and
//     HELD through playback (calibrating against our own bleed bakes it into
//     the floor and puts the trigger out of reach),
//   - lifted while audio plays so bleed alone cannot trip it, but capped so
//     real speech always stays reachable,
//   - a short grace after playback starts, to swallow the onset transient,
//   - and a windowed majority rather than a consecutive run, so the dip
//     between two syllables does not reset the evidence.
//
// The absolute levels below are expressed as multiples of `SPEECH_RMS`, the
// one value here that was measured on real hardware. They are calibration
// knobs: a machine whose microphone gain differs will need them re-measured,
// not re-derived.

/** Quiet needed before the noise floor is trusted. */
export const BARGE_CALIBRATION_MS = 400;
/** Window over which the majority vote is taken. */
export const BARGE_SUSTAINED_MS = 300;
/** Fraction of that window that must be above trigger. */
export const BARGE_SUSTAINED_MAJORITY = 0.8;
/** How far above the measured room noise counts as a voice. */
export const BARGE_FLOOR_MULTIPLIER = 3.5;
/** While the reply plays, the trigger is lifted at least this high… */
export const BARGE_PLAYBACK_MIN_RMS = SPEECH_RMS * 4.5;
/** …and never above this, or barge-in becomes impossible over loud playback. */
export const BARGE_CEILING_RMS = SPEECH_RMS * 12;
/** Ignore the microphone for this long after playback starts. */
export const BARGE_GRACE_MS = 500;
/**
 * Only grant that grace when playback resumes after a real gap.
 *
 * The reply is spoken sentence by sentence, so "is audio playing" flickers
 * many times per turn. Granting a fresh grace window on every flicker chains
 * them end to end and silently disables barge-in for the whole reply.
 */
export const BARGE_GRACE_GAP_MS = 1_000;

export interface BargeInDetector {
  /** Feed one frame. Returns true the moment sustained speech is believed. */
  feed(loudness: number, playing: boolean, now: number): boolean;
  /** The trigger level currently in force — for logging a tuning session. */
  trigger(): number;
}

/**
 * Stateful barge-in decision, kept out of the audio graph so it can be tested
 * with numbers instead of hardware.
 */
export function createBargeInDetector(): BargeInDetector {
  const floorSamples: number[] = [];
  const recent: { above: boolean; at: number }[] = [];
  let quietFloor = 0;
  let floorLocked = false;
  let calibratedSince: number | null = null;
  let wasPlaying = false;
  let playbackSeen = false;
  let lastPlayingAt = 0;
  let graceUntil = 0;
  let currentTrigger = BARGE_IN_RMS;

  /** Median of the quiet samples — robust to a single door slam. */
  const pushFloor = (level: number) => {
    floorSamples.push(level);
    // ~3 s of history at a 60 ms frame; older rooms are not this room.
    if (floorSamples.length > 50) floorSamples.shift();
    const sorted = [...floorSamples].sort((a, b) => a - b);
    quietFloor = sorted[sorted.length >> 1] ?? 0;
  };

  return {
    trigger: () => currentTrigger,
    feed(loudness, playing, now) {
      if (!floorLocked) {
        if (!playing) {
          if (loudness < BARGE_IN_RMS) {
            calibratedSince ??= now;
            pushFloor(loudness);
          } else {
            // Speech can begin before the quiet-room window exists. Treating
            // that voice as the floor multiplies the trigger out of reach.
            floorLocked = true;
          }
        }
        // Playback starting before calibration finishes locks whatever we
        // have: a floor measured against our own voice is worse than none.
        if (playing || (calibratedSince !== null && now - calibratedSince >= BARGE_CALIBRATION_MS)) {
          floorLocked = true;
        }
      }

      if (playing && !wasPlaying && (!playbackSeen || now - lastPlayingAt >= BARGE_GRACE_GAP_MS)) {
        graceUntil = now + BARGE_GRACE_MS;
      }
      if (playing) {
        playbackSeen = true;
        lastPlayingAt = now;
      }
      wasPlaying = playing;

      let trigger = Math.max(BARGE_IN_RMS, quietFloor * BARGE_FLOOR_MULTIPLIER);
      if (playing) {
        trigger = Math.min(Math.max(trigger, BARGE_PLAYBACK_MIN_RMS), BARGE_CEILING_RMS);
      }
      currentTrigger = trigger;

      // Keep following the room while it is quiet and nothing is happening.
      if (floorLocked && !playing && loudness < trigger) pushFloor(loudness);

      const above = floorLocked && loudness >= trigger && now >= graceUntil;
      recent.push({ above, at: now });
      while (recent.length && now - recent[0].at > BARGE_SUSTAINED_MS) recent.shift();

      if (!above) return false;
      const span = recent.length ? now - recent[0].at : 0;
      if (span < BARGE_SUSTAINED_MS * BARGE_SUSTAINED_MAJORITY) return false;
      const aboveCount = recent.reduce((n, s) => n + (s.above ? 1 : 0), 0);
      return aboveCount >= recent.length * BARGE_SUSTAINED_MAJORITY;
    },
  };
}

// ── Telling our own voice apart from the user's ──────────────────────────────

/** Lowercase, drop punctuation, collapse whitespace. */
function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:…"'`´„“”‘’()\[\]{}\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character bigrams — language-agnostic, so this works on Romanian too. */
function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Below this many characters a transcript is not judged at all.
 *
 * Short utterances are exactly the ones that matter most — "stop", "wait",
 * "nu" — and they are also the ones most likely to appear by chance inside a
 * long reply. Refusing to judge them is the safe direction: the cost of a
 * missed echo is one wasted turn, the cost of swallowing "stop" is a call the
 * user cannot end by speaking.
 */
export const ECHO_MIN_CHARS = 16;

/** Residual speaker audio may remain in the input path after playback ends. */
export const ECHO_GUARD_AFTER_PLAYBACK_MS = 1_500;

/** Whether a recording began while our voice could still be in the microphone. */
export function isEchoGuardedCapture(
  whilePlaying: boolean,
  captureStartedAt: number,
  lastPlaybackEndedAt: number,
): boolean {
  if (whilePlaying) return true;
  if (lastPlaybackEndedAt <= 0 || captureStartedAt < lastPlaybackEndedAt) return false;
  return captureStartedAt - lastPlaybackEndedAt <= ECHO_GUARD_AFTER_PLAYBACK_MS;
}

/** Fraction of the transcript that must already exist in the spoken text. */
export const ECHO_CONTAINMENT = 0.85;

/**
 * Did the microphone just capture our own reply coming back?
 *
 * Even with the trigger tuned, some bleed gets through, gets transcribed, and
 * would be submitted as the user's next turn — the agent answering itself.
 * This is the second line of defence, applied ONLY to captures taken while
 * audio was playing; speech heard while the model was still generating cannot
 * be our voice, because there was no voice yet.
 *
 * Measured by CONTAINMENT (how much of the transcript exists in what we said)
 * rather than similarity between the two strings. A real self-capture is
 * usually a short fragment of a much longer reply, and a symmetric ratio
 * dilutes to nothing against that length mismatch — the fragment case is the
 * common one, so scoring it as "unrelated" would defeat the whole guard.
 */
export function isTtsEcho(transcript: string, spoken: string): boolean {
  const heard = normalizeSpoken(transcript);
  const said = normalizeSpoken(spoken);
  if (!heard || !said) return false;
  if (said.includes(heard)) return true;
  if (heard.length < ECHO_MIN_CHARS) return false;

  const heardGrams = bigrams(heard);
  if (heardGrams.length === 0) return false;
  const saidGrams = new Set(bigrams(said));
  const shared = heardGrams.reduce((n, g) => n + (saidGrams.has(g) ? 1 : 0), 0);
  return shared / heardGrams.length >= ECHO_CONTAINMENT;
}

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
