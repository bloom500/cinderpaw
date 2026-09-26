/**
 * Whether the prose an agent wrote right before a tool call is a working note
 * ("Let me check what is really installed.") rather than part of its answer.
 *
 * Seen 26 Sep with openrouter/stealth/space-bunny-alpha: a model that narrates
 * before every call ended up with its answer opening on "Hai să verific ce e
 * real... Greșea mea, am scris notebook.ctx... Cer lista direct:", because
 * every segment before a tool was joined into the reply. The person reads that
 * as the model's thinking thrown into the chat. A note belongs beside the step
 * it introduces, in the chain above the answer.
 *
 * Only SHORT, single-paragraph prose counts. Joining the segments exists
 * because some models write the real answer and then call a tool, and dropping
 * those segments left "Done." as the whole reply; an answer has length or
 * structure (paragraphs, a list, a heading, a table, code), a note has neither.
 *
 * ponytail: a length-and-shape heuristic. A one-sentence answer written before
 * a tool and followed by more prose lands in the chain; if that is ever seen,
 * the sidecar marking each segment's purpose is the upgrade.
 */
const MAX_NOTE_CHARS = 280;

export function isWorkingNote(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_NOTE_CHARS) return false;
  // A blank line, or a line opening a heading, list, quote, table or fence.
  return !/\n\s*\n|^\s*(?:#|[-*+] |\d+[.)] |>|\||```)/m.test(t);
}
