import { create } from 'zustand';
import { tauri } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import type { PdfEdit } from '@/lib/pdfEdits';
import type { PdfFieldRow } from '@/components/artifacts/PdfEditor';
import { OUT_MS, chunkRun, editRuns, liveUntil, type Run } from '@/lib/emberLetters';

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
  /** Letters still arriving or leaving (live writing, see emberLetters.ts). */
  live?: LiveArtifact;
}

/**
 * A document while Cinderpaw writes or edits it. A draft is an `open` whose row
 * has version 0 and the draft's key as its id, so the viewer shows it like any
 * other document and the saved one can take its place without a jump.
 */
export interface LiveArtifact {
  /** Which offsets arrived when: they animate in. */
  runs: Run[];
  /** An edit's old text, shown with its removed words going out until `until`. */
  out?: { content: string; ranges: Array<[number, number]>; until: number };
  /** Set while the model is still writing this draft. */
  writing?: { turn: string; sessionId: string };
  /** Why a draft was never saved, in a sentence for the person. */
  stopped?: string;
}

/** One `artifact_draft` event, plus whether its chat is the one on screen. */
export interface DraftEvent {
  id: string;
  sessionId: string;
  draft: string;
  kind?: string;
  title?: string;
  append: string;
  onScreen: boolean;
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
  | { kind: 'import' }
  /** A read for a chat card: answered to the caller, never shown in the panel. */
  | { kind: 'peek'; resolve: (r: { row: ArtifactRow; content: string }) => void; reject: (why: string) => void };

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
  /** The panel's tab: this chat's artifacts, or what the chat has in context. */
  panelTab: 'artifacts' | 'context';
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
  google: { link?: string; error?: string; note?: string; busy?: boolean; signingIn?: boolean; dest?: GoogleDest } | null;
  /** Gives up waiting on a sign-in the person walked away from; the buttons work again at once. */
  cancelGoogle: () => void;
  /** Forgets the saved Google login, so the next send asks which account. */
  signOutGoogle: () => Promise<void>;
  /**
   * Send the open artifact to the person's Google Drive: text and HTML become
   * a Google Doc, a PDF stays a PDF. First time, it logs them in through the
   * built-in browser and then finishes the send on its own.
   */
  sendToGoogle: (target?: { title: string; kind: string; content: string }, dest?: GoogleDest) => Promise<void>;
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
  setPanelTab: (tab: 'artifacts' | 'context') => void;
  refresh: () => Promise<void>;
  /**
   * `section` is the deep dive from a chat card: the panel opens on the whole
   * document, scrolled to the heading with that text, instead of the overview.
   */
  openArtifact: (id: string, section?: string) => Promise<void>;
  /**
   * The heading a deep dive asked for, and in which artifact, until the viewer
   * has scrolled to it. The id keeps it off whatever was on screen before the
   * asked-for artifact arrived.
   */
  focus: { id: string; section: string } | null;
  clearFocus: () => void;
  showVersion: (version: number) => Promise<void>;
  /**
   * `as: 'pdf'` offers a PDF first (the chat card's "Download PDF"); `row` is
   * for a caller that knows the artifact when the list has not been loaded.
   */
  exportArtifact: (id: string, opts?: { as?: 'pdf' | 'xlsx'; row?: { title: string; kind: string }; version?: number }) => Promise<void>;
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
    id: string; action: 'created' | 'updated' | 'deleted'; onScreen?: boolean; version?: number; title?: string;
  }) => void;
  onResult: (e: {
    id: string; ok: boolean; items?: ArtifactRow[]; content?: string;
    versions?: ArtifactVersionRow[]; path?: string; note?: string; error?: string;
    conflict?: number; encoding?: 'base64'; fields?: PdfFieldRow[];
  }) => void;
  /** A piece of a document Cinderpaw is writing (`artifact_draft`). */
  onDraft: (e: DraftEvent) => void;
  /**
   * The turn `turn` saved its document (`artifactId`), or ended without
   * saving it (`reason`, a sentence for the person).
   */
  endDraft: (turn: string, outcome: { artifactId?: string; reason?: string }) => void;
}

const pending = new Map<string, Pending>();
/** The artifact the viewer wants open, or null after `close()`. A reply for
 *  anything else is stale: `close()` used to leave an in-flight `get` free to
 *  reopen the document a moment later (Astra, 19 Sep 2026, P2). */
let wanted: string | null = null;
/** A `versions` reply that landed before its `get` (a PDF's `get` waits for
 *  field parsing; `versions` does not). Kept until the document opens. */
