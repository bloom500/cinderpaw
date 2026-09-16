import { useCallback } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useCinderpawSendMessage } from '@/hooks/useCinderpaw';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

/** `[Image attached: name]` note lines, which the send path regenerates itself. */
const IMAGE_NOTE_RE = /^\[Image attached: ([^\]]*)\]\s*$/gm;

/**
 * Send a user turn again: the Retry under a reply, and Save under an edited
 * message. Everything from that turn onwards is dropped first, because the
 * answers below it were answers to the old question.
 *
 * It routes the same way the composer does. The retry inside StreamErrorNotice
 * only ever called the chat path, so pressing Retry in agent mode sent the turn
 * past the agent to the local model; that notice now comes through here too, so
 * there is one resend in the app instead of one per button.
 */
export function useResendTurn() {
  const sendChat = useSendMessage();
  const sessionId = useChat((s) => s.sessionId);
  const sendAgent = useCinderpawSendMessage(sessionId);

  return useCallback(
    async (fromIndex: number, newText?: string) => {
      const { messages } = useChat.getState();
      // Retry sits under a reply and passes the row above it, which is usually
      // the question but not always: a tool-only turn, or an ask_user card, can
      // sit between. Walk up to the last thing the user actually said.
      let userIndex = Math.min(fromIndex, messages.length - 1);
      while (userIndex >= 0 && messages[userIndex]?.role !== 'user') userIndex--;
      const user = messages[userIndex];
      if (!user) return;

      const images = user.images ?? [];
      const text = (newText ?? user.content)
        .replace(IMAGE_NOTE_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!text && images.length === 0) return;

      // Everything from this turn down goes, including the turn itself: the
      // send path writes the user message again, and a half-kept history is
      // what makes a retry produce two copies of the question.
      useChat.setState({
        messages: messages.slice(0, userIndex),
        streamStatus: 'idle',
        streamError: null,
      });

      if (useUI.getState().inputMode === 'agent') {
        await sendAgent(text, images.length > 0 ? images : undefined);
        return;
      }

      // The chat path takes files, not data URLs; the names live in the note
      // lines that were just stripped out of the text.
      const names = [...user.content.matchAll(IMAGE_NOTE_RE)].map((m) => m[1]);
      const files: AttachedFile[] = images.map((dataUrl, n) => ({
        name: names[n] ?? `image-${n + 1}.png`,
        path: `resend://${n}`,
        content: null,
        kind: 'image',
        dataUrl,
      }));
      await sendChat(text, files);
    },
    [sendAgent, sendChat],
  );
}
