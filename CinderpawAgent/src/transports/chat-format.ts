/**
 * Chat-surface formatting — turning an agent answer into messages a chat app
 * actually renders.
 *
 * The desktop UI renders full markdown, so an answer that looks structured
 * there can arrive in Discord as an undifferentiated wall. Two separate causes,
 * both handled here:
 *
 *  1. **Splitting broke code blocks.** The old chunker cut at the last newline
 *     before the character limit with no idea what a fence was. A ``` block
 *     spanning the boundary left message one with an unclosed fence — Discord
 *     renders everything after it as code — and message two starting mid-source
 *     with no fence at all, rendered as prose. One block became two walls.
 *
 *  2. **Discord cannot render markdown tables.** It has no table support at
 *     all, so `| a | b |` arrives literally, pipes and dashes included. That is
 *     a wall of text no amount of chunking fixes. Tables are re-rendered here as
 *     column-aligned ASCII inside a code fence, which Discord *does* render in a
 *     monospace box — the closest thing to a table the surface offers.
 *
 * Splitting is structure-first: paragraphs, then lines, then sentences, then
 * words. A hard mid-word cut is the last resort rather than the first rule.
 */

/** Discord's hard per-message ceiling. The tightest of the three surfaces. */
export const DISCORD_LIMIT = 2000;

/** A run of lines that renders as one thing. */
type Block =
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "text"; lines: string[] };

/** Opening or closing fence: ``` or ~~~, optionally indented, optional info string. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** A markdown table's separator row: `|---|:--:|` and friends. */
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

/**
 * Split into fenced-code and plain-text runs.
 *
 * An unterminated fence at the end of the input is treated as code and closed
 * on output. That case is not hypothetical: it is what a reply truncated by the
 * model's output cap looks like, and leaving it open makes every following
 * message in the channel render as code.
 */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let textLines: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;
  let fence = "";

  const flushText = (): void => {
    if (textLines.some((l) => l.trim())) blocks.push({ kind: "text", lines: textLines });
    textLines = [];
  };

  for (const line of text.split("\n")) {
    const m = FENCE.exec(line);
    if (code === null) {
      if (m) {
        flushText();
        fence = m[1]!;
        code = { lang: (m[2] ?? "").trim(), lines: [] };
      } else {
        textLines.push(line);
      }
      continue;
    }
    // A closing fence is the same character, at least as long, and carries no
    // info string — `~~~` does not close a ``` block, and ```js opens a new one.
    const closes =
      m !== null && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !(m[2] ?? "").trim();
    if (closes) {
      blocks.push({ kind: "code", lang: code.lang, lines: code.lines });
      code = null;
    } else {
      code.lines.push(line);
    }
  }
  if (code) blocks.push({ kind: "code", lang: code.lang, lines: code.lines });
  flushText();
  return blocks;
}

/** Cells of one table row, outer pipes stripped. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Re-render a markdown table as column-aligned ASCII in a code fence.
 *
 * Alignment is computed here rather than trusting the source: models emit
 * tables with ragged column widths, and a ragged table in a monospace box is
 * only marginally better than the raw pipes it replaced.
 */
function renderTable(rows: string[][]): Block {
  const columns = Math.max(...rows.map((r) => r.length));
  const width: number[] = [];
  for (let c = 0; c < columns; c++) {
    width[c] = Math.max(1, ...rows.map((r) => (r[c] ?? "").length));
  }
  const line = (cells: string[]): string =>
    "| " + width.map((w, c) => (cells[c] ?? "").padEnd(w)).join(" | ") + " |";

  const out = [line(rows[0]!), "|" + width.map((w) => "-".repeat(w + 2)).join("|") + "|"];
  for (const r of rows.slice(1)) out.push(line(r));
  return { kind: "code", lang: "", lines: out };
}

/**
 * Pull markdown tables out of text blocks and replace them with code blocks.
 *
 * A table is a row line immediately followed by a separator row; it runs until
 * the first line that has no pipe. Text either side of it is preserved as its
 * own block, so a table in the middle of an explanation does not swallow the
 * prose around it.
 */
function extractTables(block: Block): Block[] {
  if (block.kind !== "text") return [block];
  const out: Block[] = [];
  let pending: string[] = [];
  const lines = block.lines;

  const flush = (): void => {
    if (pending.some((l) => l.trim())) out.push({ kind: "text", lines: pending });
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const startsTable = line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next);
    if (!startsTable) {
      pending.push(line);
      continue;
    }
    const rows: string[][] = [tableCells(line)];
    let j = i + 2; // skip the separator row itself
    for (; j < lines.length; j++) {
      const row = lines[j]!;
      if (!row.includes("|")) break;
      rows.push(tableCells(row));
    }
    flush();
    out.push(renderTable(rows));
    i = j - 1;
  }
  flush();
  return out;
}

