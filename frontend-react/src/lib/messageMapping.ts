import type { ChatMessage } from '@/stores/chat';
import type { Message, VoiceMeta } from '@/lib/tauri';

// Send only role + content to the backend.
// Strip UI metadata (thinking, thinkingDurationMs, etc.).
// Note: we send the assistant's *answer* only — thinking content is NOT
// part of the conversation history passed to the model. The model gets the
// transcript via `content`, so voice metadata is intentionally not sent here.
export function toIpcMessage(m: ChatMessage): Message {
  return {
    role: m.role,
    content: m.content,
    ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
  };
}

// Voice metadata crosses the IPC boundary as snake_case (Rust `VoiceMeta`),
// but the in-memory `ChatMessage.voice` is camelCase. These bridge the two.
export function voiceToPersisted(v: ChatMessage['voice']): VoiceMeta | undefined {
  if (!v) return undefined;
  return { audio_path: v.audioPath, duration_ms: v.durationMs, transcript: v.transcript, peaks: v.peaks };
}

export function voiceFromPersisted(v: VoiceMeta | null | undefined): ChatMessage['voice'] | undefined {
  if (!v) return undefined;
  return { audioPath: v.audio_path, durationMs: v.duration_ms, transcript: v.transcript, peaks: v.peaks };
}
