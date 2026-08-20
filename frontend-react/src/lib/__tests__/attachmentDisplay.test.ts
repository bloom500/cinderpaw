import { describe, it, expect } from 'vitest';
import { parseUserAttachments } from '../attachmentDisplay';

describe('parseUserAttachments', () => {
  it('extracts a text file chip and leaves only the typed text', () => {
    const content = `[File: Feral.pdf]\nLorem ipsum\nmany lines\nof content\n[/File: Feral.pdf]\n\nWhat does this say?`;
    const { attachments, text } = parseUserAttachments(content);
    expect(attachments).toEqual([{ name: 'Feral.pdf', kind: 'text' }]);
    expect(text).toBe('What does this say?');
  });

  it('handles multiple text files', () => {
    const content =
      `[File: a.txt]\nAAA\n[/File: a.txt]\n\n[File: b.md]\nBBB\n[/File: b.md]\n\nsummarize both`;
    const { attachments, text } = parseUserAttachments(content);
    expect(attachments).toEqual([
      { name: 'a.txt', kind: 'text' },
      { name: 'b.md', kind: 'text' },
    ]);
    expect(text).toBe('summarize both');
  });

  it('does not terminate early on file content containing a fake marker', () => {
    const content = `[File: doc.txt]\nsee [File: other.txt] inline\nstill same file\n[/File: doc.txt]\n\nok`;
    const { attachments, text } = parseUserAttachments(content);
    expect(attachments).toEqual([{ name: 'doc.txt', kind: 'text' }]);
    expect(text).toBe('ok');
  });

  it('extracts binary file notes', () => {
    const clip = `[File attached: data.bin (binary, no extractable text)]\n\nlook at this`;
    expect(parseUserAttachments(clip)).toEqual({
      attachments: [{ name: 'data.bin', kind: 'binary' }],
      text: 'look at this',
    });
    const path = `[File attached: thing.zip (binary file at path: C:\\x\\thing.zip). If you have file tools, you can read it from that path.]\n\nunzip`;
    expect(parseUserAttachments(path)).toEqual({
      attachments: [{ name: 'thing.zip', kind: 'binary' }],
      text: 'unzip',
    });
  });

  it('extracts image notes (reload fallback)', () => {
    const content = `[Image attached: shot.png]\n\nwhat is this`;
    expect(parseUserAttachments(content)).toEqual({
      attachments: [{ name: 'shot.png', kind: 'image' }],
      text: 'what is this',
    });
  });

  it('returns plain text untouched when there are no attachments', () => {
    const { attachments, text } = parseUserAttachments('just a normal message');
    expect(attachments).toEqual([]);
    expect(text).toBe('just a normal message');
  });
});
