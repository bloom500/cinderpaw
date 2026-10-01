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
