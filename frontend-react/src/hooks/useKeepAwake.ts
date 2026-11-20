import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useChat } from '@/stores/chat';

/**
 * The computer stays awake while a reply is being made (see keep_awake.rs).
 * Subscribed once at the app root. ponytail: follows the chat on screen; a
 * scheduled task running with no chat open is not covered yet.
 */
export function useKeepAwake(): void {
  useEffect(() => {
    let on = false;
    const set = (next: boolean) => {
      if (next === on) return;
      on = next;
      // No host (a browser build, a test): nothing to hold.
      void invoke('keep_awake', { on }).catch(() => {});
    };
    set(useChat.getState().streamStatus === 'streaming');
    const off = useChat.subscribe((s) => set(s.streamStatus === 'streaming'));
    return () => { off(); set(false); };
  }, []);
}
