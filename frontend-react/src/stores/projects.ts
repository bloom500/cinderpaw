import { create } from 'zustand';
import { tauri, type Project } from '@/lib/tauri';

export type { Project };

interface ProjectsStore {
  list: Project[];
  refresh:    () => Promise<void>;
  create:     (name: string) => Promise<void>;
  delete:     (id: string) => Promise<void>;
  rename:     (id: string, name: string) => Promise<void>;
  addChat:    (projectId: string, convId: string) => Promise<void>;
  removeChat: (projectId: string, convId: string) => Promise<void>;
}

export const useProjects = create<ProjectsStore>((set, get) => ({
  list: [],

  refresh: async () => {
    const list = await tauri.projects.list();
    set({ list });
  },

  create: async (name) => {
    const id = crypto.randomUUID();
    await tauri.projects.save(id, name, []);
    await get().refresh();
  },

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
    await tauri.projects.save(projectId, project.name, [...project.conversation_ids, convId]);
    await get().refresh();
  },

  removeChat: async (projectId, convId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    await tauri.projects.save(projectId, project.name,
      project.conversation_ids.filter((id) => id !== convId));
    await get().refresh();
  },
}));
