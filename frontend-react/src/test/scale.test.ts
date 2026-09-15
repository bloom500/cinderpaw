/**
 * The size contract.
 *
 * Nothing on any one screen looked wrong. What read as "amateur" (Darius,
 * 16 Sep) was measured instead of described: 238 labels set at 10 and 11.5 px,
 * and twelve different icon sizes from 8 to 20 px, each picked where it was
 * needed and never compared with its neighbours. The eye does not count sizes;
 * it notices that nothing agrees.
 *
 * These checks keep the agreement. A new one-off size fails here, not on
 * somebody's screen three releases later.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Raw source, as the author wrote it: the check is about what is typed in a component.
const RAW = import.meta.glob(['/src/**/*.tsx', '!/src/**/__tests__/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const FILES = Object.entries(RAW).map(([p, text]) => ({ p, text }));
const CONFIG = readFileSync('tailwind.config.ts', 'utf8');

/** Icons come in four sizes: inline, default, navigation, hero-ish. 28 is the one empty-state glyph. */
const ICON_SIZES = new Set([12, 14, 16, 20, 28]);

function hits(re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true): string[] {
  return FILES.flatMap(({ p, text }) =>
    [...text.matchAll(re)].filter(keep).map((m) => `${p}: ${m[0]}`),
  );
}

describe('type', () => {
  test('the smallest step is 11 px and the next is 12 px', () => {
    expect(CONFIG).toMatch(/micro:\s*\['11px'/);
    expect(CONFIG).toMatch(/'2xs':\s*\['12px'/);
  });

  test('no one-off pixel font sizes in components', () => {
    // The one exception is not text to read: CallToolScreen draws a to-scale
    // miniature of the screen the agent sees, and its labels shrink with it.
    const notMiniature = (m: RegExpMatchArray) =>
      !(m[0] === 'text-[7px]' && m.input?.includes('rounded-[2px] border text-[7px]'));
    expect(hits(/\btext-\[\d+(\.\d+)?px\]/g, notMiniature)).toEqual([]);
  });
});

describe('icons', () => {
  test(`every numeric icon size is one of ${[...ICON_SIZES].join(', ')}`, () => {
    expect(hits(/\bsize=\{(\d+)\}/g, (m) => !ICON_SIZES.has(Number(m[1])))).toEqual([]);
  });
});
