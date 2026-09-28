import { create } from 'zustand';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { tauri, type Project, type ProjectFile } from '@/lib/tauri';
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
  /** Spec 9: added to the system prompt of every chat in the project. */
  setInstructions: (projectId: string, text: string) => Promise<void>;
  /** Pick files and copy them into the project's folder. */
  addFiles:   (projectId: string) => Promise<void>;
  removeFile: (projectId: string, name: string) => Promise<void>;
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

  setInstructions: async (projectId, text) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project || (project.instructions ?? '') === text) return;
    await reportFailure(`Could not save the instructions for ${project.name}`, async () => {
      await tauri.projects.save(projectId, project.name, project.conversation_ids, { instructions: text });
      await get().refresh();
    });
  },

  addFiles: async (projectId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    const picked = await openFileDialog({ multiple: true });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    await reportFailure(`Could not add the file to ${project.name}`, async () => {
      const added: ProjectFile[] = [];
      try {
        for (const path of paths) added.push(await tauri.projects.addFile(projectId, path));
      } finally {
        // The copies that made it are listed even when a later one failed, so
        // none of them sits in the folder unknown to the agent.
        if (added.length > 0) {
          await tauri.projects.save(projectId, project.name, project.conversation_ids, { files: [...(project.files ?? []), ...added] });
          await get().refresh();
        }
      }
    });
  },

  removeFile: async (projectId, name) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    await reportFailure(`Could not remove ${name}`, async () => {
      await tauri.projects.removeFile(projectId, name);
      await tauri.projects.save(projectId, project.name, project.conversation_ids, {
        files: (project.files ?? []).filter((f) => f.name !== name),
      });
      await get().refresh();
    });
  },
}));
