/**
 * The artifact store — where work that is not a sentence goes.
 *
 * Until now the agent could produce exactly one kind of output: text, into a
 * conversation, which scrolls away. Anything longer-lived had to be a file the
 * user was told the path of, on the one machine that has a screen. A report
 * asked for on WhatsApp existed only as a wall of chat message.
 *
 * An artifact is a row plus a file. That is the whole model, and it is
 * deliberately not eleven models: `kind` picks a renderer and nothing else, so
 * the store, the versioning and (later) the delivery path never grow a branch
 * per type. An app is an HTML file its renderer runs in a sandbox; a document
 * is HTML; a downloaded file is a file.
 *
 * WHY THE BYTES ARE NOT IN SQLITE. This database is shared with the fractal
 * memory substrate, and a 40-page document in a BLOB makes every memory query
 * pay for it. The row carries the metadata and a path; the path carries the
 * content.
 *
 * WHY VERSIONS ARE WHOLE FILES. History, diff preview, rollback and comparison
 * all fall out of having two complete files. A diff chain would save disk and
 * buy a replay path that can corrupt — the wrong trade at this size. Rollback
 * is therefore a forward write: restoring v1 creates v4 with v1's bytes, so the
 * undo is itself in the history and an undo of an undo costs nothing.
 *
 * ponytail: whole-file copy per version. Move to a diff chain the day an
 * artifact is big enough that copying it is measurable, not before.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

/**
 * What a renderer needs to know, and the only thing `kind` decides.
 *
 * `file` is the honest bottom of the list: something was produced, we know its
 * name and nothing else about it. It exists so that a downloaded or imported
 * artifact has a home rather than being refused for not fitting a category.
 */
export type ArtifactKind =
  | "document"
  | "markdown"
  /**
   * One self-contained, interactive HTML file: charts, sliders, dashboards,
   * small simulations. `chart` was its own kind for about a day; it is an app
   * with no buttons, and splitting them bought a second renderer for the case
   * where the user immediately asks whether the chart can be dragged. See
   * `artifacts/app.ts` for the two rules it runs under.
   */
  | "app"
  | "table"
  | "code"
  | "json"
  | "html"
  | "pdf"
  | "image"
  | "file";

const KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  "document", "markdown", "app", "table", "code", "json", "html", "pdf", "image", "file",
]);

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === "string" && KINDS.has(v);
}

/**
 * The kinds whose content is text the agent can write in a tool call.
 *
 * `pdf` and `image` are real artifact kinds — they just cannot be *authored*
 * from a string, so `create` refuses them with a sentence that says what to do
 * instead, rather than writing a .pdf file full of prose that no reader opens.
 */
const TEXT_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "document", "markdown", "app", "table", "code", "json", "html", "file",
]);

const EXT: Record<ArtifactKind, string> = {
  document: ".html",
  markdown: ".md",
  app: ".html",
  table: ".json",
  code: ".txt",
  json: ".json",
  html: ".html",
  pdf: ".pdf",
  image: ".png",
  file: ".bin",
};

const MIME: Record<ArtifactKind, string> = {
  document: "text/html",
  markdown: "text/markdown",
  app: "text/html",
  table: "application/json",
  code: "text/plain",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  image: "image/png",
  file: "application/octet-stream",
};

export interface Artifact {
  id: string;
  workspaceId: string;
  kind: ArtifactKind;
  title: string;
  path: string;
  mime: string;
  bytes: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  modifiedBy: string;
  /** Where it came from: surface, connector, channel, run. Free-form JSON. */
  origin: Record<string, unknown> | null;
}

export interface ArtifactVersion {
  artifactId: string;
  version: number;
  path: string;
  author: string;
  note: string | null;
  createdAt: number;
}

/** What happened, for the one event the rest of the system listens to. */
export type ArtifactChange = "created" | "updated" | "deleted";

export interface ArtifactChangeEvent {
  id: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  sessionId: string;
  action: ArtifactChange;
}

interface Row {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  path: string;
  mime: string;
  bytes: number;
  version: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  modified_by: string;
  origin: string | null;
}

function fromRow(r: Row): Artifact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    // The column is TEXT and a hand-edited database could hold anything. An
    // unknown kind degrades to `file`, which every renderer can handle, rather
    // than throwing on read and making one bad row poison the whole list.
    kind: isArtifactKind(r.kind) ? r.kind : "file",
    title: r.title,
    path: r.path,
    mime: r.mime,
    bytes: r.bytes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    modifiedBy: r.modified_by,
    origin: parseOrigin(r.origin),
  };
}

function parseOrigin(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    // Provenance is context, never correctness. A row whose origin JSON got
    // mangled must still open.
    return null;
  }
}

