/**
 * A document artifact cut into its sections, for the chat's document card.
 *
 * Plans (a trip, a campaign) are Markdown with `##` headings, or HTML with
 * `<h2>`. Each section keeps its words and the first picture it names, so the
 * card can show a list of sections and, for the one picked, a picture and the
 * text. Pure: no React, no network.
 */

export interface DocSection {
  title: string;
  /** Markdown for a Markdown source, plain text for HTML. The picture is not in it. */
  body: string;
  /** First `https:` picture in the section: the app shows nothing else remote. */
  image?: string;
}

/** Fewer than this and a document reads as one page, not as a set of tabs. */
export const MIN_SECTIONS = 3;

const IMG = /!\[([^\]]*)\]\(\s*<?(https:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/;

/** Take the first https picture out of a Markdown body. */
function takeImage(body: string): { body: string; image?: string } {
  const m = IMG.exec(body);
  if (!m) return { body: body.trim() };
  return { body: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim(), image: m[2] };
}

function markdownSections(md: string): DocSection[] {
  const sections: { title: string; lines: string[] }[] = [];
  let intro: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h2 = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) {
      current = { title: h2[1].replace(/[*_`]/g, ''), lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else intro.push(line);
  }
  // Words before the first `##`, apart from the document's own `#` title.
  intro = intro.filter((l) => !/^#\s/.test(l));
  const out: DocSection[] = [];
  const lead = takeImage(intro.join('\n'));
  if (lead.body || lead.image) out.push({ title: 'Overview', ...lead });
  for (const s of sections) out.push({ title: s.title, ...takeImage(s.lines.join('\n')) });
  return out;
}

function htmlSections(html: string): DocSection[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: DocSection[] = [];
  for (const h of Array.from(doc.body.querySelectorAll('h2'))) {
    const parts: string[] = [];
    let image: string | undefined;
    for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
      const src = (el.tagName === 'IMG' ? el : el.querySelector('img'))?.getAttribute('src') ?? '';
      if (!image && /^https:\/\//i.test(src)) image = src;
      parts.push(el.textContent ?? '');
    }
    out.push({ title: (h.textContent ?? '').trim(), body: parts.join('\n\n').replace(/[ \t]+/g, ' ').trim(), ...(image ? { image } : {}) });
  }
  return out.filter((s) => s.title);
}

/** The sections of a text document, or [] when it has none to speak of. */
export function sectionsOf(shown: 'markdown' | 'document' | string, content: string): DocSection[] {
  if (shown === 'markdown') return markdownSections(content);
  if (shown === 'document' || shown === 'html') return htmlSections(content);
  return [];
}

/** The first lines of a text artifact, as plain words: the overview's summary. */
export function summaryOf(kind: string, content: string): string {
  // Markdown already reads as itself in the hero; a page (document, html, Word) is a thumbnail.
  if (!['document', 'html', 'docx'].includes(kind)) return '';
  const text = content
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ' ') // the page's own title repeats the artifact's
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*#+\s.*$/m, ' ') // the first heading repeats the title
    .replace(/[#*_`>|~]+|-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 220 ? `${text.slice(0, 220).replace(/\s\S*$/, '')}…` : text;
}

/** Markdown to the words a reader sees: no emphasis marks, links as their text. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The line under a title on the card ("Kyoto · 7-day itinerary"): the first
 * short plain line after the `#` title of a Markdown document, or the page's
 * meta description. Empty when the document has none; the card then says what
 * kind of thing it is instead.
 */
export function subtitleOf(shown: string, content: string): string {
  if (shown === 'markdown') {
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    const start = lines.findIndex((l) => /^#\s/.test(l));
    for (const l of lines.slice(start + 1)) {
      if (!l) continue;
      if (/^(#|[-*+]\s|\d+\.\s|!\[|\||```|>)/.test(l)) return '';
      const text = plainText(l);
      return text.length <= 90 ? text : '';
    }
    return '';
  }
  if (shown === 'app' || shown === 'html' || shown === 'document') {
    const m = /<meta\s+name=["']description["']\s+content=["']([^"']{1,90})["']/i.exec(content);
    return m ? m[1].trim() : '';
  }
  return '';
}

/** The pill in the card's corner, from what the store knows: never a claim it cannot back. */
export function statusOf(version: number, updatedAt: number | undefined, now = Date.now()): string {
  if (version <= 1 || !updatedAt) return 'Generated';
  const min = Math.max(0, Math.round((now - updatedAt) / 60_000));
  const ago = min < 1 ? 'just now' : min < 60 ? `${min}m ago` : min < 60 * 24 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`;
  return `Updated ${ago}`;
}

/** A section at a glance: its first paragraph and up to three of its points. */
export function digest(body: string): { lead: string; points: string[] } {
  const blocks = body.split(/\n\s*\n/);
  const para = blocks.find((b) => b.trim() && !/^\s*([-*+]\s|\d+\.\s|\||#|```|>)/.test(b));
  const points = [...body.matchAll(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/gm)].slice(0, 3).map((m) => plainText(m[1]));
  return { lead: para ? plainText(para) : '', points };
}
