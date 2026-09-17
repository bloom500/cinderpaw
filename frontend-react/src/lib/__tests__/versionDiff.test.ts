import { describe, expect, it } from 'vitest';
import { diffLines, readableLines } from '../versionDiff';

describe('diffLines', () => {
  it('marks what came out and what went in, keeping the rest in order', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles an edit at either end', () => {
    expect(diffLines([], ['new'])).toEqual([{ kind: 'added', text: 'new' }]);
    expect(diffLines(['old'], [])).toEqual([{ kind: 'removed', text: 'old' }]);
  });

  it('identical versions have nothing added or removed', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])?.every((l) => l.kind === 'same')).toBe(true);
  });

  it('refuses a comparison too big to run in the window, instead of freezing it', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    expect(diffLines(big, big)).toBeNull();
  });
});

describe('readableLines', () => {
  it('compares a document as the text a reader sees, not its tags', () => {
    expect(readableLines('<h2>Title</h2><p>One <strong>bold</strong> word.</p><ul><li><p>item</p></li></ul>', 'document'))
      .toEqual(['Title', 'One bold word.', 'item']);
  });

  it('leaves every other kind as its own lines', () => {
    expect(readableLines('# a\nb', 'markdown')).toEqual(['# a', 'b']);
  });

  it('does not run a script it finds in a document', () => {
    (window as unknown as { pwned?: boolean }).pwned = false;
    readableLines('<p>hi</p><img src=x onerror="window.pwned=true"><script>window.pwned=true</script>', 'document');
    expect((window as unknown as { pwned?: boolean }).pwned).toBe(false);
  });
});
