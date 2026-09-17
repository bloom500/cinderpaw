import { create } from 'zustand';
import { tauri } from '@/lib/tauri';

/**
 * The workspace: everything the agent made that outlived its conversation.
 *
 * Two ways in, and the split matters. `artifact` events arrive UNPROMPTED from
 * the sidecar whenever anything changes, on any surface — so a report written
 * during a voice call, or asked for from Telegram, turns up here without the
 * panel polling for it. Requests (`list`, `open`, …) are the other half, and
 * every one is paired by a request id because several can be in flight and the
 * answers come back on the same stream as everything else.
 *
 * Why an id per request rather than "the last reply wins": opening a big
 * document while a list refresh is in flight would otherwise show the list's
 * empty `content` over the document, intermittently, on slower machines only.
 */

export interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  version: number;
  bytes: number;
  updatedAt: number;
  modifiedBy: string;
}

export interface ArtifactVersionRow {
  version: number;
  author: string;
  note: string | null;
  createdAt: number;
}

/** What the viewer is showing, including which version of it. */
export interface OpenArtifact {
  row: ArtifactRow;
  content: string;
  /** The version being shown, which is not always the newest one. */
  showing: number;
  versions: ArtifactVersionRow[];
}

type Pending =
  | { kind: 'list' }
  | { kind: 'open'; id: string; version?: number }
  | { kind: 'versions'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'delete'; id: string };

interface ArtifactsStore {
  /** Whether the panel is showing. Here rather than in the UI store because
   *  everything that opens it already has this store in hand. */
  panelOpen: boolean;
  rows: ArtifactRow[];
  /**
   * Whether the first read has come back, win or lose. Without it the panel
   * cannot tell "you have none" from "we have not looked yet" and shows the
   * fresh-install sentence to someone with a dozen — the same mistake the
   * Projects and Chats pages each had to be taught out of.
   */
  loaded: boolean;
  open: OpenArtifact | null;
  busy: boolean;
  error: string | null;
  /** Set after an export, so the panel can say where the file went. */
  lastExport: { path: string; note: string } | null;

  togglePanel: () => void;
  refresh: () => Promise<void>;
  openArtifact: (id: string) => Promise<void>;
  showVersion: (version: number) => Promise<void>;
  exportArtifact: (id: string) => Promise<void>;
  deleteArtifact: (id: string) => Promise<void>;
  close: () => void;
  /** Called by the event stream. */
  /**
   * Called by the event stream. `onScreen` is true when the change came from
   * the conversation currently on screen (the event's session is the chat's).
   */
  onEvent: (e: { id: string; action: 'created' | 'updated' | 'deleted'; onScreen?: boolean }) => void;
  onResult: (e: {
    id: string; ok: boolean; items?: ArtifactRow[]; content?: string;
    versions?: ArtifactVersionRow[]; path?: string; note?: string; error?: string;
  }) => void;
}

const pending = new Map<string, Pending>();
let seq = 0;
const nextId = () => `artifact-${Date.now()}-${++seq}`;

async function send(
  p: Pending,
  action: 'list' | 'get' | 'versions' | 'export' | 'delete',
  opts: { artifactId?: string; version?: number } = {},
): Promise<void> {
  const id = nextId();
  pending.set(id, p);
  try {
    await tauri.artifacts.op(id, action, opts);
  } catch (e) {
    // The command itself failed, so no reply is ever coming and the entry
    // would sit in the map forever holding the panel busy.
    pending.delete(id);
    throw e;
  }
}

export const useArtifacts = create<ArtifactsStore>((set, get) => ({
  panelOpen: false,
  rows: [],
  loaded: false,
  open: null,
  busy: false,
  error: null,
  lastExport: null,

  togglePanel: () => set((st) => ({ panelOpen: !st.panelOpen })),

  refresh: async () => {
    try {
      await send({ kind: 'list' }, 'list');
    } catch (e) {
      // `loaded` is set even on failure: the panel must stop saying "loading"
      // and start saying what went wrong. A spinner that never resolves is the
      // worst of the three states.
      set({ loaded: true, error: String(e) });
    }
  },

  openArtifact: async (id) => {
    set({ busy: true, error: null, lastExport: null });
    try {
      await send({ kind: 'open', id }, 'get', { artifactId: id });
      await send({ kind: 'versions', id }, 'versions', { artifactId: id });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  showVersion: async (version) => {
    const open = get().open;
    if (!open) return;
    set({ busy: true, error: null });
    try {
      await send({ kind: 'open', id: open.row.id, version }, 'get', {
        artifactId: open.row.id,
        version,
      });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  exportArtifact: async (id) => {
    set({ busy: true, error: null, lastExport: null });
    try {
      await send({ kind: 'export', id }, 'export', { artifactId: id });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  deleteArtifact: async (id) => {
    set({ busy: true, error: null });
    try {
      await send({ kind: 'delete', id }, 'delete', { artifactId: id });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  close: () => set({ open: null, lastExport: null, error: null }),

  onEvent: (e) => {
    // Deliberately a refresh rather than a local patch. The event carries
    // enough to update one row, but not enough to know where it now sorts, and
    // a list that is right about the row and wrong about the order is harder to
    // trust than one that costs a cheap round trip.
    void get().refresh();
    // Made or changed by the conversation you are looking at: show it, the way
    // a finished piece of work is handed over, not left for you to go find.
    // Only that conversation. A report written on Telegram or in another chat
    // must not pull the panel open over what you are doing here.
    if (e.onScreen && e.action !== 'deleted') {
      set({ panelOpen: true });
      if (get().open?.row.id !== e.id) {
        void get().openArtifact(e.id);
        return;
      }
    }
    const open = get().open;
    if (open?.row.id !== e.id) return;
    if (e.action === 'deleted') set({ open: null });
    // An edit to the artifact on screen jumps the viewer to the newest version,
    // even from an older one: the person is watching the agent work on it, and
    // an edit that lands only in the version picker looks like no edit at all.
    // The older version stays one pick away.
    if (e.action === 'updated') void get().openArtifact(e.id);
  },

  onResult: (e) => {
    const p = pending.get(e.id);
    // An unknown id is an answer to a request from a previous mount, or a
    // duplicate. Dropping it is right; acting on it would overwrite whatever
    // the current panel is showing.
    if (!p) return;
    pending.delete(e.id);

    if (!e.ok) {
      set({ busy: false, loaded: true, error: e.error ?? 'Something went wrong.' });
      return;
    }

    switch (p.kind) {
      case 'list':
        set({ rows: e.items ?? [], loaded: true, error: null });
        return;
      case 'open': {
        const row = e.items?.[0];
        if (!row || typeof e.content !== 'string') {
          set({ busy: false, error: 'That artifact came back empty.' });
          return;
        }
        const prev = get().open;
        set({
          busy: false,
          error: null,
          open: {
            row,
            content: e.content,
            showing: p.version ?? row.version,
            // Versions arrive in their own reply, which may land first or
            // second. Keeping what we already have means neither order loses.
            versions: prev && prev.row.id === row.id ? prev.versions : [],
          },
        });
        return;
      }
      case 'versions': {
        const open = get().open;
        if (open && open.row.id === p.id) set({ open: { ...open, versions: e.versions ?? [] } });
        return;
      }
      case 'export':
        set({
          busy: false,
          error: null,
          lastExport: { path: e.path ?? '', note: e.note ?? '' },
        });
        return;
      case 'delete':
        set({ busy: false, error: null });
        void get().refresh();
        return;
    }
  },
}));

/** Test seam: forget every in-flight request between cases. */
export function resetArtifactRequests(): void {
  pending.clear();
}
