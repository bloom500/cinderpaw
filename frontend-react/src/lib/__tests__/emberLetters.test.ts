import { describe, expect, it } from 'vitest';
import { IN_MS, chunkRun, editRuns, letterDelay, liveUntil, type Run } from '@/lib/emberLetters';

describe('chunkRun', () => {
  it('staggers the letters of one chunk 9 ms apart', () => {
    expect(chunkRun(0, 'abc', 0)).toEqual({ from: 0, to: 3, at: 0, per: 9 });
  });

  it('caps a whole document arriving at once, so it settles in about a second', () => {
    const run = chunkRun(0, 'x'.repeat(5000), 0);
    expect(run.per).toBeLessThanOrEqual(0.12);
    expect(liveUntil([run])).toBeLessThan(1400);
  });
});

describe('letterDelay', () => {
  const runs: Run[] = [chunkRun(0, 'Hello', 0), chunkRun(5, ' world', 600)];

  it('old letters do not replay: once their animation is over they are plain', () => {
    expect(letterDelay(runs, 0, 900)).toBeNull();
    expect(letterDelay(runs, 4, 900)).toBeNull();
  });

  it('new letters animate, each starting a little after the one before', () => {
    expect(letterDelay(runs, 5, 900)).toBe(0);
    expect(letterDelay(runs, 6, 900)).toBe(9);
  });

  it('keeps a letter delay the same for as long as it animates', () => {
    const at = [610, 700, 1000, 1300].map((now) => letterDelay(runs, 7, now));
    expect(new Set(at)).toEqual(new Set([18]));
  });

  it('knows nothing about text written before the runs', () => {
    expect(letterDelay([chunkRun(10, 'abc', 0)], 3, 5)).toBeNull();
  });
});

describe('liveUntil', () => {
  it('is when the last letter has finished', () => {
    expect(liveUntil([chunkRun(0, 'abc', 0)])).toBe(18 + IN_MS);
    expect(liveUntil([])).toBe(0);
  });
});

describe('editRuns', () => {
  const slice = (s: string, [a, b]: [number, number]) => s.slice(a, b);

  it('takes out only the words that changed, and brings in only the new ones', () => {
    const before = '# Plan\n\nSeven days, one clear message.\n\nThe end.';
    const after = '# Plan\n\nFourteen days, one clear message, at 9:00.\n\nThe end.';
    const r = editRuns(before, after, 0)!;
    expect(r.out.map((x) => slice(before, x))).toEqual(['Seven', 'message.']);
    expect(r.runs.map((x) => after.slice(x.from, x.to))).toEqual(['Fourteen', 'message, at 9:00.']);
  });

  it('touches nothing when the text is the same', () => {
    expect(editRuns('a\nb', 'a\nb', 0)).toEqual({ out: [], runs: [] });
  });

  it('brings in a whole new paragraph and takes out a removed one', () => {
    const r = editRuns('One.\n\nTwo.', 'One.\n\nThree is new.', 0)!;
    expect(r.out.map((x) => slice('One.\n\nTwo.', x))).toEqual(['Two.']);
    expect(r.runs.map((x) => 'One.\n\nThree is new.'.slice(x.from, x.to))).toEqual(['Three is new.']);
  });
});
