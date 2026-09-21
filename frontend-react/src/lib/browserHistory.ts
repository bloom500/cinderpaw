/**
 * The address bar's memory: where the person has been, ranked the way
 * Firefox ranks its history, so "open" finds openrouter.ai on the first
 * keystroke after a week of visits instead of never.
 *
 * Two ideas, both lifted from Firefox's urlbar (browser/urlbar/ranking):
 *
 *  - frecency: every entry scores its visit count decayed by age, with a
 *    30-day half-life. A page visited daily beats one visited once, and a
 *    page visited last month fades without vanishing.
 *  - adaptive history: what the person TYPED and what they then PICKED are
 *    remembered as a pair. Next time the same letters go in, that pick
 *    comes first, whatever its frecency. This is the part that makes the bar
 *    feel like it knows you; entries unused for 90 days are dropped.
 *
 * Per machine, in localStorage: a convenience, not a record the agent reads.
 */
import { readLocal, writeLocal } from '@/lib/utils';

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastAt: number;
  /** Typed input -> how often this entry was picked for it (adaptive history). */
  picks: Record<string, number>;
}

export interface Suggestion {
  url: string;
  title: string;
  score: number;
  /** Why it ranks: an adaptive pick beats everything else. */
  adaptive: boolean;
}

export const HISTORY_KEY = 'cinderpaw.browser.history';
const MAX_ENTRIES = 500;
const HALF_LIFE_DAYS = 30;
const ADAPTIVE_TTL_MS = 90 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(readLocal(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is HistoryEntry => !!e && typeof e.url === 'string' && typeof e.visits === 'number',
    ).map((e) => ({ ...e, title: e.title ?? '', picks: e.picks ?? {} }));
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  writeLocal(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

/** Pages that are not places: the new-tab page, blanks, our own markers. */
export function recordable(url: string): boolean {
  return /^https?:\/\//.test(url) && !url.includes('#cp-');
}

/** One visit. Title may arrive later; the latest non-empty one wins. */
export function recordVisit(entries: HistoryEntry[], url: string, title: string, now = Date.now()): HistoryEntry[] {
  if (!recordable(url)) return entries;
  const i = entries.findIndex((e) => e.url === url);
  if (i >= 0) {
    const e = entries[i]!;
    const updated = { ...e, visits: e.visits + 1, lastAt: now, title: title.trim() || e.title };
    return [updated, ...entries.slice(0, i), ...entries.slice(i + 1)];
  }
  return [{ url, title: title.trim(), visits: 1, lastAt: now, picks: {} }, ...entries].slice(0, MAX_ENTRIES);
}

/** A title learned after the visit (pages report theirs once loaded). */
export function recordTitle(entries: HistoryEntry[], url: string, title: string): HistoryEntry[] {
  const t = title.trim();
  if (!t) return entries;
  return entries.map((e) => (e.url === url && e.title !== t ? { ...e, title: t } : e));
}

/** The person typed `input` and picked `url`: remember the pair. */
export function recordPick(entries: HistoryEntry[], input: string, url: string): HistoryEntry[] {
  const key = normalize(input);
  if (!key) return entries;
  return entries.map((e) => {
    if (e.url !== url) return e;
    // Asymptotic toward 10, like Firefox's use_count: a habit, not a runaway.
    const prev = e.picks[key] ?? 0;
    return { ...e, picks: { ...e.picks, [key]: prev + (10 - prev) / 4 } };
  });
}

export function frecency(e: HistoryEntry, now = Date.now()): number {
  const ageDays = Math.max(0, now - e.lastAt) / DAY_MS;
  return e.visits * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Reader view is served from a scheme of our own (see browser.rs); the
 *  article's real address rides in `?u=`. */
export function isReaderUrl(url: string): boolean {
  return url.startsWith('http://cinderpaw-reader.localhost/') || url.startsWith('cinderpaw-reader://localhost/');
}
export function readerOriginal(url: string): string {
  try { return new URL(url).searchParams.get('u') ?? url; } catch { return url; }
}

/** The part of a URL a person recognises: host and path, no scheme, no "www.". */
export function display(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

export function suggest(entries: HistoryEntry[], input: string, limit = 6, now = Date.now(), bookmarked: ReadonlySet<string> = new Set()): Suggestion[] {
  const q = normalize(input);
  if (!q) return [];
  const out: Suggestion[] = [];
  for (const e of entries) {
    if (now - e.lastAt > ADAPTIVE_TTL_MS && Object.keys(e.picks).length) e.picks = {};
    const url = display(e.url).toLowerCase();
    const title = e.title.toLowerCase();
    // Adaptive: any recorded input that starts with what is typed so far.
    let adaptive = 0;
    for (const [typed, n] of Object.entries(e.picks)) {
      if (typed.startsWith(q) || q.startsWith(typed)) adaptive = Math.max(adaptive, n);
    }
    const hostStart = url.startsWith(q);
    const wordStart = !hostStart && (url.includes('/' + q) || url.includes('.' + q) || title.split(/\s+/).some((w) => w.startsWith(q)));
    const anywhere = !hostStart && !wordStart && (url.includes(q) || title.includes(q));
    if (!adaptive && !hostStart && !wordStart && !anywhere) continue;
    const match = hostStart ? 3 : wordStart ? 2 : anywhere ? 1 : 0;
    // A bookmark outranks an equal visit: the person said this page matters.
    const score = adaptive * 1000 + match * 10 + frecency(e, now) + (bookmarked.has(e.url) ? 5 : 0);
    out.push({ url: e.url, title: e.title, score, adaptive: adaptive > 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Fuzzy, the way Nyxt and every command palette matches: the typed letters
 * must appear in order, not adjacently, so "ytb" finds YouTube. Scores prefer
 * matches at a word start and tighter spans.
 */
export function fuzzyScore(needle: string, hay: string): number {
  const n = needle.toLowerCase(); const h = hay.toLowerCase();
  if (!n) return 0;
  let hi = 0; let score = 0; let prevHit = -2;
  for (const ch of n) {
    const at = h.indexOf(ch, hi);
    if (at === -1) return 0;
    score += at === prevHit + 1 ? 3 : at === 0 || /[\s./_-]/.test(h[at - 1] ?? '') ? 2 : 1;
    prevHit = at; hi = at + 1;
  }
  return score / (h.length + 1) + (h.startsWith(n) ? 1 : 0);
}

// ── Bookmarks ────────────────────────────────────────────────────────────────
// Min's model: a bookmark is a page plus tags, and tags are how you find it
// again ("api", "docs", "to-read"). They also lift the page in the address
// bar, the way Firefox scores a bookmarked visit higher than a plain one.

export interface Bookmark {
  url: string;
  title: string;
  tags: string[];
  at: number;
}

export const BOOKMARKS_KEY = 'cinderpaw.browser.bookmarks';

export function loadBookmarks(): Bookmark[] {
  try {
    const raw = JSON.parse(readLocal(BOOKMARKS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((b): b is Bookmark => !!b && typeof b.url === 'string') .map((b) => ({ ...b, tags: b.tags ?? [], title: b.title ?? '' })) : [];
  } catch {
    return [];
  }
}

export function saveBookmarks(list: Bookmark[]): void {
  writeLocal(BOOKMARKS_KEY, JSON.stringify(list));
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

/** Add or update; an existing bookmark keeps its date. */
export function upsertBookmark(list: Bookmark[], b: Omit<Bookmark, 'at'>, now = Date.now()): Bookmark[] {
  const i = list.findIndex((x) => x.url === b.url);
  if (i >= 0) return list.map((x, j) => (j === i ? { ...x, title: b.title || x.title, tags: b.tags } : x));
  return [{ ...b, at: now }, ...list];
}

export function removeBookmark(list: Bookmark[], url: string): Bookmark[] {
  return list.filter((b) => b.url !== url);
}

/** Bookmarks matching the typed text by title, address or tag. */
export function findBookmarks(list: Bookmark[], input: string, limit = 6): Bookmark[] {
  const q = input.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  return list
    .map((b) => ({ b, s: Math.max(
      b.tags.some((t) => t.startsWith(q)) ? 3 : 0,
      fuzzyScore(q, b.title), fuzzyScore(q, display(b.url))) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.b);
}
