import { CUBBY_LINES, type CubbyLineId } from './cubby-lines';
import manifest from './cubby-voice.json';

export interface VoiceEntry {
  text: string;
  model: string;
  voice: string;
  file: string;
}
export type VoiceManifest = Record<string, VoiceEntry>;

// Same pattern as lib/brandLogos.tsx: Vite bundles every MP3 in the folder and
// hands back its URL. An empty folder gives an empty record.
const FILES = import.meta.glob('../assets/voice/*.mp3', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The audio URL for a line, or null when no audio was made from its current words. */
export function resolveVoiceUrl(
  line: string,
  text: string,
  m: VoiceManifest,
  files: Record<string, string>,
): string | null {
  const entry = m[line];
  if (!entry || entry.text !== text) return null;
  return files[`../assets/voice/${entry.file}`] ?? null;
}

export const cubbyVoiceUrl = (line: CubbyLineId): string | null =>
  resolveVoiceUrl(line, CUBBY_LINES[line], manifest as VoiceManifest, FILES);
