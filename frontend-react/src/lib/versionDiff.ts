/**
 * What changed between two versions of an artifact, line by line.
 *
 * Used to review an edit Cinderpaw made: the person sees what went in and what
 * came out before deciding to keep it or put the old version back. Line level,
 * not character level, because a report is read in sentences and paragraphs,
 * and a character diff of a rewritten paragraph is confetti.
 *
 * A `document` is HTML, and a diff of HTML shows tags nobody wrote. So a
 * document is compared as the text a reader sees, one block per line.
 *
 * ponytail: plain LCS, O(lines x lines) memory. Fine for anything a person
 * reads in a side panel; past MAX_CELLS it gives up and says so rather than
 * freezing the window. Upgrade path: Myers' O(ND) diff if real documents hit it.
 */

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

const MAX_CELLS = 4_000_000;

/** The text a reader sees in an HTML document, one block per line. */
export function readableLines(content: string, kind: string): string[] {
  if (kind !== 'document') return content.split(/\r?\n/);
  // DOMParser builds an inert document: no script runs and nothing loads, which
  // matters because this HTML came from a model.
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const blocks = doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th');
  if (blocks.length === 0) return (doc.body.textContent ?? '').split(/\r?\n/);
  return Array.from(blocks)
    // A list item or table cell nested in another block would be counted twice.
    .filter((el) => !el.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre'))
    .map((el) => (el.textContent ?? '').trim());
}

/** null when the two are too large to compare here. */
export function diffLines(before: string[], after: string[]): DiffLine[] | null {
  const n = before.length;
  const m = after.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // lcs[i][j] = length of the longest common run of before[i..] and after[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: before[i++]! });
    } else {
      out.push({ kind: 'added', text: after[j++]! });
    }
  }
  while (i < n) out.push({ kind: 'removed', text: before[i++]! });
  while (j < m) out.push({ kind: 'added', text: after[j++]! });
  return out;
}
