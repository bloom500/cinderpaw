import type { ToolActivity } from '@/hooks/useLiveToolActivity';

export type TimelinePiece =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: ToolActivity[] };

/**
 * A reply in the order it happened: what the agent said, the tools it then
 * called, what it said next. Each tool carries `at`, the length of the reply's
 * text when it was called, so the text is cut there and the tools go between.
 * Tools called back to back, with nothing said between them, share one group.
 *
 * Null when any tool has no `at` (a reply saved before 27 Sep, or plain chat):
 * those keep the old layout, steps above and the answer below.
 */
export function timeline(content: string, tools: ToolActivity[]): TimelinePiece[] | null {
  if (tools.length === 0 || tools.some((a) => a.at === undefined)) return null;
  const pieces: TimelinePiece[] = [];
  let from = 0;
  for (const tool of tools) {
    // Never backwards, never past the end: a reply replaced at the end of the
    // turn (the sidecar's final text) can be shorter than the offsets were.
    const at = Math.min(Math.max(tool.at!, from), content.length);
    const text = content.slice(from, at).replace(/^\n+|\n+$/g, '');
    if (text.trim()) pieces.push({ kind: 'text', text });
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'tools') last.tools.push(tool);
    else pieces.push({ kind: 'tools', tools: [tool] });
    from = at;
  }
  const tail = content.slice(from).replace(/^\n+|\n+$/g, '');
  if (tail.trim()) pieces.push({ kind: 'text', text: tail });
  return pieces;
}
