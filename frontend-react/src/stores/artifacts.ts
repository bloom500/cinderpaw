import { create } from 'zustand';
import { tauri } from '@/lib/tauri';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { PdfEdit } from '@/lib/pdfEdits';
import type { PdfFieldRow } from '@/components/artifacts/PdfEditor';

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
  /** Text, or for a pdf the file in base64 (see `encoding`). */
  content: string;
  encoding?: 'base64';
  /** A pdf's form fields. */
  fields?: PdfFieldRow[];
  /** The version being shown, which is not always the newest one. */
  showing: number;
  versions: ArtifactVersionRow[];
}

type Pending =
  | { kind: 'list'; archived: boolean }
  | { kind: 'rename'; id: string }
  | { kind: 'archive'; id: string; archived: boolean }
  | { kind: 'open'; id: string; version?: number }
  | { kind: 'versions'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'save'; id: string }
  | { kind: 'restore'; id: string }
  | { kind: 'compare'; id: string; version: number }
  | { kind: 'import' };

export type ArtifactAction =
  | 'list' | 'get' | 'versions' | 'export' | 'delete' | 'write' | 'restore' | 'import'
  | 'rename' | 'archive' | 'unarchive';

/** A draft with nothing in it yet, for a pdf. */
export const EMPTY_PDF_DRAFT = JSON.stringify({ edits: [] });

/** The panel opens PDFs up to this size; the sidecar enforces the same number. */
const PDF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The person's edit in progress. `base` is the version they started from, kept
 * apart from `open.row.version` on purpose: the row moves when the agent saves,
 * and a save checked against the moved row would pass and bury the agent's edit.
 */
export interface EditSession {
  draft: string;
  base: number;
}

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
  /** After Send to Google Docs: the link, or what went wrong. */
  google: { link?: string; error?: string; busy?: boolean } | null;
  /**
   * Send the open artifact to the person's Google Drive: text and HTML become
   * a Google Doc, a PDF stays a PDF. First time, it logs them in through the
   * built-in browser and then finishes the send on its own.
   */
  sendToGoogle: () => Promise<void>;
  /** Non-null while the person is editing the open artifact. */
  editing: EditSession | null;
  /**
   * A version newer than the one being edited, once we know one exists: from a
   * refused save, or from an agent edit that landed mid-typing. The panel asks
   * what to do; nothing is overwritten and no typing is thrown away until then.
   */
  conflict: number | null;
  /** The version before the one shown, loaded to show what changed. */
  review: { before: string; beforeVersion: number } | null;

  togglePanel: () => void;
  refresh: () => Promise<void>;
  openArtifact: (id: string) => Promise<void>;
  showVersion: (version: number) => Promise<void>;
  exportArtifact: (id: string) => Promise<void>;
  /** For good: rows and files. The panel confirms before calling it. */
  deleteArtifact: (id: string) => Promise<void>;
  renameArtifact: (id: string, title: string) => Promise<void>;
  archiveArtifact: (id: string, archived: boolean) => Promise<void>;
  /** Whether the list shows the archive instead of the working set. */
  showingArchived: boolean;
  showArchived: (on: boolean) => void;
  startEdit: () => void;
  setDraft: (draft: string) => void;
  cancelEdit: () => void;
  /** `replace` answers the conflict question with "mine": save without the base check. */
  save: (replace?: boolean) => Promise<void>;
  /** Make an older version current again, as a new version. */
  restore: (version: number) => Promise<void>;
  /** Load the version before the one shown, to see what changed. */
  showChanges: () => Promise<void>;
  hideChanges: () => void;
  /** Turn or remove a page of the open pdf: saved at once, as a new version. */
  applyPdf: (edit: PdfEdit) => Promise<void>;
  /** A PDF from the person's disk, as a new artifact that then opens. */
  importPdf: (file: File) => Promise<void>;
  close: () => void;
  /** Called by the event stream. */
  /**
   * Called by the event stream. `onScreen` is true when the change came from
   * the conversation currently on screen (the event's session is the chat's).
   */
  onEvent: (e: {
    id: string; action: 'created' | 'updated' | 'deleted'; onScreen?: boolean; version?: number;
  }) => void;
  onResult: (e: {
    id: string; ok: boolean; items?: ArtifactRow[]; content?: string;
    versions?: ArtifactVersionRow[]; path?: string; note?: string; error?: string;
    conflict?: number; encoding?: 'base64'; fields?: PdfFieldRow[];
  }) => void;
}

