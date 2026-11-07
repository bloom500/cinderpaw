/**
 * Shared attachment pipeline for the chat input.
 *
 * Three entry points produce the same `AttachedFile` shape:
 *   - file picker (FileAttachButton)            → OS path
 *   - drag & drop onto the input (Tauri event)  → OS path
 *   - Ctrl+V paste (screenshots, copied files)  → DOM File/Blob
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

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
  if (VIDEO_EXT.test(name)) {
    // Never read: the extractor would load the whole video only to find no
    // text. The model gets the path, as for any binary; the composer gets a
    // first frame, or the name chip when the preview is refused.
    const videoUrl = (await videoPreviewUrl(path)) ?? undefined;
    return { name, path, content: null, kind: 'binary', videoUrl };
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
  // The bytes travel as one base64 string: as an array of numbers a 45 MB video
  // froze the app (29 Oct 2026).
  const viaFile = async () => {
    const data = (await blobToDataUrl(file)).split(',')[1] ?? '';
    const staged = await invoke<string>('stage_pasted_file', { data, name: file.name || name });
    return { ...(await attachmentFromPath(staged)), name: file.name || name };
  };
  // A file dragged from Explorer arrives here, not as a path (dragDropEnabled is
  // off). A video is never read as text: it is copied to a temp file so it plays
  // in the composer and the chat and the agent can open it; past the copy limit
  // it still shows, from memory, until the page reloads.
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) {
    if (file.size <= STAGE_MAX) {
      try { return await viaFile(); } catch { /* the in-memory preview below */ }
    }
    // ponytail: the object URL lives until the page reloads; revoke on remove if many big drops matter.
    return { name: file.name || name, path, content: null, kind: 'binary', videoUrl: URL.createObjectURL(file) };
  }
  // Other big non-documents: never read as text on the page, that is the freeze.
  if (file.size > BIG_BYTES && !DOCUMENT.test(file.name) && !DOCUMENT_TYPES.includes(file.type)) {
    if (file.size <= STAGE_MAX) {
      try { return await viaFile(); } catch { /* attached by name below */ }
    }
    return { name: file.name || name, path, content: null, kind: 'binary' };
  }
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
const BIG_BYTES = 2 * 1024 * 1024;
/** Largest file copied to a temp folder from a drop or paste (stage_pasted_file says the same). */
const STAGE_MAX = 200 * 1024 * 1024;

export const isVideoName = (name: string) => VIDEO_EXT.test(name);

/** A local video as a URL the page may play, or null when it is gone or refused. */
export async function videoPreviewUrl(path: string): Promise<string | null> {
  try {
    await invoke('allow_video_preview', { path });
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/** One file on its way in: its name at once, its contents when they are read. */
export type PendingAttachment = { name: string; ready: Promise<AttachedFile> };

/**
 * Files from a paste or a drop, each with its name now so the composer can show
 * it before it is read. Returns [] for plain text pastes.
 */
export function pendingFromClipboard(data: DataTransfer): PendingAttachment[] {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files.map((f) => ({ name: f.name || 'screenshot.png', ready: attachmentFromDomFile(f) }));
}

/** Files by path (the picker, Send to), each with its name now. */
export function pendingFromPaths(paths: string[]): PendingAttachment[] {
  return paths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, ready: attachmentFromPath(p) }));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
