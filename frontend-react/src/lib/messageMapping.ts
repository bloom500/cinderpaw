import type { ChatMessage } from '@/stores/chat';
import type { Message } from '@/lib/tauri';

// Send only role + content to the backend.
// Strip UI metadata (thinking, thinkingDurationMs, etc.).
// Note: we send the assistant's *answer* only — thinking content is NOT
// part of the conversation history passed to the model.
export function toIpcMessage(m: ChatMessage): Message {
  return { role: m.role, content: m.content };
}
