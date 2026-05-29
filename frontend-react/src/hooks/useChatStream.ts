import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { tauri, events, type Message, type InferParams } from '@/lib/tauri';

type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'stopped';

type Callbacks = {
  onToken:    (text: string) => void;
  onDone:     () => void;
  onError:    (err: string) => void;
  onStopped?: () => void;
};

export function useChatStream(externalSessionId?: string) {
  const internalId = useMemo(() => crypto.randomUUID(), []);
  const sessionId = externalSessionId ?? internalId;

  const unlistensRef = useRef<UnlistenFn[]>([]);
  const statusRef = useRef<StreamStatus>('idle');

  const teardown = useCallback(() => {
    unlistensRef.current.forEach((fn) => fn());
    unlistensRef.current = [];
  }, []);

  const stop = useCallback(async () => {
    if (statusRef.current === 'streaming') {
      statusRef.current = 'stopped';
      await tauri.chat.stop();
    }
  }, []);

  const start = useCallback(
    async (messages: Message[], params: InferParams, cb: Callbacks) => {
      if (statusRef.current === 'streaming') {
        console.warn('useChatStream: starting new stream while previous still streaming — auto-stopping');
        await stop();
        teardown();
      }

      statusRef.current = 'streaming';

      // Register listeners BEFORE invoking — race-safe (spec §2.4)
      const unlistens = await Promise.all([
        events.tokenEvent.listen((e) => {
          if (e.payload.sessionId !== sessionId) return;
          cb.onToken(e.payload.text);
        }),
        events.streamDoneEvent.listen((e) => {
          if (e.payload.sessionId !== sessionId) return;
          if (statusRef.current === 'stopped') { cb.onStopped?.(); return; }
          statusRef.current = 'done';
          cb.onDone();
        }),
        events.streamErrorEvent.listen((e) => {
          if (e.payload.sessionId !== sessionId) return;
          statusRef.current = 'error';
          cb.onError(e.payload.error);
        }),
      ]);
      unlistensRef.current = unlistens;

      try {
        await tauri.chat.stream(messages, params, sessionId);
      } finally {
        teardown();
      }
    },
    [sessionId, stop, teardown],
  );

  // Unmount safety: stop in-flight stream and clean up listeners (spec §2 amendment)
  useEffect(
    () => () => {
      if (statusRef.current === 'streaming') {
        void tauri.chat.stop();
      }
      teardown();
    },
    [teardown],
  );

  return { start, stop, sessionId };
}
