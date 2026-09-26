/**
 * Short, readable names for the links a person pastes into chat, the way
 * ChatGPT shows them: `github.com/jd-opensource/JoyAI-Video-Edit` becomes
 * "jd-opensource/JoyAI-Video-Edit", and a news article becomes
 * "hotnews.ro · guvernul a aprobat bugetul".
 *
 * ponytail: the words come from the address, not the page title. A title
 * needs a fetch of every pasted page, which is a network call per link and a
 * privacy question; the slug of a news URL is already its headline.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/g;
// Punctuation that ends a sentence, not the address.
const TRAILING = /[.,;:!?)\]}'"]+$/;
const MAX = 48;

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

/** Split a message into plain text and links, in order. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const href = raw.replace(TRAILING, '');
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

function clip(s: string): string {
  return s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s;
}

export function linkHost(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The chip's words. Falls back to the address itself when it is not a URL. */
export function linkLabel(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return clip(href);
  }
  const host = url.hostname.replace(/^www\./, '');
  const segs = url.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });

  // Code hosts: owner/repo is the name people already use.
  if (/^(github\.com|gitlab\.com|codeberg\.org)$/.test(host) && segs.length > 0) {
    return clip(segs.slice(0, 2).join('/'));
  }

  // Articles: the last segment is usually the headline as a slug. Numbers
  // (article ids) and file extensions are not words anyone reads.
  const last = segs.at(-1)?.replace(/\.(s?html?|php|aspx?)$/i, '') ?? '';
  const words = last
    .split(/[-_+]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .join(' ');
  return words.length >= 3 && words.includes(' ') ? clip(`${host} · ${words}`) : host;
}