let earlyVersions: { id: string; versions: ArtifactVersionRow[] } | null = null;
/** A draft the person went back from: its later pieces must not reopen it. */
let dismissed: string | null = null;
let seq = 0;
/** Which Send to Google is current; Cancel moves it on, so a late answer is dropped. */
let googleRun = 0;
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
  panelTab: 'artifacts',
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
  cancelGoogle: () => {
    googleRun++;
    set({ google: null });
  },
  signOutGoogle: async () => {
    googleRun++;
    try {
      await tauri.google.disconnect();
      set({ google: { note: 'Signed out of Google. The next send asks which account to use.' } });
    } catch (e) {
      set({ google: { error: String(e) } });
    }
  },
  focus: null,
  clearFocus: () => set({ focus: null }),

  sendToGoogle: async (target, dest = 'docs') => {
    const open = get().open;
    const doc = target
      ? { row: { title: target.title, kind: target.kind }, content: target.content, encoding: undefined }
      : open;
    if (!doc) return;
    const plan = googlePlan(shownKind(doc.row.kind, doc.content), dest, doc.content, doc.row.title);
    if (!plan) return;
    // A sign-in waits up to 5 minutes for the browser. Cancel starts a new run,
    // and whatever the old one brings back later is dropped, not shown.
    const run = ++googleRun;
    const show = (g: ArtifactsStore['google']) => {
      if (run === googleRun) set({ google: g });
    };
    show({ busy: true, dest });
    // Opens Google's consent page in the person's own browser and resolves
    // once they have approved; the artifact stays open underneath.
    const signIn = async () => {
      show({ busy: true, signingIn: true, dest });
      await tauri.google.connect();
      if (run !== googleRun) throw new Error('cancelled');
      show({ busy: true, dest });
    };
    try {
      let signedIn = false;
      if (!(await tauri.google.status())) {
        await signIn();
        signedIn = true;
      }
      const name = plan.convert ? fileName(doc.row.title) : downloadName(doc.row.title, doc.row.kind);
      const data = plan.content ?? doc.content;
      const encoding = plan.content === undefined && doc.encoding === 'base64' ? 'base64' : null;
      const upload = () => tauri.google.upload(name, plan.mime, data, encoding, plan.convert, dest === 'gmail');
      let link: string;
      try {
        link = await upload();
      } catch (e) {
        // google.rs forgets a saved login Google stopped accepting. Sign in once
        // more instead of failing the same way on every click (12 Oct).
        if (signedIn || (await tauri.google.status()) !== false) throw e;
        await signIn();
        link = await upload();
      }
      // The file opens in the person's own browser, already signed in to Google.
      const target = dest === 'gmail' ? gmailCompose(doc.row.title, link) : link;
      // The file is in Google by now: a browser that will not open falls back
      // to a new window, never to an error that says the send failed.
      try {
        await openUrl(target);
      } catch {
        window.open(target, '_blank', 'noopener,noreferrer');
      }
      show({ link, dest });
    } catch (e) {
      show({ error: String(e), dest });
    }
  },

  showingArchived: false,

  togglePanel: () => set((st) => ({ panelOpen: !st.panelOpen })),
  setPanelTab: (tab) => set({ panelTab: tab }),

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

  openArtifact: async (id, section) => {
    wanted = id;
    set({ busy: true, error: null, lastExport: null, focus: section ? { id, section } : null });
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

  exportArtifact: async (id, opts) => {
    // Only when the panel has THIS artifact: from a chat card it may hold another one.
    const open = get().open?.row.id === id ? get().open : null;
    const row = get().rows.find((r) => r.id === id) ?? open?.row ?? opts?.row;
    // The version on screen, when it is not the newest: the file that leaves
    // must be the one the person is looking at (a card's own version, or the panel's).
    const version = opts?.version ?? (open && open.showing !== open.row.version ? open.showing : undefined);
    // The person picks where it goes, in the OS dialog, for every kind. Export
    // used to drop the file in the workspace root and print the path; a PDF
    // to sign usually wants to be on the desktop or in Downloads.
    // A table leaves as a sheet unless asked otherwise: its own .json is a file
    // nobody who asked for a table knows how to open (6 Oct, a CSV came out as a PDF).
    const as = opts?.as ?? (row?.kind === 'table' ? 'xlsx' : undefined);
    // Writing leaves as a PDF unless the person picks another type: "Save as"
    // opened on MARKDOWN, with PDF and Word only inside the type list (UX lab,
    // 19 Oct, item 24). Its own format stays in the list.
    const prose = !as && !!row && PROSE.has(row.kind);
    let dest: string | undefined;
    try {
      const picked = await saveDialog({
        defaultPath: row ? downloadName(row.title, row.kind, as ?? (prose ? 'pdf' : undefined)) : undefined,
        // The native format first, then what the sidecar can convert a text
        // artifact into: it picks the conversion from the extension of the
        // path chosen here (export.ts `exportAs`), so a name ending in .docx
        // is a Word file, not the source bytes renamed.
        filters: row
          ? as && CONVERTIBLE.has(row.kind)
            ? [{ name: as === 'pdf' ? 'PDF' : 'Excel', extensions: [as] }]
            : prose
              ? [
                  { name: 'PDF', extensions: ['pdf'] },
                  { name: 'Word', extensions: ['docx'] },
                  { name: KIND_NAMES[row.kind] ?? row.kind, extensions: [extensionFor(row.kind, row.title).slice(1)] },
                ]
            : [
                { name: KIND_NAMES[row.kind] ?? row.kind, extensions: [extensionFor(row.kind, row.title).slice(1)] },
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
    const open = get().open;
    if (open?.live?.writing) dismissed = open.row.id;
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
    // Made or changed by the conversation you are looking at: the chat shows
    // it as a card in the reply (ArtifactCard), so the panel stays shut until
    // the person opens it. It used to open on its own beside the same document.
    // Made somewhere you are not looking (another chat, Telegram, a call):
    // the done toast says so and opens it (spec 7.4). It used to arrive
    // silently, found only by opening Artifacts.
    if (!e.onScreen && e.action === 'created') {
      useNotifications.getState().push('success', `${e.title?.trim() || 'Your new artifact'} is ready`, 'Saved in Artifacts', {
        label: 'Open',
        run: () => {
          set({ panelOpen: true, panelTab: 'artifacts' });
          void get().openArtifact(e.id);
          // The panel lives beside the chat. Imported late: the router imports
          // every page, and the pages import this store.
          void import('@/router').then(({ router }) => {
            if (router.state.location.pathname !== '/chat') void router.navigate('/chat');
          });
        },
      });
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

    if (p.kind === 'peek') {
      const row = e.items?.[0];
      if (e.ok && row && typeof e.content === 'string') p.resolve({ row, content: e.content });
      else p.reject(e.error ?? 'That artifact came back empty.');
      return;
    }

    if (!e.ok) {
      // A refused save is a question for the person, not an error: the panel
      // shows it with its two answers, and the draft stays exactly as typed.
      if (p.kind === 'save' && typeof e.conflict === 'number') {
        set({ busy: false, conflict: e.conflict });
        return;
      }
      set({ busy: false, loaded: true, error: e.error ?? 'Something went wrong.' });
      // A draft waiting for its saved version would otherwise say "Saving"
      // for good.
      const open = get().open;
      if (p.kind === 'open' && open?.row.version === 0 && open.live) {
        set({ open: { ...open, live: { ...open.live, stopped: e.error ?? 'The saved document could not be opened.' } } });
      }
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
        const live = p.version === undefined && prev ? liveAfter(prev, row, e.content, e.encoding, !!get().editing) : undefined;
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
            ...(live ? { live } : {}),
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
        // From a chat card the panel may be shut, and then nothing says where
        // the file went. With the panel on this artifact, its own line does.
        if (!get().panelOpen || get().open?.row.id !== p.id) {
          useNotifications.getState().push('success', 'Saved', e.path || e.note || 'Your file is ready');
        }
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

  onDraft: (e) => {
    const key = `${e.id}/${e.draft}`;
    // Only the chat on screen, never over the person's own typing, and never
    // back after they went back to the list from it.
    if (!e.onScreen || get().editing || dismissed === key) return;
    const now = Date.now();
    const open = get().open;
    if (open?.row.id === key && open.live) {
      const runs = open.live.runs.filter((r) => liveUntil([r]) + 100 > now);
      if (e.append) runs.push(chunkRun(open.content.length, e.append, now));
      set({
        open: {
          ...open,
          row: { ...open.row, kind: e.kind ?? open.row.kind, title: e.title ?? open.row.title },
          content: open.content + e.append,
          live: { ...open.live, runs },
        },
      });
      return;
    }
    // A new document: whatever the panel was waiting to open is no longer wanted.
    wanted = null;
    earlyVersions = null;
    set({
      panelOpen: true,
      panelTab: 'artifacts',
      busy: false,
      error: null,
      lastExport: null,
      review: null,
      focus: null,
      open: {
        row: { id: key, kind: e.kind ?? 'markdown', title: e.title ?? '', version: 0, bytes: 0, updatedAt: now, modifiedBy: 'agent' },
        content: e.append,
        showing: 0,
        versions: [],
        live: { runs: e.append ? [chunkRun(0, e.append, now)] : [], writing: { turn: e.id, sessionId: e.sessionId } },
      },
    });
  },

  endDraft: (turn, outcome) => {
    const open = get().open;
    if (!open?.live?.writing || open.live.writing.turn !== turn) return;
    // Writing is over either way. Saved: the draft stays on screen until the
    // saved version arrives to take its place, so there is never a blank.
    set({
      open: {
        ...open,
        live: { ...open.live, writing: undefined, ...(outcome.artifactId ? {} : { stopped: outcome.reason }) },
      },
    });
    if (outcome.artifactId) void get().openArtifact(outcome.artifactId);
  },
}));

/** Kinds shown as text, where letters can come and go. The rest are frames or editors. */
const TEXT_SHOWN = new Set(['markdown', 'code', 'json', 'table', 'file']);

/**
 * What still moves once a document arrives in place of the one on screen.
 * From a draft: the letters still arriving keep going (the same text, the same
 * runs), and a draft that showed nothing gets the whole text at once. From an
 * edit Cinderpaw made to the newest version on screen: its removed words go
 * out, then the new ones come in at the same spot.
 */
function liveAfter(prev: OpenArtifact, row: ArtifactRow, content: string, encoding: 'base64' | undefined, editing: boolean): LiveArtifact | undefined {
  if (encoding === 'base64' || prev.encoding === 'base64') return undefined;
  if (prev.row.version === 0 && prev.live && !prev.live.stopped) {
    if (prev.content === content) return { runs: prev.live.runs };
    return prev.content === '' && content ? { runs: [chunkRun(0, content, Date.now())] } : undefined;
  }
  const isEdit = prev.row.id === row.id && row.version > prev.row.version && prev.showing === prev.row.version;
  if (!isEdit || editing || !TEXT_SHOWN.has(shownKind(row.kind, content))) return undefined;
  const diff = editRuns(prev.content, content, 0);
  if (!diff) return undefined;
  const start = Date.now() + (diff.out.length ? OUT_MS : 0);
  return {
    runs: diff.runs.map((r) => ({ ...r, at: start })),
    ...(diff.out.length ? { out: { content: prev.content, ranges: diff.out, until: start } } : {}),
  };
}

/**
 * The kind to show an artifact as. A 'document' is HTML, but models write
 * Markdown into it; framed as a web page that collapses into one line of raw
 * #, | and **. The sidecar now stores such prose as markdown (see
 * `looksLikeHtml` in CinderpawAgent/src/artifacts/store.ts, same pattern);
 * this reads the ones saved before that the same way.
 */
export function shownKind(kind: string, content: string): string {
  const html = /<(p|div|h[1-6]|ul|ol|li|table|tr|section|article|header|body|html|blockquote|pre)\b[^>]*>/i;
  return kind === 'document' && !html.test(content) ? 'markdown' : kind;
}

/** The four places the Google button sends an artifact to. */
export type GoogleDest = 'drive' | 'docs' | 'sheets' | 'gmail';
export const GOOGLE_DESTS: GoogleDest[] = ['drive', 'docs', 'sheets', 'gmail'];

/** The file as it is, for Drive and for the Gmail link. A Word file's bytes
 *  are not in the panel (only its preview), and an image is not a document. */
const FILE_MIME: Record<string, string> = {
  document: 'text/html', html: 'text/html', app: 'text/html', markdown: 'text/markdown',
  code: 'text/plain', json: 'application/json', table: 'application/json', pdf: 'application/pdf',
};

/**
 * How one kind goes to one Google place, or null when it cannot: Docs takes
 * text and HTML (a PDF would go through OCR and lose its layout), Sheets a
 * table, turned into CSV here because that is what Google imports as a Sheet,
 * or a CSV the agent wrote as a file, which is already that.
 */
export function googlePlan(kind: string, dest: GoogleDest = 'docs', content = '', title = ''): { mime: string; convert: boolean; content?: string } | null {
  const csvFile = kind === 'file' && /\.csv$/i.test(title.trim());
  switch (dest) {
    case 'drive':
    case 'gmail':
      if (csvFile) return { mime: 'text/csv', convert: false };
      return FILE_MIME[kind] ? { mime: FILE_MIME[kind]!, convert: false } : null;
    case 'docs':
      if (kind === 'document' || kind === 'html' || kind === 'app') return { mime: 'text/html', convert: true };
      if (kind === 'markdown' || kind === 'code' || kind === 'json' || kind === 'table') return { mime: 'text/plain', convert: true };
      return null;
    case 'sheets': {
      const csv = kind === 'table' ? tableCsv(content) : csvFile && content.trim() ? content : null;
      return csv ? { mime: 'text/csv', convert: true, content: csv } : null;
    }
  }
}

/** A table artifact (`{columns, rows}`, rows of arrays, or rows of objects:
 *  the shapes the sidecar's `tableRows` reads) as CSV, or null. */
export function tableCsv(content: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  let header: string[] = [];
  let rows: unknown[][] = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) return null;
    header = o.columns.map(String);
    rows = o.rows.map((r) => (Array.isArray(r) ? r : Object.values(r as object)));
  } else if (Array.isArray(parsed) && parsed.length > 0) {
    if (Array.isArray(parsed[0])) [header, rows] = [(parsed[0] as unknown[]).map(String), parsed.slice(1) as unknown[][]];
    else if (parsed[0] && typeof parsed[0] === 'object') {
      header = Array.from(new Set(parsed.flatMap((r) => Object.keys(r as object))));
      rows = parsed.map((r) => header.map((k) => (r as Record<string, unknown>)[k]));
    } else return null;
  } else return null;
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** A new Gmail message with the link in it; the person adds who it goes to. */
function gmailCompose(title: string, link: string): string {
  const body = `${title}\n${link}\n\n(Anyone with this link can view it.)`;
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** The text kinds the sidecar can turn into a PDF, a Word or an Excel file. */
const CONVERTIBLE = new Set(['document', 'markdown', 'app', 'table', 'code', 'json', 'html', 'board']);
/** Kinds that are writing, which most people send on as a PDF. */
const PROSE = new Set(['document', 'markdown']);
/** A kind's name in the save dialog's type list ("MARKDOWN" read as a code word). */
const KIND_NAMES: Record<string, string> = {
  document: 'Web page', html: 'Web page', app: 'Web page', markdown: 'Markdown text', code: 'Code',
  json: 'JSON data', table: 'Data', board: 'Board', file: 'File', image: 'Image',
};

/** Mirrors `ArtifactStore.extensionOf` in the sidecar's artifacts/store.ts: a
 *  file or code artifact keeps the type in its title (leads.csv), not .bin. */
function extensionFor(kind: string, title = ''): string {
  const own = (kind === 'file' || kind === 'code') && /\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,8}$/i.exec(title.trim());
  if (own) return own[0].toLowerCase();
  return ({ document: '.html', markdown: '.md', app: '.html', table: '.json', code: '.txt', json: '.json', html: '.html', pdf: '.pdf', docx: '.docx', image: '.png', board: '.board.json' } as Record<string, string>)[kind] ?? '.bin';
}

/** What the save dialog suggests: the title, plus the type it leaves as unless it already ends in it. */
function downloadName(title: string, kind: string, as?: string): string {
  const base = fileName(title);
  const ext = as ? `.${as}` : extensionFor(kind, title);
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
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

const peeked = new Map<string, { row: ArtifactRow; content: string }>();

/**
 * An artifact's text, for a chat card. Unlike `openArtifact` it never touches
 * the panel's open document, and the answer is kept per version: a chat of
 * fifty replies must not ask the engine fifty times each time it scrolls.
 */
export async function peekArtifact(id: string, version: number): Promise<{ row: ArtifactRow; content: string }> {
  const key = `${id}@${version}`;
  const hit = peeked.get(key);
  if (hit) return hit;
  const got = await new Promise<{ row: ArtifactRow; content: string }>((resolve, reject) => {
    const reqId = nextId();
    // An engine that restarted mid-request never answers: the card falls back
    // to its cover instead of pulsing as "loading" for the rest of the session.
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject('The engine did not answer.');
    }, 20_000);
    const done = () => clearTimeout(timer);
    pending.set(reqId, { kind: 'peek', resolve: (r) => { done(); resolve(r); }, reject: (why) => { done(); reject(why); } });
    tauri.artifacts.op(reqId, 'get', { artifactId: id, version }).catch((e) => {
      done();
      pending.delete(reqId);
      reject(String(e));
    });
  });
  if (peeked.size >= 30) peeked.delete(peeked.keys().next().value as string);
  peeked.set(key, got);
  return got;
}

/** Test seam: forget every in-flight request between cases. */
export function resetArtifactRequests(): void {
  pending.clear();
  peeked.clear();
  wanted = null;
  earlyVersions = null;
  dismissed = null;
}
