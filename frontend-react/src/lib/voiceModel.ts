import { tauri } from '@/lib/tauri';

/**
 * Ensure the whisper ggml model for `size` is on disk. Returns `'ready'` if it
 * is already present, otherwise kicks off a dedicated whisper download (into the
 * whisper dir, progress over `cinderpaw://whisper-download-*`) and returns
 * `'downloading-started'`.
 *
 * NOTE: this must NOT reuse the LLM `download_model` command — that writes to
 * the models dir and makes the frontend auto-load the file as a llama.cpp model.
 */
export async function ensureWhisperModel(
  size: 'small' | 'base',
): Promise<'ready' | 'downloading-started'> {
  if (await tauri.voice.modelPresent(size)) return 'ready';
  await tauri.voice.downloadModel(size);
  return 'downloading-started';
}