/** Last-resort split, preferring a word boundary over a mid-word cut. */
function splitWords(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    // A boundary too near the start wastes most of the message; an unbroken
    // run that long (a URL, a base64 blob, minified code) has no word to find.
    if (cut < limit * 0.6) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Regroup `parts` into pieces of at most `limit`, rejoining with `joiner` and
 * handing anything still oversized to `finer` — the next-smaller boundary.
 */
function regroup(
  parts: string[],
  joiner: string,
  limit: number,
  finer: (s: string) => string[],
): string[] {
  const out: string[] = [];
  let cur = "";
  for (const piece of parts) {
    if (piece.length > limit) {
      if (cur) out.push(cur);
      cur = "";
      out.push(...finer(piece));
      continue;
    }
    const next = cur ? cur + joiner + piece : piece;
    if (next.length > limit) {
      if (cur) out.push(cur);
      cur = piece;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Sentence-ish spans. Used only when a single line overflows a message. */
function sentences(line: string): string[] {
  return line.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [line];
}

/** One paragraph → messages, descending through line, sentence, word. */
function splitParagraph(paragraph: string, limit: number): string[] {
  return regroup(paragraph.split("\n"), "\n", limit, (line) =>
    regroup(sentences(line), "", limit, (s) => splitWords(s, limit)),
  );
}

/**
 * A code block → one or more fully-fenced messages.
 *
 * Every piece opens and closes its own fence with the original language, so a
 * block split across three messages renders as three code boxes rather than one
 * box and two walls of plain text. The fence overhead is charged against the
 * budget — the reason the old splitter produced over-limit messages when it
 * tried to re-fence.
 */
function splitCode(lang: string, lines: string[], limit: number): string[] {
  const open = "```" + lang;
  const overhead = open.length + 1 + 4; // "```lang\n" … "\n```"
  const budget = limit - overhead;
  // Pathological limit: no room for a fence at all. Ship it as plain text
  // rather than emitting fences that cannot close.
  if (budget < 32) return splitWords(lines.join("\n"), limit);

  const groups: string[][] = [[]];
  let used = 0;
  for (const raw of lines) {
    for (const line of raw.length > budget ? splitWords(raw, budget) : [raw]) {
      const current = groups[groups.length - 1]!;
      const cost = line.length + (current.length > 0 ? 1 : 0);
      if (used + cost > budget && current.length > 0) {
        groups.push([]);
        used = 0;
      }
      groups[groups.length - 1]!.push(line);
      used += cost;
    }
  }
  return groups
    .filter((g) => g.length > 0)
    .map((g) => `${open}\n${g.join("\n")}\n\`\`\``);
}

/**
 * Format one agent reply into chat messages, each within `limit` characters and
 * each independently renderable.
 *
 * Guarantees, all of which the previous character-count chunker broke:
 *   - no message contains an unbalanced code fence,
 *   - no message exceeds `limit`,
 *   - markdown tables arrive readable,
 *   - splits land on the coarsest structural boundary that fits.
 */
export function formatForChat(text: string, limit: number = DISCORD_LIMIT): string[] {
  const trimmed = text.trim();
  if (!trimmed) return ["(no response)"];

  const blocks = parseBlocks(trimmed).flatMap(extractTables);

  // Each segment is self-contained and already within the limit.
  const segments: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      segments.push(...splitCode(block.lang, block.lines, limit));
      continue;
    }
    // Blank lines separate paragraphs. A bullet list has no blank lines between
    // items, so it stays one paragraph and is not torn apart item by item.
    for (const paragraph of block.lines.join("\n").split(/\n{2,}/)) {
      const p = paragraph.replace(/\s+$/, "");
      if (!p.trim()) continue;
      if (p.length <= limit) segments.push(p);
      else segments.push(...splitParagraph(p, limit));
    }
  }

  if (segments.length === 0) return ["(no response)"];

  // Pack neighbouring segments back together so a structured answer does not
  // arrive as ten tiny messages.
  const messages: string[] = [];
  let cur = "";
  for (const seg of segments) {
    const next = cur ? `${cur}\n\n${seg}` : seg;
    if (next.length > limit) {
      if (cur) messages.push(cur);
      cur = seg;
    } else {
      cur = next;
    }
  }
  if (cur) messages.push(cur);
  return messages;
}

/**
 * The style brief handed to a session answering on a chat surface.
 *
 * The other half of "it spits out a block of text": nothing told the model
 * where it was writing. The desktop app renders rich markdown, so a dense
 * essay-shaped answer looks fine there and unreadable in a phone-width chat
 * bubble — and the model, seeing the same system prompt in both, has no way to
 * know the difference.
 */
export function chatStyleBrief(surface: string): string {
  return [
    `## You are replying in ${surface}, not in a desktop app`,
    "Write for a narrow, scrolling chat window:",
    "- Lead with the answer. No preamble, no restating the question.",
    "- Short paragraphs — two or three sentences, blank line between them. Never one dense block.",
    "- Use `-` bullets for anything that is a list. Bold only the words that carry the point.",
    "- Code, commands, file contents and logs go in fenced blocks with a language tag.",
    "- No markdown tables: this surface cannot render them. Use bullets, or a fenced block if columns matter.",
    "- Long answers: a short summary first, detail after. If it runs past a screen, say what you cut.",
  ].join("\n");
}
