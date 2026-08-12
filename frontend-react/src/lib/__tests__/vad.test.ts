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
