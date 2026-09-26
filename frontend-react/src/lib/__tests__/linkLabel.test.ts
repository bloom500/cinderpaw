import { describe, it, expect } from 'vitest';
import { linkLabel, splitLinks } from '../linkLabel';

describe('linkLabel', () => {
  it('names a repository the way people say it', () => {
    expect(linkLabel('https://github.com/jd-opensource/JoyAI-Video-Edit')).toBe('jd-opensource/JoyAI-Video-Edit');
    expect(linkLabel('https://github.com/jd-opensource/JoyAI-Video-Edit/tree/main/src')).toBe('jd-opensource/JoyAI-Video-Edit');
  });

  it('turns an article slug into its headline and drops the id', () => {
    expect(linkLabel('https://www.hotnews.ro/guvernul-a-aprobat-bugetul-2027-1234567'))
      .toBe('hotnews.ro · guvernul a aprobat bugetul');
    expect(linkLabel('https://recorder.ro/cum-se-fura-apa-din-romania.html'))
      .toBe('recorder.ro · cum se fura apa din romania');
  });

  it('shows only the site when the address has no words', () => {
    expect(linkLabel('https://www.youtube.com/watch?v=abc')).toBe('youtube.com');
    expect(linkLabel('https://example.com/')).toBe('example.com');
  });

  it('keeps long headlines to one short line', () => {
    const label = linkLabel('https://hotnews.ro/' + 'foarte-lung-'.repeat(10) + 'final');
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('splitLinks', () => {
  it('leaves sentence punctuation out of the link', () => {
    expect(splitLinks('uite https://github.com/a/b, e bun.')).toEqual([
      { kind: 'text', text: 'uite ' },
      { kind: 'link', href: 'https://github.com/a/b' },
      { kind: 'text', text: ', e bun.' },
    ]);
  });

  it('returns plain text untouched', () => {
    expect(splitLinks('fara linkuri')).toEqual([{ kind: 'text', text: 'fara linkuri' }]);
  });
});
