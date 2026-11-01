import { useCallback } from 'react';
import { useChat } from '@/stores/chat';
import { useCinderpawSendMessage } from '@/hooks/useCinderpaw';
import { useNotifications } from '@/stores/notifications';

/** `[Image attached: name]` note lines, which the send path regenerates itself. */
const IMAGE_NOTE_RE = /^\[Image attached: ([^\]]*)\]\s*$/gm;

/**
 * Send a user turn again: the Retry under a reply, and Save under an edited
 * message. Everything from that turn onwards is dropped first, because the
 * answers below it were answers to the old question.
 *
 * It routes the same way the composer does, to the agent. StreamErrorNotice's
 * retry comes through here too, so there is one resend in the app instead of
 * one per button.
 */
export function useResendTurn() {
  const sessionId = useChat((s) => s.sessionId);
  const sendAgent = useCinderpawSendMessage(sessionId);

  const resend = useCallback(
    async (fromIndex: number, newText?: string, confirmed = false) => {
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

      // Redoing an older turn drops every exchange after it. Retry on the last
      // reply drops nothing else and goes at once; further up it asks first,
      // with the count (Hermes asks the same, 1 Nov).
      const later = messages.slice(userIndex + 1).filter((m) => m.role === 'user').length;
      if (later > 0 && !confirmed) {
        useNotifications.getState().push(
          'info',
          `This removes the ${later === 1 ? 'reply' : `${later} replies`} after it`,
          newText === undefined ? 'Retrying here starts the chat again from this message.' : 'Saving the edit starts the chat again from this message.',
          { label: newText === undefined ? 'Retry anyway' : 'Save anyway', run: () => void resend(fromIndex, newText, true) },
        );
        return;
      }

      // Everything from this turn down goes, including the turn itself: the
      // send path writes the user message again, and a half-kept history is
      // what makes a retry produce two copies of the question.
      useChat.setState({
        messages: messages.slice(0, userIndex),
        streamStatus: 'idle',
        streamError: null,
      });

      await sendAgent(text, images.length > 0 ? images : undefined);
    },
    [sendAgent],
  );
  return useCallback((fromIndex: number, newText?: string) => resend(fromIndex, newText), [resend]);
}
