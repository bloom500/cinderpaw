import { describe, it, expect } from 'vitest';
import { allLines, linesFor, pickHomeLine, MAX_LEN } from '../homeLines';

// Wednesday 15 January 2025, local time.
const at = (hour: number, y = 2025, m = 1, d = 15) => new Date(y, m - 1, d, hour, 0);

describe('home lines', () => {
  it('fit on one row of the home screen', () => {
    const long = allLines().filter((l) => l.length > MAX_LEN);
    expect(long).toEqual([]);
  });

  it('match the hour', () => {
    expect(linesFor(at(8), 'Europe/Bucharest')).toContain('Coffee first, then what?');
    expect(linesFor(at(2), 'Europe/Bucharest')).toContain("Can't sleep? Let's talk.");
    expect(linesFor(at(2), 'Europe/Bucharest')).not.toContain('Coffee first, then what?');
  });

  it('give January to winter in the north and to summer in the south', () => {
    expect(linesFor(at(14), 'Europe/Bucharest')).toContain('Short days, big ideas.');
    expect(linesFor(at(14), 'Australia/Sydney')).toContain("Too hot to think? I'll help.");
    expect(linesFor(at(14), 'Australia/Sydney')).not.toContain('Short days, big ideas.');
  });

  it('keep a holiday to its own line', () => {
    expect(linesFor(at(10, 2025, 12, 25), 'Europe/Bucharest')).toEqual(['Merry Christmas. Need a hand?']);
  });

  it('never show the same line twice in a row', () => {
    const lines = linesFor(at(10), 'Europe/Bucharest');
    for (let i = 0; i < 50; i++) {
      const last = lines[i % lines.length];
      expect(pickHomeLine(at(10), 'Europe/Bucharest', last, () => (i / 50))).not.toBe(last);
    }
  });
});
