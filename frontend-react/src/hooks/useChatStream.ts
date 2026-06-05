import { useMemo, useCallback } from 'react';
import type { Message, InferParams } from '@/lib/tauri';
import type { CloudModel } from '@/stores/model';
import {
  startChatStream,
  requestStreamStop,
  type ChatStreamHandlers,
} from '@/lib/chatStream';

type Callbacks = ChatStreamHandlers;

/**
 * Thin React-flavoured wrapper around the global chat stream manager.
 *
 * All state and listeners live in `lib/chatStream`, so this hook has no
 * lifecycle to manage — the stream keeps running when the component that
 * called it (ChatInput) unmounts on tab switch. The previous implementation
 * stopped the backend stream on unmount, which silently killed the
 * generation whenever the user left `/chat` mid-response.
 */
export function useChatStream(externalSessionId?: string) {
  const internalId = useMemo(() => crypto.randomUUID(), []);
  const sessionId = externalSessionId ?? internalId;

  const start = useCallback(
    async (messages: Message[], params: InferParams, cb: Callbacks) => {
      await startChatStream(sessionId, messages, params, null, cb);
    },
    [sessionId],
  );

  const startCloud = useCallback(
    async (cloud: CloudModel, messages: Message[], params: InferParams, cb: Callbacks) => {
      await startChatStream(sessionId, messages, params, cloud, cb);
    },
    [sessionId],
  );

  const stop = useCallback(async () => {
    await requestStreamStop(sessionId);
  }, [sessionId]);

  return { start, startCloud, stop, sessionId };
}
