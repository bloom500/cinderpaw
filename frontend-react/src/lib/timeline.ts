import type { ToolActivity } from '@/hooks/useLiveToolActivity';

export type TimelinePiece =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: ToolActivity[] }
  | { kind: 'steer'; text: string };

/** What the person added while the reply was written: where the text stood, and
 *  how many tools had started, when the model read it. */
export interface Steer { text: string; at: number; afterTools: number }

/**
 * A reply in the order it happened: what the agent said, the tools it then
 * called, what it said next. Each tool carries `at`, the length of the reply's
 * text when it was called, so the text is cut there and the tools go between.
 * Tools called back to back, with nothing said between them, share one group.
 *
 * Null when any tool has no `at` (a reply saved before 27 Sep, or plain chat):
 * those keep the old layout, steps above and the answer below.
 */
export function timeline(content: string, tools: ToolActivity[], steers: Steer[] = []): TimelinePiece[] | null {
  if (tools.length + steers.length === 0 || tools.some((a) => a.at === undefined)) return null;
  const pieces: TimelinePiece[] = [];
  let from = 0;
  const cut = (offset: number) => {
    // Never backwards, never past the end: a reply replaced at the end of the
    // turn (the sidecar's final text) can be shorter than the offsets were.
    const at = Math.min(Math.max(offset, from), content.length);
    const text = content.slice(from, at).replace(/^\n+|\n+$/g, '');
    if (text.trim()) pieces.push({ kind: 'text', text });
    from = at;
  };
  // An addition goes where it was read: after the tools started before it. At the
  // same text offset as a tool, `afterTools` alone says which came first.
  const steersBefore = (n: number) => {
    for (const s of steers) if (s.afterTools === n) { cut(s.at); pieces.push({ kind: 'steer', text: s.text }); }
  };
  tools.forEach((tool, i) => {
    steersBefore(i);
    cut(tool.at!);
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'tools') last.tools.push(tool);
    else pieces.push({ kind: 'tools', tools: [tool] });
  });
  for (const s of steers) if (s.afterTools >= tools.length) { cut(s.at); pieces.push({ kind: 'steer', text: s.text }); }
  const tail = content.slice(from).replace(/^\n+|\n+$/g, '');
  if (tail.trim()) pieces.push({ kind: 'text', text: tail });
  return pieces;
}
