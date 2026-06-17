import { tauri } from '@/lib/tauri';

const REPO = 'ggerganov/whisper.cpp';
const FILE: Record<'small' | 'base', string> = {
  small: 'ggml-small.bin',
  base: 'ggml-base.bin',
};

/**
 * Ensure the whisper ggml model for `size` is on disk. Returns `'ready'` if it
 * is already present, otherwise kicks off the download (progress streams over
 * the existing `feral://download-*` events) and returns `'downloading-started'`.
 */
export async function ensureWhisperModel(
  size: 'small' | 'base',
): Promise<'ready' | 'downloading-started'> {
  if (await tauri.voice.modelPresent(size)) return 'ready';
  await tauri.download.start(REPO, FILE[size]);
  return 'downloading-started';
}

export const WHISPER_FILES = FILE;
export const WHISPER_REPO = REPO;
