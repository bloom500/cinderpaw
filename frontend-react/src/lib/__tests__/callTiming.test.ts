import { describe, it, expect, beforeEach } from 'vitest';
import { callMark, callTimeline, turnMark, resetTurns } from '../callTiming';

describe('the call timeline', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('measures every stage back to the button press, in order', () => {
    callMark('call_requested');
    callMark('room_joined');
    callMark('microphone_ready');

    const seen = callTimeline().map((e) => e.mark);
    expect(seen).toEqual(['room_joined', 'microphone_ready']);
    expect(callTimeline().every((e) => e.ms >= 0)).toBe(true);
  });

  it('keeps the FIRST time a stage was reached, not the last', () => {
    callMark('call_requested');
    callMark('first_transcript');
    const first = callTimeline().find((e) => e.mark === 'first_transcript')!.ms;
    // Every later turn of a long call fires this again. A mark that moved each
    // time would answer "how long since the most recent word", which is not
    // what anything reading it is asking.
    for (let i = 0; i < 1000; i++) callMark('first_transcript');
    expect(callTimeline().find((e) => e.mark === 'first_transcript')!.ms).toBe(first);
    expect(performance.getEntriesByName('cinderpaw/call/first_transcript', 'mark')).toHaveLength(1);
  });

  it('starts a fresh timeline for a second call', () => {
    callMark('call_requested');
    callMark('room_joined');
    callMark('call_requested');
    // Otherwise the second call is measured from the first call's button press
    // and reports a warm join as having taken however long the person talked.
    expect(callTimeline()).toEqual([]);
  });

  it('does nothing at all when the platform has no stopwatch', () => {
    const real = globalThis.performance;
    // @ts-expect-error deliberately removing it
    delete globalThis.performance;
    expect(() => callMark('call_requested')).not.toThrow();
    expect(callTimeline()).toEqual([]);
    globalThis.performance = real;
  });
});

describe('per-turn timing', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
    resetTurns();
  });

  it('counts one turn however many partials arrive', () => {
    // Partials land several times a second while somebody is talking. Each one
    // starting a new turn would make every turn look instant and the count
    // meaningless.
    turnMark('heard');
    turnMark('heard');
    turnMark('heard');
    turnMark('transcribed');
    turnMark('answering');
    const first = turnMark('answered');
    expect(first?.turn).toBe(1);

    turnMark('heard');
    turnMark('answering');
    expect(turnMark('answered')?.turn).toBe(2);
  });

  it('reports all three spans, measured from the first partial', () => {
    turnMark('heard');
    turnMark('transcribed');
    turnMark('answering');
    const done = turnMark('answered');
    expect(Object.keys(done!.spans).sort()).toEqual(['answered', 'answering', 'transcribed']);
    expect(done!.spans.answered).toBeGreaterThanOrEqual(done!.spans.transcribed!);
  });

  it('ignores a stage that arrives with no turn behind it', () => {
    // A straggler from an interrupted utterance, or the greeting the assistant
    // speaks first, before anybody has said anything.
    expect(turnMark('answered')).toBeNull();
    expect(turnMark('answering')).toBeNull();
  });

  it('leaves no marks behind after a hundred turns', () => {
    for (let i = 0; i < 100; i++) {
      turnMark('heard');
      turnMark('transcribed');
      turnMark('answering');
      turnMark('answered');
    }
    const left = performance.getEntriesByType('mark').filter((e) => e.name.startsWith('cinderpaw/turn/'));
    expect(left).toHaveLength(0);
  });
});