/**
 * A title that is safe to show and short enough to list.
 *
 * It is never part of a path — the path is built from the uuid — so this is
 * about legibility, not traversal. Newlines are stripped because a title is one
 * line by definition and a pasted paragraph would break every list that renders
 * it.
 */
function cleanTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat;
}

/**
 * Guards a path before the store touches it.
 *
 * Injected so the store stays testable with no permission system in the room,
 * while the real caller passes `resolveAllowedPath(manifest, "fs:write", p)` —
 * the same choke point every other file-writing tool goes through. That is what
 * makes `read_only` mode apply here for free instead of being a promise this
 * file would have to keep on its own.
 */
export type PathGuard = (path: string, mode: "read" | "write") => string;

const NO_GUARD: PathGuard = (p) => p;

export interface ArtifactStoreOptions {
  /** Called after every successful change. Wired to the transport in boot. */
  onChange?: (event: ArtifactChangeEvent) => void;
  guard?: PathGuard;
}

export class ArtifactStore {
  readonly #db: Database;
  readonly #root: string;
  readonly #onChange: (event: ArtifactChangeEvent) => void;
  readonly #guard: PathGuard;

  constructor(db: Database, root: string, opts: ArtifactStoreOptions = {}) {
    this.#db = db;
    this.#root = root;
    this.#onChange = opts.onChange ?? (() => {});
    this.#guard = opts.guard ?? NO_GUARD;
  }

  get root(): string {
    return this.#root;
  }

  /** Can this kind be written from a string? */
  static isTextKind(kind: ArtifactKind): boolean {
    return TEXT_KINDS.has(kind);
  }

  static extensionFor(kind: ArtifactKind): string {
    return EXT[kind];
  }

