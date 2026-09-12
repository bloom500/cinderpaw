import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';

/**
 * No em dash in anything a person reads.
 *
 * It is not a style quibble here: a dash where a full stop belongs is the
 * single most recognisable tell that a sentence was written by a language
 * model, and this product's whole claim is that a person made it. The fix is
 * never to swap the character for a hyphen — that leaves the same sentence
 * wearing a different dash. Restructure: two sentences, or a comma, or the
 * word the dash was standing in for.
 *
 * Comments are exempt. They are not the application.
 */

/** Source with block and line comments removed, so only real text is left. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Where an em dash is data rather than prose.
 *
 * `useLiveToolActivity` SPLITS on " — " because that is the separator inside a
 * search result it did not write, and `vad` lists it in a punctuation class it
 * strips. Removing it from either would break the parsing it exists for.
 */
const NOT_PROSE = ['useLiveToolActivity.ts', 'vad.ts'];

describe('no em dash reaches the screen', () => {
  it('the string table is clean in every language', () => {
    const table = withoutComments(readFileSync('src/lib/i18n.ts', 'utf8'));
    const offenders = table
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('—'));
    expect(offenders.map(([n, l]) => `i18n.ts:${n}: ${l.trim()}`)).toEqual([]);
  });

  it('no component or hook writes one into a literal', () => {
    const offenders: string[] = [];
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      // Tests are not the application. The separator is whichever one this
      // machine uses, so match both rather than assuming posix.
      if (/[\\/](?:__tests__|test)[\\/]/.test(file)) continue;
      if (NOT_PROSE.some((name) => file.endsWith(name))) continue;
      const text = withoutComments(readFileSync(file, 'utf8'));
      text.split('\n').forEach((line, i) => {
        if (line.includes('—')) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
