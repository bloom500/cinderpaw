import { create } from 'zustand';
import { tauri } from '@/lib/tauri';

/**
 * "Notion is connected": one moment for every new connection, from any page
 * or from the chat (Darius, 22 Oct: after connecting, nothing said it worked).
 */
export interface Connected {
  name: string;
  /** Which logo to show beside Cinderpaw's: a catalog or connector id; the name is tried too. */
  logoId?: string;
  /** The line under the title; without it, the dialog says what the tools allow. */
  body?: string;
  /** Ability names to show. With only `mcpId`, the dialog asks the extension. */
  tools?: string[];
  mcpId?: string;
  /** Put in a new chat by "Try it in a chat"; no button without it. */
  prompt?: string;
}

export const useConnected = create<{ item: Connected | null; show: (c: Connected) => void; close: () => void }>(
  (set) => ({
    item: null,
    show: (item) => {
      set({ item });
      // The person is usually still in the browser tab or on their phone.
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => {});
    },
    close: () => set({ item: null }),
  }),
);

/**
 * A chat app (Discord, Telegram, WhatsApp...) is announced only once the
 * engine reports it online: a saved token proves nothing. Resolves with the
 * engine's reason when it did not come up, null otherwise.
 *
 * For the first seconds a "not online" can still be the report from before
 * this save, so only a success counts that early.
 */
export async function announceWhenLive(id: string, ms = 30_000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    await new Promise((r) => setTimeout(r, 1_500));
    const row = (await tauri.connectors.list().catch(() => [])).find((c) => c.id === id);
    if (!row?.enabled) return null;
    if (row.live === true) {
      useConnected.getState().show({ name: row.name, logoId: row.id, body: `Message Cinderpaw on ${row.name} to try it. It answers there.` });
      return null;
    }
    if (row.live === false && row.liveError && Date.now() - started > 6_000) return row.liveError;
  }
  return null;
}

/** Whether `id` is online right now, so a save of a running bot is not announced again. */
export async function isLive(id: string): Promise<boolean> {
  const row = (await tauri.connectors.list().catch(() => [])).find((c) => c.id === id);
  return row?.live === true;
}
