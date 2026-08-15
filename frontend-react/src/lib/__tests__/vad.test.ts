import { describe, it, expect } from 'vitest';
import {
  rms,
  isVoiced,
  utteranceEnded,
  BARGE_IN_FRAMES,
  BARGE_IN_RMS,
  CONTINUE_RMS,
  MAX_UTTERANCE_MS,
  MIN_VOICED_MS,
  NO_SPEECH_TIMEOUT_MS,
  SPEECH_RMS,
  TRAIL_SILENCE_MS,
  BARGE_CEILING_RMS,
  BARGE_GRACE_MS,
  createBargeInDetector,
  isTtsEcho,
  type UtteranceTiming,
} from '../vad';

describe('isVoiced (hysteresis)', () => {
  it('takes a clear voice to start a turn and a quiet one to continue it', () => {
    const dip = (SPEECH_RMS + CONTINUE_RMS) / 2; // between the two thresholds
    expect(isVoiced(dip, false)).toBe(false); // not enough to begin
    expect(isVoiced(dip, true)).toBe(true); // enough to keep going
  });

  it('still ends on real silence', () => {
    expect(isVoiced(0, true)).toBe(false);
    expect(isVoiced(CONTINUE_RMS / 2, true)).toBe(false);
  });

  it('keeps the continue threshold below the start threshold', () => {
    // Equal thresholds would delete the hysteresis while looking like it is there.
    expect(CONTINUE_RMS).toBeLessThan(SPEECH_RMS);
    expect(CONTINUE_RMS).toBeGreaterThan(0);
  });
});

describe('barge-in thresholds', () => {
  it('needs more than plain speech, or the agent interrupts itself', () => {
    // The mic is open while the reply plays and echo cancellation only suppresses
    // the speakers. At the speech threshold, Cubby hears Cubby.
    expect(BARGE_IN_RMS).toBeGreaterThan(SPEECH_RMS);
    expect(BARGE_IN_FRAMES).toBeGreaterThan(1);
  });
});

describe('rms', () => {
  it('is zero for silence and 1 for a full-scale square wave', () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(64).fill(1))).toBeCloseTo(1, 6);
  });
});

describe('utteranceEnded', () => {
  /** A turn with plenty of real voice in it. */
  const voiced = (over: Partial<UtteranceTiming> = {}): UtteranceTiming => ({
    spoke: true,
    voicedMs: 1_500,
    silenceMs: 0,
    elapsedMs: 3_000,
    ...over,
  });

  it('keeps listening through the pauses inside a sentence', () => {
    expect(utteranceEnded(voiced({ silenceMs: TRAIL_SILENCE_MS - 200 }))).toBe('continue');
  });

  it('ends the turn once the trailing silence is long enough', () => {
    expect(utteranceEnded(voiced({ silenceMs: TRAIL_SILENCE_MS }))).toBe('end');
  });

  it('aborts rather than sending a recording of nobody talking', () => {
    expect(
      utteranceEnded({
        spoke: false,
        voicedMs: 0,
        silenceMs: NO_SPEECH_TIMEOUT_MS,
        elapsedMs: NO_SPEECH_TIMEOUT_MS,
      }),
    ).toBe('abort');
    // Long silence is not a turn even when the cap is what ran out.
    expect(
      utteranceEnded({
        spoke: false,
        voicedMs: 0,
        silenceMs: MAX_UTTERANCE_MS,
        elapsedMs: MAX_UTTERANCE_MS,
      }),
    ).toBe('abort');
  });

  it('sends what it has when a turn hits the cap mid-speech', () => {
    // Someone still talking at 30s: cut the turn, do not discard what they said.
    expect(utteranceEnded(voiced({ elapsedMs: MAX_UTTERANCE_MS }))).toBe('end');
  });

  it('throws away a blip of noise instead of letting Whisper invent words', () => {
    // A door, a keyboard, a breath: one frame over the threshold, then quiet.
    // Sent to Whisper this comes back as "Thank you." or as Japanese — its
    // training tails — and each hallucination became a real turn to the agent.
    const blip = utteranceEnded({
      spoke: true,
      voicedMs: MIN_VOICED_MS - 60,
      silenceMs: TRAIL_SILENCE_MS,
      elapsedMs: 2_000,
    });
    expect(blip).toBe('abort');

    // Just over the line is a turn.
    expect(utteranceEnded(voiced({ voicedMs: MIN_VOICED_MS, silenceMs: TRAIL_SILENCE_MS })))
      .toBe('end');
  });
});

