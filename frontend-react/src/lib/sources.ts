import type { ToolActivity, ToolHit } from '@/hooks/useLiveToolActivity';

/**
 * The same page, however the model wrote the address: no fragment, no
 * trailing slash, no `www.`, host in lower case. Null for anything that is not
 * an http(s) URL.
 */
export function normalizeUrl(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Every search result this turn's tools came back with, by normalised URL. */
export function sourcesOf(activity: readonly ToolActivity[]): Map<string, ToolHit> {
  const out = new Map<string, ToolHit>();
  for (const a of activity) {
    for (const hit of a.hits) {
      const key = normalizeUrl(hit.url);
      if (key && !out.has(key)) out.set(key, hit);
    }
  }
  return out;
}

/** The site's name for a chip: the host without `www.`. */
export function siteName(hit: Pick<ToolHit, 'host' | 'url'>): string {
  const host = hit.host || (() => { try { return new URL(hit.url).hostname; } catch { return hit.url; } })();
  return host.replace(/^www\./, '');
}

const LINK = /\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![("<])\b(https?:\/\/[^\s)<>"]+)/g;

/**
 * The results the answer actually cited, in the order it cited them. A link
 * the model wrote that is not one of the results is not a source: a chip
 * means "Cinderpaw read this".
 */
export function citedSources(content: string, sources: ReadonlyMap<string, ToolHit>): ToolHit[] {
  const seen = new Set<string>();
  const out: ToolHit[] = [];
  for (const m of content.matchAll(LINK)) {
    const key = normalizeUrl((m[1] ?? m[2] ?? m[3] ?? '').replace(/[.,;:!?]+$/, ''));
    const hit = key ? sources.get(key) : undefined;
    if (key && hit && !seen.has(key)) { seen.add(key); out.push(hit); }
  }
  return out;
}
