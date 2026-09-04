import { describe, it, expect } from 'vitest';
import { forSpeech, takeSpeakable, isLikelyHallucination, SPEAK_CHUNK_CHARS } from '../speechText';

describe('isLikelyHallucination', () => {
  it('catches the subtitle boilerplate Whisper invents on quiet audio', () => {
    // Every one of these reached the agent as a real turn tonight.
    for (const junk of [
      'Nu uitați să vă abonați la canal!',
      'Thank you.',
      'ご視聴ありがとうございました',
      '[Muzică]',
      'Mulțumesc pentru vizionare!',
    ]) {
      expect(isLikelyHallucination(junk), junk).toBe(true);
    }
  });

  it('leaves real speech alone', () => {
    for (const real of [
      'Caută-mi pe internet ultimele noutăți din lumea AI.',
      'Mă auzi?',
      'Da.',
      // The same words inside a longer sentence are probably genuinely spoken —
      // discarding real speech is the worse error.
      'Nu uitați să vă abonați, am zis eu în glumă, dar hai să vedem ce poți face cu asta.',
    ]) {
      expect(isLikelyHallucination(real), real).toBe(false);
    }
  });
});

describe('takeSpeakable', () => {
  const long = (n: number) => 'a'.repeat(n);

  it('waits until there is enough text to be worth a request', () => {
    expect(takeSpeakable('Salut.', false)).toBeNull();
    expect(takeSpeakable('', false)).toBeNull();
  });

  it('cuts at the last sentence end once past the threshold', () => {
    const text = `${long(SPEAK_CHUNK_CHARS)}. Coada rămâne`;
    const piece = takeSpeakable(text, false);
    expect(piece?.speak.endsWith('.')).toBe(true);
    expect(piece?.rest.trim()).toBe('Coada rămâne');
  });

  it('never cuts inside an unfinished sentence', () => {
    // A long clause with no full stop yet: speaking half of it would put a seam
    // mid-phrase, which is heard as a glitch rather than as a pause.
    expect(takeSpeakable(long(SPEAK_CHUNK_CHARS + 50), false)).toBeNull();
  });

  it('flushes whatever is left when the stream ends', () => {
    const piece = takeSpeakable('Ultimul fragment fără punct', true);
    expect(piece).toEqual({ speak: 'Ultimul fragment fără punct', rest: '' });
    // Nothing pending at the end of a stream is not a piece to speak.
    expect(takeSpeakable('   ', true)).toBeNull();
  });

  it('loses no text and duplicates none across successive takes', () => {
    let pending = `${long(SPEAK_CHUNK_CHARS)}. ${long(SPEAK_CHUNK_CHARS)}. rest`;
    const original = pending;
    const spoken: string[] = [];
    for (;;) {
      const piece = takeSpeakable(pending, false);
      if (!piece) break;
      spoken.push(piece.speak);
      pending = piece.rest;
      if (!piece.rest) break;
    }
    const tail = takeSpeakable(pending, true);
    if (tail) spoken.push(tail.speak);
    expect(spoken.join(' ')).toBe(original);
  });
});
describe('forSpeech', () => {
  it('announces a code block instead of reading it aloud', () => {
    const out = forSpeech('Try this:\n\n```ts\nconst x = 1;\n```\n\nThen run it.');
    expect(out).not.toContain('const');
    expect(out).toContain('(code on screen)');
    expect(out).toContain('Then run it.');
  });

  it('drops the marks that would be spoken as punctuation', () => {
    expect(forSpeech('**really** important and _urgent_')).toBe('really important and urgent');
    expect(forSpeech('## Heading\n- one\n- two')).toBe('Heading\none\ntwo');
    expect(forSpeech('see the [docs](https://example.com) for more')).toBe('see the docs for more');
    expect(forSpeech('run `cargo test` first')).toBe('run cargo test first');
  });

  it('leaves prose with incidental punctuation alone', () => {
    // Underscores inside identifiers are not emphasis, and a lone asterisk in
    // arithmetic is not either.
    const prose = 'Use snake_case here, and 3 * 4 is 12.';
    expect(forSpeech(prose)).toBe(prose);
  });
});
