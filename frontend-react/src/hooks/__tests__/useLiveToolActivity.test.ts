import { describe, it, expect } from 'vitest';
import { hitsOf, subjectOf, kindOf, filesOf, factsOf } from '../useLiveToolActivity';

describe('kindOf', () => {
  it('routes each tool to the widget for its category, not its name', () => {
    expect(kindOf('web_search')).toBe('browser');
    expect(kindOf('read_webpage')).toBe('browser');
    expect(kindOf('write_file')).toBe('files');
    expect(kindOf('shell_exec')).toBe('terminal');
    expect(kindOf('recall')).toBe('memory');
  });

  it('matches suffixed variants, so a new tool joins its family for free', () => {
    expect(kindOf('web_search_news')).toBe('browser');
  });

  it('falls back rather than guessing a widget for an unknown tool', () => {
    expect(kindOf('capture_lead')).toBe('generic');
  });
});

describe('filesOf', () => {
  it('reads the single-file shape read_file and write_file return', () => {
    expect(filesOf({ data: { path: 'D:/a/b.ts', lines: 42, bytes: 900 } })).toEqual([
      { path: 'D:/a/b.ts', lines: 42, bytes: 900 },
    ]);
  });

  it('reads the array shape list_directory returns', () => {
    const files = filesOf({ data: [{ name: 'x.ts', size: 10 }, { path: 'y.ts' }] });
    expect(files.map((f) => f.path)).toEqual(['x.ts', 'y.ts']);
    expect(files[0].bytes).toBe(10);
    expect(files[1].lines).toBeNull();
  });
});

describe('factsOf', () => {
  it('reads memory facts whether they are strings or objects', () => {
    expect(factsOf({ data: { facts: ['speaks Romanian', { text: 'builds Feral' }] } })).toEqual([
      'speaks Romanian',
      'builds Feral',
    ]);
  });

  it('falls back to hits when there are no facts', () => {
    expect(factsOf({ data: { hits: [{ text: 'a note' }] } })).toEqual(['a note']);
  });

  it('is empty for a tool with no memory in it', () => {
    expect(factsOf({ data: { path: 'x' } })).toEqual([]);
  });
});

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
      data: [{ text: 'Feral AI — a local agent runtime', url: 'https://www.example.com/docs/feral' }],
    });
    expect(hits).toEqual([
      {
        title: 'Feral AI',
        url: 'https://www.example.com/docs/feral',
        host: 'example.com',
        snippet: 'a local agent runtime',
        crumbs: 'docs › feral',
      },
    ]);
  });

  it('keeps an em-dash inside the snippet instead of losing the tail', () => {
    // "a — b — c" is one title and a snippet that itself contains a dash, not
    // three fields. Splitting on every dash silently truncated abstracts.
    const [hit] = hitsOf({ data: [{ text: 'T — one — two', url: 'https://x.dev' }] });
    expect(hit.title).toBe('T');
    expect(hit.snippet).toBe('one — two');
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
