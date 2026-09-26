/**
 * The few headline items of a release, from its notes.
 *
 * The notes are the CHANGELOG section release.yml copies into the GitHub
 * release: markdown, blockquotes, headings, a hundred lines. The update card
 * showed the first three lines of that raw text ("> Version numbers in the
 * build now read...", 24 Sep), which told nobody anything. A bullet's first
 * bold phrase is its headline by the way the changelog is written
 * ("- **Sign in with OpenRouter** instead of pasting a key"), so those are
 * the highlights, in order.
 */
export function releaseHighlights(notes: string | null, max = 3): string[] {
  if (!notes) return [];
  const out: string[] = [];
  for (const line of notes.split('\n')) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const bold = /\*\*(.+?)\*\*/.exec(line)?.[1]?.trim();
    if (bold && !out.includes(bold)) out.push(bold);
    if (out.length === max) break;
  }
  return out;
}
