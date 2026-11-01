import { useEffect } from 'react';
import { useChat } from '@/stores/chat';
import { useBrowser } from '@/stores/browser';
import { tauri } from '@/lib/tauri';

/**
 * When a reply ends, the agent's finished browser tabs close: all but the one
 * in front and those holding a form it filled for the person (browser.rs,
 * `close_agent_tabs`). Ten job links had left ten pages in memory (1 Nov).
 * ponytail: follows the chat on screen; a task in a chat you are not looking at
 * tidies up at the next reply here.
 */
export function useTidyAgentTabs(): void {
  useEffect(() => {
    let was = useChat.getState().streamStatus;
    return useChat.subscribe((s) => {
      const ended = was === 'streaming' && s.streamStatus !== 'streaming';
      was = s.streamStatus;
      if (!ended || !useBrowser.getState().tabs.some((t) => t.agent)) return;
      void tauri.browser.ui('close_agent_tabs').catch(() => {});
    });
  }, []);
}
