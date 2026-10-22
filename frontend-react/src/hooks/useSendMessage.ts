// What the composer and the call loops share: the message body with its files,
// and the voice recording's save and transcription. The file keeps its old name
// because the chat-mode send hook it was named after is gone, and
// `useCallSession.ts`, which imports from here, is pinned.
import { tauri } from '@/lib/tauri';
import { useUI } from '@/stores/ui';
import { resolveSttModel } from '@/lib/voiceModel';
import { decodeToPcm16k } from '@/lib/audio';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

/**
 * A filename or path, made safe to put inside a marker in the prompt.
 *
 * These were interpolated raw, so a file whose NAME contains a closing marker
 * and a newline could end the block the model is reading and start giving it
 * instructions instead. The person who dropped the file is not necessarily the
 * person who named it — it may have arrived by email, download or connector.
 *
 * Control characters go, the marker brackets go, and the length is capped.
 * What is left still reads as the filename to a person.
 */
function safeMarkerText(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/[[\]]/g, '')
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned || 'unnamed';
}

export function buildUserContent(text: string, files: AttachedFile[]): string {
  const textFiles = files.filter((f) => f.content !== null);
  const imageFiles = files.filter((f) => f.kind === 'image' && f.dataUrl);
  // Binary files with no extractable text still reach the model as a path
  // reference (the agent can read them with its file tools). Previously these
  // were silently dropped — "I uploaded a file but it never reached you".
  const binaryFiles = files.filter((f) => f.content === null && f.kind !== 'image');
  if (textFiles.length === 0 && imageFiles.length === 0 && binaryFiles.length === 0) return text;
  const blocks = [
    // Closing marker lets the chat bubble reliably strip the inlined content
    // back out for display (showing a "Cinderpaw.pdf" chip instead of the whole
    // file) — see parseUserAttachments(). It also gives the model a clear file
    // boundary. Keep the marker format in sync with that parser.
    ...textFiles.map((f) => {
      const name = safeMarkerText(f.name);
      return `[File: ${name}]\n${f.content}\n[/File: ${name}]`;
    }),
    // Text-only models can't see pixels — note the attachment so the model
    // can at least acknowledge it instead of silently ignoring the upload.
    ...imageFiles.map((f) => `[Image attached: ${safeMarkerText(f.name)}]`),
    ...binaryFiles.map((f) =>
      f.path.startsWith('clipboard://')
        ? `[File attached: ${safeMarkerText(f.name)} (binary, no extractable text)]`
        : `[File attached: ${safeMarkerText(f.name)} (binary file at path: ${safeMarkerText(f.path)}). If you have file tools, you can read it from that path.]`,
    ),
  ];
  return `${blocks.join('\n\n')}\n\n${text}`;
}

/**
 * Persist a recorded blob to disk and return its on-disk asset path. Fast (a
 * single file write), so the caller can show the voice bubble immediately and
 * transcribe afterwards.
 */
export async function saveVoiceBlobToDisk(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
  console.log('[voice] saveVoiceBlob', { blobSize: blob.size, blobType: blob.type, ext, bytes: buf.length });
  const audioPath = await tauri.voice.saveBlob(Array.from(buf), ext);
  console.log('[voice] saved blob ->', audioPath);
  return audioPath;
}

/**
 * Transcribe a recorded blob. Routes by the chosen STT provider:
 *  - `groq` → cloud whisper-large-v3 (uploads the saved file; needs a key).
 *  - local (default) → decode to 16 kHz PCM + on-device whisper.
 * Slow either way, so it runs in the background after the optimistic bubble is
 * on screen. Errors ("stt-no-key" | "stt-cloud-failed" | "model-missing" |
 * "voice-unavailable") propagate to the caller for toast handling.
 */
export async function transcribeVoiceBlob(blob: Blob, audioPath: string, context?: string, language?: string): Promise<string> {
  const { sttProvider } = useUI.getState();
  if (sttProvider && sttProvider !== 'local') {
    // No language is ever sent. Whisper's `language` is an ORDER, not a hint:
    // an English UI once forced `language=en` on Romanian speech and turned
    // "Salut, Cinderpaw" into "Pozdvormiu Română!", and a stored preference is the
    // same mistake with the user's name on it. Detection runs per request, so a
    // wrong guess costs one turn instead of every turn after it.
    // `context`: the earlier part of the same sentence, a hint that keeps the
    // language and the names steady across partials (cloud only; the local
    // engine has no such input).
    // The one exception: a call whose language the person picked on the call
    // screen, where they see it every time (`callLanguage`).
    const transcript = await tauri.voice.transcribeCloud(audioPath, sttProvider, language, context);
    console.log('[voice] cloud transcript ->', JSON.stringify(transcript));
    return transcript;
  }
  // Resolved here rather than read from the store: the stored id may name a
  // model this build has no engine for, and `null` means there is no local
  // engine at all — which is the same sentinel the Rust side would answer with,
  // reached without decoding the audio first.
  const model = await resolveSttModel();
  if (!model) throw new Error('voice-unavailable');
  const pcm = await decodeToPcm16k(blob);
  console.log('[voice] transcribe decoded', { pcmLength: pcm.length });
  const transcript = await tauri.voice.transcribe(Array.from(pcm), model);
  console.log('[voice] transcript ->', JSON.stringify(transcript));
  return transcript;
}