describe('createBargeInDetector', () => {
  const POLL = 60;

  /** Drive the detector for `ms`, returning the time the trigger fired. */
  const run = (
    detector: ReturnType<typeof createBargeInDetector>,
    frames: { loudness: number; playing: boolean; ms: number }[],
    startAt = 1_000,
  ): number | null => {
    let now = startAt;
    for (const step of frames) {
      for (let elapsed = 0; elapsed < step.ms; elapsed += POLL) {
        if (detector.feed(step.loudness, step.playing, now)) return now;
        now += POLL;
      }
    }
    return null;
  };

  it('does not trip on our own voice bleeding into the mic', () => {
    const detector = createBargeInDetector();
    // A quiet room, then the reply plays and leaks back at a level that would
    // have passed the old fixed threshold (BARGE_IN_RMS = 2.5x speech).
    const tripped = run(detector, [
      { loudness: 0.002, playing: false, ms: 600 },
      { loudness: BARGE_IN_RMS * 1.2, playing: true, ms: 4_000 },
    ]);
    expect(tripped).toBeNull();
  });

  it('still hears a real voice over that same playback', () => {
    const detector = createBargeInDetector();
    const tripped = run(detector, [
      { loudness: 0.002, playing: false, ms: 600 },
      { loudness: BARGE_IN_RMS * 1.2, playing: true, ms: 2_000 },
      { loudness: BARGE_CEILING_RMS, playing: true, ms: 1_000 },
    ]);
    expect(tripped).not.toBeNull();
  });

  it('ignores the onset transient when playback starts', () => {
    // Loud from the instant audio begins — that is the speaker turning on,
    // not a person. Inside the grace window it must be ignored.
    const detector = createBargeInDetector();
    let now = 1_000;
    for (let i = 0; i < 10; i++) { detector.feed(0.002, false, now); now += POLL; }
    let trippedInGrace = false;
    const graceEnd = now + BARGE_GRACE_MS;
    while (now < graceEnd) {
      if (detector.feed(BARGE_CEILING_RMS, true, now)) trippedInGrace = true;
      now += POLL;
    }
    expect(trippedInGrace).toBe(false);
  });

  it('survives the dip between two syllables', () => {
    const detector = createBargeInDetector();
    let now = 1_000;
    for (let i = 0; i < 10; i++) { detector.feed(0.002, false, now); now += POLL; }
    // Speech with one quiet frame in the middle. A consecutive-frames counter
    // resets to zero here and never fires; a majority window does not.
    const pattern = [1, 1, 0, 1, 1, 1, 1];
    let tripped = false;
    for (const loud of pattern) {
      if (detector.feed(loud ? BARGE_IN_RMS * 2 : 0.003, false, now)) tripped = true;
      now += POLL;
    }
    expect(tripped).toBe(true);
  });

  it('raises its trigger in a noisy room instead of firing on the room', () => {
    const quiet = createBargeInDetector();
    let now = 1_000;
    for (let i = 0; i < 10; i++) { quiet.feed(0.002, false, now); now += POLL; }
    const noisy = createBargeInDetector();
    now = 1_000;
    for (let i = 0; i < 10; i++) { noisy.feed(0.03, false, now); now += POLL; }
    expect(noisy.trigger()).toBeGreaterThan(quiet.trigger());
  });
});

describe('isTtsEcho', () => {
  const spoken =
    'Sigur, iată un rezumat. Compilarea a picat din cauza unei dependențe ' +
    'lipsă din lockfile. Am regenerat-o deja și testele trec din nou local.';

  it('flags a short fragment of a much longer reply', () => {
    // The common shape of a self-capture: playback-phase captures are cut on
    // trigger, so they span a fragment, not the whole sentence. A symmetric
    // similarity ratio dilutes against the length mismatch and misses this.
    expect(isTtsEcho('Compilarea a picat din cauza unei dependențe lipsă', spoken)).toBe(true);
  });

  it('flags a near-verbatim repeat with a stutter', () => {
    expect(isTtsEcho('Sigur iată, sigur iată un rezumat. Compilarea a picat', spoken)).toBe(true);
  });

  it('lets a genuine interruption through even if it shares words', () => {
    expect(isTtsEcho('stai, verifică și dependențele din package.json', spoken)).toBe(false);
  });

  it('never swallows a short command', () => {
    // "stop" appears inside plenty of replies. Judging it would make the call
    // impossible to end by speaking, which is worse than a wasted turn.
    for (const short of ['stop', 'gata', 'nu', 'așteaptă']) {
      expect(isTtsEcho(short, spoken)).toBe(false);
    }
  });

  it('says no when nothing has been spoken yet', () => {
    expect(isTtsEcho('Compilarea a picat din cauza unei dependențe', '')).toBe(false);
  });
});
