import { useEffect } from 'react';
import { useChat } from '@/stores/chat';
import { useBrowser } from '@/stores/browser';
import { useNotifications } from '@/stores/notifications';
import { tauri } from '@/lib/tauri';

/**
 * When a reply ends, the agent's finished browser tabs close: all but the one
 * in front, those holding a form it filled for the person, and any the person
 * went to (browser.rs, `close_agent_tabs`). Ten job links had left ten pages in
 * memory (1 Nov). It says so, with Reopen: tabs that vanish without a word
 * leave the person wondering where they went.
 * ponytail: follows the chat on screen; a task in a chat you are not looking at
 * tidies up at the next reply here.
 */
export function useTidyAgentTabs(): void {
  useEffect(() => {
    let was = useChat.getState().streamStatus;
    return useChat.subscribe((s) => {
      const ended = was === 'streaming' && s.streamStatus !== 'streaming';
      was = s.streamStatus;
      const before = useBrowser.getState().tabs.filter((t) => t.agent);
      if (!ended || before.length === 0) return;
      void tauri.browser
        .ui('close_agent_tabs')
        .then((st) => {
          const left = new Set(((st as { tabs?: Array<{ id: number }> }).tabs ?? []).map((t) => t.id));
          const urls = before.filter((t) => !left.has(t.id) && t.url).map((t) => t.url);
          if (urls.length === 0) return;
          // Ctrl+Shift+T brings them back one by one, like any closed tab.
          useBrowser.setState((b) => ({ closed: [...urls, ...b.closed].slice(0, 20) }));
          useNotifications.getState().push(
            'info',
            `Cinderpaw closed ${urls.length === 1 ? 'a tab' : `${urls.length} tabs`} it was done with`,
            'Tabs you went to, and forms it filled in for you, stay open.',
            {
              label: 'Reopen',
              run: () => void (async () => {
                const b = useBrowser.getState();
                for (const url of urls) {
                  await b.newTab();
                  await b.open(url);
                }
                useBrowser.setState((x) => ({ closed: x.closed.filter((u) => !urls.includes(u)) }));
              })(),
            },
          );
        })
        .catch(() => {});
    });
  }, []);
}
