/**
 * Reverse of buildUserContent(): pulls the inlined attachment blocks back out
 * of a persisted user message so the chat bubble can render compact file chips
 * (e.g. "Feral.pdf") instead of dumping the whole extracted file content.
 *
 * Marker formats produced by buildUserContent (keep in sync):
 *   - text file:   [File: NAME]\n<content>\n[/File: NAME]
 *   - binary file: [File attached: NAME — <note>]
 *   - image:       [Image attached: NAME]
 *
 * Works on persisted content alone (no extra metadata needed), so chips
 * survive a reload. Older messages saved before the closing-marker format
 * simply fall through unchanged — no migration required.
 */

export interface DisplayAttachment {
  name: string;
  kind: 'text' | 'binary' | 'image';
}

export interface ParsedUserContent {
  attachments: DisplayAttachment[];
  /** The user's typed text, with all attachment blocks/notes removed. */
  text: string;
}

export function parseUserAttachments(content: string): ParsedUserContent {
  const attachments: DisplayAttachment[] = [];
  let text = content;

  // Text-file blocks. The \1 backreference requires the closing marker to name
  // the same file, so file content that happens to contain "[File: x]" can't
  // prematurely terminate the block.
  text = text.replace(
    /\[File: ([^\]\n]+)\]\n[\s\S]*?\n\[\/File: \1\]/g,
    (_m, name: string) => {
      attachments.push({ name, kind: 'text' });
      return '';
    },
  );

  // Binary file notes (single line).
  text = text.replace(
    /\[File attached: ([^\]\n]+?) — [^\]\n]*\]/g,
    (_m, name: string) => {
      attachments.push({ name, kind: 'binary' });
      return '';
    },
  );

  // Image notes (single line). Real pixels, when still in memory, are rendered
  // as thumbnails by the caller; these chips are the post-reload fallback.
  text = text.replace(/\[Image attached: ([^\]\n]+)\]/g, (_m, name: string) => {
    attachments.push({ name, kind: 'image' });
    return '';
  });

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { attachments, text };
}
