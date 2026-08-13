import { describe, it, expect } from 'vitest';
import { hitsOf, subjectOf } from '../useLiveToolActivity';

/**
 * These two parse another process's output, which is the only reason they are
 * worth testing: the sidecar can change a field name in a release and this must
 * dim the panel, never throw inside an event handler during a live call.
 */
describe('subjectOf', () => {
  it('prefers the query, because that is what proves the search is real', () => {
    expect(subjectOf({ path: '/tmp/x', query: 'ce este Feral' })).toBe('ce este Feral');
  });

  it('falls back through the other argument names', () => {
    expect(subjectOf({ url: 'https://example.com' })).toBe('https://example.com');
    expect(subjectOf({ command: 'ls -la' })).toBe('ls -la');
  });

  it('is empty rather than wrong when there is nothing to show', () => {
    expect(subjectOf(undefined)).toBe('');
    expect(subjectOf({ depth: 3 })).toBe('');
    expect(subjectOf({ query: '   ' })).toBe('');
  });
});

describe('hitsOf', () => {
  it('reads the DuckDuckGo shape, splitting the title off the snippet', () => {
    const hits = hitsOf({
      ok: true,
      data: [{ text: 'Feral AI — a local agent runtime', url: 'https://www.example.com/feral' }],
    });
    expect(hits).toEqual([
      { title: 'Feral AI', url: 'https://www.example.com/feral', host: 'example.com' },
    ]);
  });

  it('reads the SearXNG shape too', () => {
    const hits = hitsOf({ data: [{ title: 'Docs', url: 'https://docs.rs/x' }] });
    expect(hits[0]).toMatchObject({ title: 'Docs', host: 'docs.rs' });
  });

  it('drops rows it cannot use instead of rendering blanks', () => {
    const hits = hitsOf({
      data: [
        { text: 'no url here' },
        { url: 'https://ok.dev/a', text: 'Kept' },
        null,
        'not an object',
        { url: 'not a url', text: 'Bad host' },
      ],
    });
    // The malformed URL is kept — the title is real and useful — but with no
    // host, which is what the panel renders as a title-only row.
    expect(hits.map((h) => h.title)).toEqual(['Kept', 'Bad host']);
    expect(hits[1].host).toBe('');
  });

  it('returns nothing for a tool that has no results at all', () => {
    expect(hitsOf({ ok: true, content: 'wrote 12 lines' })).toEqual([]);
    expect(hitsOf(null)).toEqual([]);
    expect(hitsOf({ data: 'not an array' })).toEqual([]);
  });
});
