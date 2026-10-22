/**
 * Shared attachment pipeline for the chat input.
 *
 * Three entry points produce the same `AttachedFile` shape:
 *   - file picker (FileAttachButton)            → OS path
 *   - drag & drop onto the input (Tauri event)  → OS path
 *   - Ctrl+V paste (screenshots, copied files)  → DOM File/Blob
 */

import { invoke } from '@tauri-apps/api/core';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Build an attachment from an OS path (picker or drag&drop).
 *
 * Every file type is accepted: images become data URLs, PDFs/Office docs go
 * through the Rust `extract_file_text` extractor, plain text is read as-is,
 * and anything with no extractable text is still attached as a `binary`
 * path reference — buildUserContent() turns that into a note the model (and
 * the agent's file tools) can act on. Nothing is silently dropped anymore.
 */
export async function attachmentFromPath(path: string): Promise<AttachedFile> {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (IMAGE_EXT.test(name)) {
    try {
      const dataUrl = await invoke<string>('read_file_as_data_url', { path });
      return { name, path, content: null, kind: 'image', dataUrl };
    } catch (err) {
      return { name, path, content: null, kind: 'binary', error: String(err) };
    }
  }
  try {
    const content = await invoke<string>('extract_file_text', { path });
    return { name, path, content };
  } catch (err) {
    // No extractable text (true binary) or extraction failed: attach as a
    // path reference instead of a dead "Unsupported format" chip.
    const msg = String(err);
    return {
      name,
      path,
      content: null,
      kind: 'binary',
      ...(msg.startsWith('binary:') ? {} : { error: msg }),
    };
  }
}

/** Build an attachment from a DOM File (clipboard paste / HTML5 drop). */
export async function attachmentFromDomFile(file: File): Promise<AttachedFile> {
  const path = `clipboard://${crypto.randomUUID()}`;
  const name =
    file.name && file.name !== 'image.png'
      ? file.name
      : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  if (file.type.startsWith('image/')) {
    try {
      const dataUrl = await blobToDataUrl(file);
      return { name, path, content: null, kind: 'image', dataUrl };
    } catch (err) {
      return { name, path, content: null, error: String(err) };
    }
  }
  // A document has no path here, so it never met the extractor a picked file
  // goes through: a pasted CV was read with file.text(), came out as junk and
  // reached the agent as "binary, no extractable text" (6 Oct 2026). Saved to
  // a temp file first, it takes the picked-file road and the agent gets a path.
  const viaFile = async () => {
    const staged = await invoke<string>('stage_pasted_file', {
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      name: file.name || name,
    });
    return { ...(await attachmentFromPath(staged)), name: file.name || name };
  };
  try {
    if (DOCUMENT.test(file.name) || DOCUMENT_TYPES.includes(file.type)) return await viaFile();
    const content = await file.text();
    // Other pasted binaries survive file.text() but come out as mojibake: the
    // tell-tale replacement chars / NULs send them the file road too.
    const sample = content.slice(0, 2000);
    const junk = (sample.match(/[\uFFFD\u0000]/g) ?? []).length;
    if (sample.length > 0 && junk / sample.length > 0.05) return await viaFile();
    return { name: file.name || name, path, content };
  } catch {
    return { name: file.name || name, path, content: null, kind: 'binary' };
  }
}

const DOCUMENT = /\.(pdf|docx|pptx|xlsx|odt)$/i;
const DOCUMENT_TYPES = ['application/pdf'];

/** Extract attachable files from a paste event. Returns [] for plain text pastes. */
export async function attachmentsFromClipboard(
  data: DataTransfer,
): Promise<AttachedFile[]> {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return Promise.all(files.map(attachmentFromDomFile));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