  create(input: {
    kind: ArtifactKind;
    title: string;
    /** Text for the text kinds; bytes for a pdf, image or file. */
    content: string | Uint8Array;
    workspaceId: string;
    sessionId: string;
    origin?: Record<string, unknown> | null;
  }): Artifact {
    const id = randomUUID();
    const now = Date.now();
    const title = cleanTitle(input.title) || "Untitled";
    const path = this.#versionPath(id, 1, input.kind);
    const bytes = this.#writeFile(path, input.content);

    this.#db
      .prepare(
        `INSERT INTO artifact
           (id, workspace_id, kind, title, path, mime, bytes, version,
            created_at, updated_at, created_by, modified_by, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.kind,
        title,
        path,
        MIME[input.kind],
        bytes,
        now,
        now,
        input.sessionId,
        input.sessionId,
        input.origin ? JSON.stringify(input.origin) : null,
      );
    this.#recordVersion(id, 1, path, input.sessionId, "created", now);

    const artifact: Artifact = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      title,
      path,
      mime: MIME[input.kind],
      bytes,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: input.sessionId,
      modifiedBy: input.sessionId,
      origin: input.origin ?? null,
    };
    this.#announce(artifact, input.sessionId, "created");
    return artifact;
  }

  get(id: string): Artifact | null {
    const row = this.#db
      .prepare("SELECT * FROM artifact WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Newest first, because "the thing I was just working on" is what almost
   * every list is reaching for.
   */
  list(filter: { workspaceId?: string; kind?: ArtifactKind; limit?: number } = {}): Artifact[] {
    const where: string[] = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (filter.workspaceId) {
      where.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const rows = this.#db
      .prepare(
        `SELECT * FROM artifact WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map(fromRow);
  }

  read(id: string): string | null {
    const a = this.get(id);
    if (!a) return null;
    return readFileSync(this.#guard(a.path, "read"), "utf8");
  }

  /**
   * The raw bytes of the current version, or of `version`. For a PDF, where
   * reading as UTF-8 would corrupt the file on the next write.
   */
  readBytes(id: string, version?: number | null): Uint8Array | null {
    const path =
      version == null
        ? this.get(id)?.path
        : (this.#db
            .prepare("SELECT path FROM artifact_version WHERE artifact_id = ? AND version = ?")
            .get(id, version) as { path: string } | undefined)?.path;
    if (!path) return null;
    return new Uint8Array(readFileSync(this.#guard(path, "read")));
  }

  readVersion(id: string, version: number): string | null {
    const v = this.#db
      .prepare("SELECT path FROM artifact_version WHERE artifact_id = ? AND version = ?")
      .get(id, version) as { path: string } | undefined;
    if (!v) return null;
    return readFileSync(this.#guard(v.path, "read"), "utf8");
  }

  versions(id: string): ArtifactVersion[] {
    const rows = this.#db
      .prepare(
        `SELECT artifact_id, version, path, author, note, created_at
           FROM artifact_version WHERE artifact_id = ? ORDER BY version DESC`,
      )
      .all(id) as {
        artifact_id: string; version: number; path: string;
        author: string; note: string | null; created_at: number;
      }[];
    return rows.map((r) => ({
      artifactId: r.artifact_id,
      version: r.version,
      path: r.path,
      author: r.author,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  /**
   * Replace the content, keeping every earlier version.
   *
   * `author` is the session id for an agent edit and the literal `"user"` for a
   * manual one, so the history can answer "who changed this" — which is the
   * question that makes manual and agent editing able to share one document.
   */
  write(id: string, content: string | Uint8Array, author: string, note?: string): Artifact | null {
    const current = this.get(id);
    if (!current) return null;
    const next = current.version + 1;
    const path = this.#versionPath(id, next, current.kind);
    const bytes = this.#writeFile(path, content);
    const now = Date.now();

    this.#db
      .prepare(
        "UPDATE artifact SET path = ?, bytes = ?, version = ?, updated_at = ?, modified_by = ? WHERE id = ?",
      )
      .run(path, bytes, next, now, author, id);
    this.#recordVersion(id, next, path, author, note ?? null, now);

    const updated: Artifact = {
      ...current, path, bytes, version: next, updatedAt: now, modifiedBy: author,
    };
    this.#announce(updated, author, "updated");
    return updated;
  }

  /**
   * Restore an old version by writing it forward as a new one.
   *
   * Never rewinds `version`. An undo that erased history would be the one edit
   * nobody could audit, and rolling back a rollback would have nothing to
   * return to.
   */
  /**
   * `write`, but only onto the version the writer was looking at.
   *
   * For a person's save from the panel. They may have been typing for ten
   * minutes while the agent, asked from somewhere else, saved a newer version;
   * a plain write would bury that edit under theirs with nobody the wiser. So a
   * stale base is refused with the version that is current now, and the panel
   * asks. Without `baseVersion` it writes anyway, which is the answer "replace
   * it" to that question.
   */
  writeOnto(
    id: string,
    content: string | Uint8Array,
    author: string,
    baseVersion?: number | null,
    note?: string,
  ): { ok: true; artifact: Artifact } | { ok: false; current: number } | null {
    const current = this.get(id);
    if (!current) return null;
    // `null` is what the host sends for "no version given"; it is not a version.
    if (baseVersion != null && baseVersion !== current.version) {
      return { ok: false, current: current.version };
    }
    const artifact = this.write(id, content, author, note);
    return artifact ? { ok: true, artifact } : null;
  }

  rollback(id: string, toVersion: number, author: string): Artifact | null {
    // Bytes, not text: the same copy is right for a document and for a PDF,
    // where a UTF-8 round trip would corrupt the restored file.
    const content = this.readBytes(id, toVersion);
    if (content === null) return null;
    return this.write(id, content, author, `rolled back to v${toVersion}`);
  }

  /**
   * Soft delete: the row is hidden, the bytes stay.
   *
   * Nothing the agent made disappears on the agent's own say-so. A hard delete
   * belongs to the person, through the UI, where they can see what they are
   * removing.
   */
  remove(id: string, author: string): boolean {
    const a = this.get(id);
    if (!a) return false;
    this.#db.prepare("UPDATE artifact SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    this.#announce(a, author, "deleted");
    return true;
  }

  /** Bytes and rows, gone for good. The UI's empty-the-bin path, not a tool. */
  purge(id: string): void {
    this.#db.prepare("DELETE FROM artifact_version WHERE artifact_id = ?").run(id);
    this.#db.prepare("DELETE FROM artifact WHERE id = ?").run(id);
    rmSync(join(this.#root, id), { recursive: true, force: true });
  }

  #versionPath(id: string, version: number, kind: ArtifactKind): string {
    return join(this.#root, id, `v${version}${EXT[kind]}`);
  }

  #writeFile(path: string, content: string | Uint8Array): number {
    const safe = this.#guard(path, "write");
    mkdirSync(join(safe, ".."), { recursive: true });
    if (typeof content === "string") {
      writeFileSync(safe, content, "utf8");
      return Buffer.byteLength(content, "utf8");
    }
    writeFileSync(safe, content);
    return content.byteLength;
  }

  #recordVersion(
    id: string, version: number, path: string,
    author: string, note: string | null, at: number,
  ): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO artifact_version
           (artifact_id, version, path, author, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, version, path, author, note, at);
  }

  /**
   * Tell whoever is listening, without ever failing the write that succeeded.
   *
   * A throwing listener used to be able to undo a completed edit from the
   * caller's point of view: the bytes were on disk, the row was updated, and
   * the tool still returned an error. The notification is the least important
   * thing in this method.
   */
  #announce(a: Artifact, sessionId: string, action: ArtifactChange): void {
    try {
      this.#onChange({
        id: a.id, kind: a.kind, title: a.title,
        version: a.version, sessionId, action,
      });
    } catch {
      /* a listener's problem, not this write's */
    }
  }
}
