/**
 * A Markdown document cut into top-level blocks that render the same apart as
 * together, so a streamed reply parses only the block that is still growing.
 *
 * Parsing the whole reply again on every token made each update cost more the
 * longer the answer got (11 ms on average, 42 ms at worst for a 6 KB reply in
 * the test DOM, 25 Sep): text arrived in bursts and the rest of the window
 * waited. The blocks that are finished are rendered once and kept.
 *
 * Cuts are made only where cutting cannot change the result: at a blank line,
 * outside a code fence or a $$ math block, before a line that starts a new
 * block at the margin. A list and its items stay one block (a loose list is
 * still one list), so does a quote, and anything indented stays with what is
 * above it. A document with a link reference or footnote definition is not
 * cut at all: those resolve across the whole document, as does raw HTML.
 * Merging is always safe; only a cut can be wrong, so every doubt merges.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const QUOTE = /^ {0,3}>/;
const DEFINITION = /^ {0,3}\[[^\]]+\]:/;
const HTML_BLOCK = /^ {0,3}<[A-Za-z!/?]/;
const MATH_OPEN = /^ {0,3}\$\$/;

export function splitBlocks(md: string): string[] {
  const lines = md.split('\n');
  if (lines.some((l) => DEFINITION.test(l) || HTML_BLOCK.test(l))) return [md];

  const blocks: string[] = [];
  let cur: string[] = [];
  let started = false; // `cur` has a non-blank line
  let list = false; // `cur` has a list item at the margin
  let quote = false; // `cur` has a quote line
  let blankSeen = false; // a blank line after content in `cur`
  let fence: { ch: string; len: number } | null = null;
  let math = false;

  const cut = () => {
    blocks.push(cur.join('\n'));
    cur = [];
    started = false;
    list = false;
    quote = false;
    blankSeen = false;
  };

  for (const line of lines) {
    if (fence) {
      cur.push(line);
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (math) {
      cur.push(line);
      if (line.includes('$$')) math = false;
      continue;
    }
    if (line.trim() === '') {
      cur.push(line);
      if (started) blankSeen = true;
      continue;
    }
    if (blankSeen && startsAtMargin(line, list, quote)) cut();
    started = true;
    list ||= LIST_ITEM.test(line);
    quote ||= QUOTE.test(line);
    cur.push(line);
    const f = FENCE_OPEN.exec(line);
    if (f) {
      fence = { ch: f[1][0], len: f[1].length };
    } else if (MATH_OPEN.test(line) && !line.trim().slice(2).includes('$$')) {
      math = true;
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  // Each block after the first starts where the previous one ended; the blank
  // lines between them stay on the block above, where they change nothing.
  return blocks;
}

/**
 * Can `line`, after a blank line, begin a block of its own without changing
 * the block above (which has a list item at the margin: `list`, or a quote
 * line: `quote`)?
 */
function startsAtMargin(line: string, list: boolean, quote: boolean): boolean {
  // Indented: a list item's next paragraph, or code under a list.
  if (/^[ \t]/.test(line)) return false;
  // The next item of a list above; a loose list must stay one list.
  if (list && LIST_ITEM.test(line)) return false;
  if (quote && QUOTE.test(line)) return false;
  return true;
}