const pending = new Map<string, Pending>();
/** The artifact the viewer wants open, or null after `close()`. A reply for
 *  anything else is stale: `close()` used to leave an in-flight `get` free to
 *  reopen the document a moment later (Astra, 19 Sep 2026, P2). */
let wanted: string | null = null;
/** A `versions` reply that landed before its `get` (a PDF's `get` waits for
 *  field parsing; `versions` does not). Kept until the document opens. */
let earlyVersions: { id: string; versions: ArtifactVersionRow[] } | null = null;
let seq = 0;
const nextId = () => `artifact-${Date.now()}-${++seq}`;

async function send(
  p: Pending,
  action: ArtifactAction,
  opts: { artifactId?: string; version?: number; dest?: string; content?: string } = {},
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
  editing: null,
  conflict: null,
  review: null,
  google: null,

  sendToGoogle: async () => {
    const open = get().open;
    if (!open) return;
    const plan = googlePlan(open.row.kind);
    if (!plan) return;
    set({ google: { busy: true } });
    try {
      if (!(await tauri.google.status())) {
        // Opens Google's consent page in the Browser panel and resolves once
        // the person has approved; the artifact stays open underneath.
        await tauri.google.connect();
      }
      const name = `${fileName(open.row.title)}${plan.convert ? '' : extensionFor(open.row.kind)}`;
      const link = await tauri.google.upload(name, plan.mime, open.content, open.encoding === 'base64' ? 'base64' : null, plan.convert);
      set({ google: { link } });
    } catch (e) {
      set({ google: { error: String(e) } });
    }
  },

  showingArchived: false,

  togglePanel: () => set((st) => ({ panelOpen: !st.panelOpen })),

  showArchived: (on) => {
    set({ showingArchived: on, loaded: false, rows: [] });
    void get().refresh();
  },

  refresh: async () => {
    const archived = get().showingArchived;
    try {
      await send({ kind: 'list', archived }, 'list', archived ? { content: 'archived' } : {});
    } catch (e) {
      // `loaded` is set even on failure: the panel must stop saying "loading"
      // and start saying what went wrong. A spinner that never resolves is the
      // worst of the three states.
      set({ loaded: true, error: String(e) });
    }
  },

  openArtifact: async (id) => {
    wanted = id;
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
    const row = get().rows.find((r) => r.id === id) ?? get().open?.row;
    // The version on screen, when it is not the newest: the file that leaves
    // must be the one the person is looking at.
    const open = get().open;
    const version = open && open.row.id === id && open.showing !== open.row.version ? open.showing : undefined;
    // The person picks where it goes, in the OS dialog, for every kind. Export
    // used to drop the file in the workspace root and print the path; a PDF
    // to sign usually wants to be on the desktop or in Downloads.
    let dest: string | undefined;
    try {
      const picked = await saveDialog({
        defaultPath: row ? `${fileName(row.title)}${extensionFor(row.kind)}` : undefined,
        // The native format first, then what the sidecar can convert a text
        // artifact into: it picks the conversion from the extension of the
        // path chosen here (export.ts `exportAs`), so a name ending in .docx
        // is a Word file, not the source bytes renamed.
        filters: row
          ? [
              { name: row.kind.toUpperCase(), extensions: [extensionFor(row.kind).slice(1)] },
              ...(CONVERTIBLE.has(row.kind)
                ? [
                    { name: 'PDF', extensions: ['pdf'] },
                    { name: 'Word', extensions: ['docx'] },
                    { name: 'Excel', extensions: ['xlsx'] },
                  ]
                : []),
            ]
          : undefined,
      });
      if (picked === null) return; // the dialog opened and they cancelled
      dest = picked;
    } catch {
      dest = undefined; // no dialog here (tests, a plain browser): the workspace root, as before
    }
    set({ busy: true, error: null, lastExport: null });
    try {
      await send({ kind: 'export', id }, 'export', {
        artifactId: id,
        ...(version !== undefined ? { version } : {}),
        ...(dest ? { dest } : {}),
      });
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

  renameArtifact: async (id, title) => {
    const clean = title.replace(/\s+/g, ' ').trim();
    const before = get().rows.find((r) => r.id === id);
    if (!clean || clean === before?.title) return;
    // Shown at once; the reply confirms it, and a refusal puts the old name back.
    set((st) => ({ rows: st.rows.map((r) => (r.id === id ? { ...r, title: clean } : r)), error: null }));
    try {
      await send({ kind: 'rename', id }, 'rename', { artifactId: id, content: clean });
    } catch (e) {
      set({ error: String(e) });
      void get().refresh();
    }
  },

  archiveArtifact: async (id, archived) => {
    // Out of the current list at once: waiting for the round trip made the row
    // sit there looking like the click did nothing.
    set((st) => ({ rows: st.rows.filter((r) => r.id !== id), error: null }));
    try {
      await send({ kind: 'archive', id, archived }, archived ? 'archive' : 'unarchive', { artifactId: id });
    } catch (e) {
      set({ error: String(e) });
      void get().refresh();
    }
  },

  startEdit: () => {
    const open = get().open;
    // Only the newest version is editable. Editing v2 while v4 is current would
    // make v5 out of v2 and quietly undo two edits; restoring v2 is the honest
    // way to ask for that, and it is one button away.
    if (!open || open.showing !== open.row.version) return;
    const draft = open.row.kind === 'pdf' ? EMPTY_PDF_DRAFT : open.content;
    set({ editing: { draft, base: open.row.version }, conflict: null, review: null });
  },

  setDraft: (draft) => {
    const editing = get().editing;
    if (editing) set({ editing: { ...editing, draft } });
  },

  cancelEdit: () => {
    const { open, conflict } = get();
    set({ editing: null, conflict: null });
    // Discarding in the middle of a conflict means "show me theirs", which the
    // viewer does not have yet.
    if (open && conflict !== null) void get().openArtifact(open.row.id);
  },

  save: async (replace = false) => {
    const { open, editing } = get();
    if (!open || !editing) return;
    set({ busy: true, error: null });
    try {
      await send({ kind: 'save', id: open.row.id }, 'write', {
        artifactId: open.row.id,
        content: editing.draft,
        ...(replace ? {} : { version: editing.base }),
      });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  restore: async (version) => {
    const open = get().open;
    if (!open) return;
    set({ busy: true, error: null, review: null });
    try {
      await send({ kind: 'restore', id: open.row.id }, 'restore', { artifactId: open.row.id, version });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  showChanges: async () => {
    const open = get().open;
    if (!open || open.showing < 2) return;
    const version = open.showing - 1;
    try {
      await send({ kind: 'compare', id: open.row.id, version }, 'get', { artifactId: open.row.id, version });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  hideChanges: () => set({ review: null }),

  applyPdf: async (edit) => {
    const open = get().open;
    if (!open || open.row.kind !== 'pdf') return;
    set({ busy: true, error: null });
    try {
      await send({ kind: 'save', id: open.row.id }, 'write', {
        artifactId: open.row.id,
        content: JSON.stringify({ edits: [edit] }),
        version: open.row.version,
      });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  importPdf: async (file) => {
    // Refused here too, before a 200 MB file is read into memory and base64'd,
    // with a sentence that names the limit.
    if (file.size > PDF_MAX_BYTES) {
      set({ error: `That file is ${Math.ceil(file.size / 1024 / 1024)} MB; the panel opens files up to 20 MB.` });
      return;
    }
    set({ busy: true, error: null });
    try {
      const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      await send({ kind: 'import' }, 'import', { content: JSON.stringify({ name: file.name, data }) });
    } catch (e) {
      set({ busy: false, error: String(e) });
    }
  },

  close: () => {
    wanted = null;
    earlyVersions = null;
    set({ open: null, lastExport: null, error: null, editing: null, conflict: null, review: null, google: null });
  },

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
      // Never swap the artifact out from under someone typing in another one.
      if (get().open?.row.id !== e.id && !get().editing) {
        void get().openArtifact(e.id);
        return;
      }
    }
    const open = get().open;
    if (open?.row.id !== e.id) return;
    if (e.action === 'deleted') set({ open: null, editing: null, conflict: null, review: null });
    // Mid-edit, reloading would replace what the person is typing. Say that a
    // newer version exists instead, and let them choose when they are ready.
    if (e.action === 'updated' && get().editing) {
      set({ conflict: e.version ?? open.row.version + 1 });
      return;
    }
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
      // A refused save is a question for the person, not an error: the panel
      // shows it with its two answers, and the draft stays exactly as typed.
      if (p.kind === 'save' && typeof e.conflict === 'number') {
        set({ busy: false, conflict: e.conflict });
        return;
      }
      set({ busy: false, loaded: true, error: e.error ?? 'Something went wrong.' });
      return;
    }

    switch (p.kind) {
      case 'list':
        // An answer for the other view (the person switched while it was in
        // flight) must not fill this one.
        if (p.archived !== get().showingArchived) return;
        set({ rows: e.items ?? [], loaded: true, error: null });
        return;
      case 'rename': {
        const row = e.items?.[0];
        const open = get().open;
        if (row && open?.row.id === row.id) set({ open: { ...open, row: { ...open.row, title: row.title } } });
        return;
      }
      case 'archive':
        if (get().open?.row.id === p.id) set({ open: null, editing: null, conflict: null, review: null });
        void get().refresh();
        return;
      case 'open': {
        const row = e.items?.[0];
        if (!row || typeof e.content !== 'string') {
          set({ busy: false, error: 'That artifact came back empty.' });
          return;
        }
        // Closed, or moved on to another document, while this was in flight.
        if (wanted !== row.id) {
          set({ busy: false });
          return;
        }
        const prev = get().open;
        const early = earlyVersions?.id === row.id ? earlyVersions.versions : null;
        earlyVersions = null;
        set({
          busy: false,
          error: null,
          open: {
            row,
            content: e.content,
            encoding: e.encoding,
            fields: e.fields,
            showing: p.version ?? row.version,
            // Versions arrive in their own reply, which may land first or
            // second. Keeping what we already have, or what arrived early,
            // means neither order loses.
            versions: prev && prev.row.id === row.id ? prev.versions : (early ?? []),
          },
        });
        return;
      }
      case 'versions': {
        const open = get().open;
        if (open && open.row.id === p.id) set({ open: { ...open, versions: e.versions ?? [] } });
        else if (wanted === p.id) earlyVersions = { id: p.id, versions: e.versions ?? [] };
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
        set({ busy: false, error: null, ...(get().open?.row.id === p.id ? { open: null, editing: null, review: null } : {}) });
        void get().refresh();
        return;
      case 'save':
      case 'restore': {
        // Both answer with the new current version, so the viewer shows what was
        // just written without a second round trip; the history is re-read so
        // the picker has the new entry, labelled "you".
        const row = e.items?.[0];
        const prev = get().open;
        if (!row || typeof e.content !== 'string' || prev?.row.id !== row.id) {
          set({ busy: false });
          return;
        }
        set({
          busy: false,
          error: null,
          editing: null,
          conflict: null,
          review: null,
          open: {
            row, content: e.content, encoding: e.encoding, fields: e.fields,
            showing: row.version, versions: prev.versions,
          },
        });
        void send({ kind: 'versions', id: row.id }, 'versions', { artifactId: row.id }).catch(() => {});
        return;
      }
      case 'import': {
        set({ busy: false, error: null });
        const row = e.items?.[0];
        void get().refresh();
        if (row) void get().openArtifact(row.id);
        return;
      }
      case 'compare': {
        const open = get().open;
        if (open?.row.id === p.id && typeof e.content === 'string') {
          set({ review: { before: e.content, beforeVersion: p.version } });
        }
        return;
      }
    }
  },
}));

/** What each kind becomes on Drive; null for kinds the button does not offer. */
export function googlePlan(kind: string): { mime: string; convert: boolean } | null {
  switch (kind) {
    case 'document': case 'html': case 'app': return { mime: 'text/html', convert: true };
    case 'markdown': case 'code': case 'json': case 'table': return { mime: 'text/plain', convert: true };
    case 'pdf': return { mime: 'application/pdf', convert: false };
    // A Word file's bytes are not in the panel (only its preview), and an
    // image is not a document.
    default: return null;
  }
}

/** The text kinds the sidecar can turn into a PDF, a Word or an Excel file. */
const CONVERTIBLE = new Set(['document', 'markdown', 'app', 'table', 'code', 'json', 'html']);

/** Mirrors `EXT` in the sidecar's artifacts/store.ts. */
function extensionFor(kind: string): string {
  return ({ document: '.html', markdown: '.md', app: '.html', table: '.json', code: '.txt', json: '.json', html: '.html', pdf: '.pdf', docx: '.docx', image: '.png' } as Record<string, string>)[kind] ?? '.bin';
}

/** A title as a filename, same rules as the sidecar's safeFileName. */
function fileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'artifact';
}

/** Chunked, because spreading a multi-megabyte array into one call overflows the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Test seam: forget every in-flight request between cases. */
export function resetArtifactRequests(): void {
  pending.clear();
  wanted = null;
  earlyVersions = null;
}
