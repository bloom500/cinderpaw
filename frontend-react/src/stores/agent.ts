import { create } from 'zustand';
import { tauri, type AgentConfig } from '@/lib/tauri';

const STORAGE_KEY = 'feral_active_agent_id';

interface AgentStore {
  list: AgentConfig[];
  current: AgentConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /**
   * When set, the Agents tab is reopening this saved conversation, so AgentChat
   * must NOT start a fresh session on the accompanying agent change. Cleared by
   * AgentChat once that session is actually loaded.
   */
  reopenSessionId: string | null;

  refresh:     () => Promise<void>;
  setCurrent:  (id: string) => void;
  clear:       () => void;
  save:        (cfg: AgentConfig) => Promise<AgentConfig>;
  delete:      (id: string) => Promise<void>;
  setReopenSessionId: (id: string | null) => void;
}

function readPersistedId(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePersistedId(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be disabled — the in-memory state is still authoritative
    // for the current session, the user just won't get the agent pre-selected
    // on next launch.
  }
}

export const useAgent = create<AgentStore>((set, get) => ({
  list: [],
  current: null,
  loading: false,
  saving: false,
  error: null,
  reopenSessionId: null,

  setReopenSessionId: (id) => set({ reopenSessionId: id }),

  refresh: async () => {
    // Re-entrancy guard: if a refresh is already in flight, don't start
    // another. With the duplicate refresh() call removed from
    // AgentChat, this should be a no-op, but keep the guard as a
    // belt-and-braces protection against future regressions.
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const list = await tauri.agents.getAll();
      const persistedId = readPersistedId();
      const next =
        list.find((a) => a.id === persistedId) ?? list[0] ?? null;
      writePersistedId(next?.id ?? null);
      set({ list, current: next, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  setCurrent: (id) => {
    const found = get().list.find((a) => a.id === id) ?? null;
    writePersistedId(found?.id ?? null);
    set({ current: found });
  },

  clear: () => {
    writePersistedId(null);
    set({ current: null });
  },

  save: async (cfg) => {
    set({ saving: true, error: null });
    try {
      const saved = await tauri.agents.save(cfg);
      const list = await tauri.agents.getAll();
      writePersistedId(saved.id ?? null);
      set({
        list,
        current: saved,
        saving: false,
      });
      return saved;
    } catch (e) {
      set({ saving: false, error: String(e) });
      throw e;
    }
  },

  delete: async (id) => {
    await tauri.agents.delete(id);
    const list = get().list.filter((a) => a.id !== id);
    const wasCurrent = get().current?.id === id;
    const next = wasCurrent ? (list[0] ?? null) : get().current;
    writePersistedId(next?.id ?? null);
    set({ list, current: next });
  },
}));
