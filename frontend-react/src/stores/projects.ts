import { create } from 'zustand';
import { tauri, type Project } from '@/lib/tauri';
import { reportFailure } from '@/stores/notifications';

export type { Project };

interface ProjectsStore {
  list: Project[];
  /** Whether the first read has come back — win or lose. Without this the
   *  Projects page cannot tell "you have none" from "we have not looked yet",
   *  and it showed the fresh-install sentence to people with a dozen. Same
   *  contract as `useConversations.loaded`. */
  loaded: boolean;
  refresh:    () => Promise<void>;
  create:     (name: string) => Promise<void>;
  delete:     (id: string) => Promise<void>;
  rename:     (id: string, name: string) => Promise<void>;
  addChat:    (projectId: string, convId: string) => Promise<void>;
  removeChat: (projectId: string, convId: string) => Promise<void>;
}

export const useProjects = create<ProjectsStore>((set, get) => ({
  list: [],
  loaded: false,

  refresh: async () => {
    try {
      const list = await tauri.projects.list();
      set({ list, loaded: true });
    } catch (err) {
      // A read that fails is still a read that finished. Leaving `loaded`
      // false parks the page on a skeleton forever, which tells the person
      // less than an honest empty list does. Three call sites reach this
      // without a `.catch`, so it has to be caught here.
      set({ loaded: true });
      console.error('[projects] refresh failed:', err);
    }
  },

  // Every mutation below reports its own failure on screen — see
  // `reportFailure`. None of the call sites did: the dialogs and menu items
  // either had no `catch` at all or sent it to `console.error`, so with the
  // backend down a rename looked like it worked and quietly did not.

  create: async (name) => {
    await reportFailure('Could not create the project', async () => {
      const id = crypto.randomUUID();
      await tauri.projects.save(id, name, []);
      await get().refresh();
    });
  },

  // delete and rename throw ON PURPOSE: both are driven by a dialog that
  // catches, stays open and prints the reason where the person is already
  // looking. That beats a toast over a dialog that has already closed.
  delete: async (id) => {
    await tauri.projects.delete(id);
    await get().refresh();
  },

  rename: async (id, name) => {
    const project = get().list.find((p) => p.id === id);
    if (!project) return;
    await tauri.projects.save(id, name, project.conversation_ids);
    await get().refresh();
  },

  addChat: async (projectId, convId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    if (project.conversation_ids.includes(convId)) return;
    await reportFailure(`Could not move the chat into ${project.name}`, async () => {
      await tauri.projects.save(projectId, project.name, [...project.conversation_ids, convId]);
      await get().refresh();
    });
  },

  removeChat: async (projectId, convId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    await reportFailure(`Could not remove the chat from ${project.name}`, async () => {
      await tauri.projects.save(projectId, project.name,
        project.conversation_ids.filter((id) => id !== convId));
      await get().refresh();
    });
  },
}));
