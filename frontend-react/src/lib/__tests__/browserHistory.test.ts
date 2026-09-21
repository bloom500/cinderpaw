import { describe, it, expect } from 'vitest';
import { recordVisit, recordPick, recordTitle, suggest, frecency, fuzzyScore, type HistoryEntry } from '../browserHistory';

const DAY = 24 * 3600 * 1000;
const T0 = 1_800_000_000_000;

function history(): HistoryEntry[] {
  let h: HistoryEntry[] = [];
  // openrouter daily for a week; github once, long ago; a youtube video yesterday
  for (let d = 7; d >= 1; d--) h = recordVisit(h, 'https://openrouter.ai/credits', 'Credits | OpenRouter', T0 - d * DAY);
  h = recordVisit(h, 'https://github.com/bloom500/cinderpaw', 'cinderpaw', T0 - 60 * DAY);
  h = recordVisit(h, 'https://www.youtube.com/watch?v=abc', 'Some talk about agents', T0 - DAY);
  return h;
}

describe('address bar history', () => {
  it('counts visits and keeps the latest title', () => {
    let h = recordVisit([], 'https://a.example/', '', T0);
    h = recordVisit(h, 'https://a.example/', 'A', T0 + 1);
    h = recordTitle(h, 'https://a.example/', 'A page');
    expect(h).toHaveLength(1);
    expect(h[0]!.visits).toBe(2);
    expect(h[0]!.title).toBe('A page');
  });

  it('ignores the new-tab page and our own markers', () => {
    expect(recordVisit([], 'about:blank', '', T0)).toEqual([]);
    expect(recordVisit([], 'https://x.example/#cp-abc=1', '', T0)).toEqual([]);
  });

  it('frecency: a page visited daily beats one visited once, and old visits fade', () => {
    const h = history();
    const or = h.find((e) => e.url.includes('openrouter'))!;
    const gh = h.find((e) => e.url.includes('github'))!;
    expect(frecency(or, T0)).toBeGreaterThan(frecency(gh, T0));
    expect(frecency(gh, T0)).toBeLessThan(0.3); // 60 days = two half-lives
  });

  it('"open" finds openrouter first, by host prefix and frecency', () => {
    const s = suggest(history(), 'open', 6, T0);
    expect(s[0]!.url).toBe('https://openrouter.ai/credits');
  });

  it('matches words in the title too', () => {
    const s = suggest(history(), 'agents', 6, T0);
    expect(s[0]!.url).toContain('youtube');
  });

  it('adaptive: what was picked for these letters comes first, whatever its frecency', () => {
    let h = history();
    // "gi" would rank github low (old, one visit); the person keeps picking it.
    h = recordPick(h, 'gi', 'https://github.com/bloom500/cinderpaw');
    const s = suggest(h, 'g', 6, T0);
    expect(s[0]!.url).toContain('github');
    expect(s[0]!.adaptive).toBe(true);
  });

  it('adaptive picks saturate instead of running away', () => {
    let h = history();
    for (let i = 0; i < 50; i++) h = recordPick(h, 'or', 'https://openrouter.ai/credits');
    const or = h.find((e) => e.url.includes('openrouter'))!;
    expect(or.picks['or']).toBeLessThanOrEqual(10);
  });

  it('empty input suggests nothing', () => {
    expect(suggest(history(), '  ', 6, T0)).toEqual([]);
  });
});

describe('fuzzy tab matching', () => {
  it('matches letters in order, not only adjacent, and prefers word starts', () => {
    expect(fuzzyScore('ytb', 'YouTube')).toBeGreaterThan(0);
    expect(fuzzyScore('ope', 'openrouter.ai')).toBeGreaterThan(fuzzyScore('ope', 'developer.mozilla.org'));
    expect(fuzzyScore('zzz', 'openrouter.ai')).toBe(0);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});

describe('bookmarks with tags', () => {
  it('adds, updates in place, finds by tag or title, removes', async () => {
    const { upsertBookmark, removeBookmark, findBookmarks, parseTags } = await import('../browserHistory');
    let b = upsertBookmark([], { url: 'https://openrouter.ai/docs', title: 'OpenRouter Docs', tags: parseTags('api, Docs docs') }, T0);
    expect(b[0]!.tags).toEqual(['api', 'docs']);
    b = upsertBookmark(b, { url: 'https://openrouter.ai/docs', title: '', tags: ['api'] }, T0 + 1);
    expect(b).toHaveLength(1);
    expect(b[0]!.title).toBe('OpenRouter Docs');
    expect(b[0]!.at).toBe(T0);
    b = upsertBookmark(b, { url: 'https://github.com/bloom500/cinderpaw', title: 'cinderpaw', tags: ['code'] }, T0);
    expect(findBookmarks(b, 'api').map((x) => x.url)).toEqual(['https://openrouter.ai/docs']);
    expect(findBookmarks(b, 'cind')[0]!.url).toContain('github');
    expect(findBookmarks(b, '')).toHaveLength(2);
    expect(removeBookmark(b, 'https://github.com/bloom500/cinderpaw')).toHaveLength(1);
  });

  it('a bookmarked page outranks an equal visit in the address bar', () => {
    let h: HistoryEntry[] = [];
    h = recordVisit(h, 'https://a.example/x', 'alpha', T0);
    h = recordVisit(h, 'https://b.example/x', 'alpha', T0);
    const s = suggest(h, 'alpha', 6, T0, new Set(['https://b.example/x']));
    expect(s[0]!.url).toBe('https://b.example/x');
  });
});
