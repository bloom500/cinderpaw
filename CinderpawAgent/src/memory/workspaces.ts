/**
 * Workspace registry (Sprint 1.3).
 *
 * A workspace is a logical context the user opens the agent in — typically
 * a directory ("the Cinderpaw repo", "my notes"), but it can also be a
 * standalone scratchpad. Memory is scoped per-workspace so a fact learned
 * in `/work` does not bleed into `/personal`.
 *
 * Identity is a UUID assigned on create (per `project_memory_roadmap.md`).
 * `name` is a display label only — two workspaces called "Agent" must not
 * collide on `WHERE name = ?`. `root_path` is the directory the workspace
 * was opened from, nullable for ad-hoc workspaces.
 *
 * The active workspace is tracked separately in `meta.active_workspace_id`
 * so the WelcomeBack banner + the RecallEngine's default filter can read
 * it without scanning the table.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface Workspace {
  /** Stable UUID — display label, never interpolated into a `WHERE name` query. */
  id: string;
  name: string;
  /** Optional: the directory the workspace was opened from. */
  rootPath: string | null;
  createdAt: number;
  lastActiveAt: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string | null;
  created_at: number;
  last_active_at: number;
}

function fromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

/**
 * Create a new workspace and return its UUID. The active-workspace pointer in
 * `meta` is **not** updated automatically — callers must call
 * `setActiveWorkspace` after creating, so an "open recent" flow can list
 * workspaces without flipping the active one.
 */
export function createWorkspace(
  db: Database,
  name: string,
  rootPath: string | null = null,
): Workspace {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, name, root_path, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, rootPath, now, now);
  return { id, name, rootPath, createdAt: now, lastActiveAt: now };
}

/** Rename a workspace. Returns the updated row, or null if the id is unknown. */
export function renameWorkspace(
  db: Database,
  id: string,
  name: string,
): Workspace | null {
  const res = db.prepare("UPDATE workspaces SET name = ? WHERE id = ?")
    .run(name, id);
  if (Number(res.changes ?? 0) === 0) return null;
  return getWorkspace(db, id);
}

export function deleteWorkspace(db: Database, id: string): boolean {
  const res = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}

export function getWorkspace(db: Database, id: string): Workspace | null {
  const row = db.prepare(
    "SELECT id, name, root_path, created_at, last_active_at FROM workspaces WHERE id = ?",
  ).get(id) as WorkspaceRow | undefined;
  return row ? fromRow(row) : null;
}

/** List workspaces, most-recently-active first. */
export function listWorkspaces(db: Database): Workspace[] {
  const rows = db.prepare(
    "SELECT id, name, root_path, created_at, last_active_at FROM workspaces ORDER BY last_active_at DESC",
  ).all() as WorkspaceRow[];
  return rows.map(fromRow);
}

/** Find or create a workspace by display name + optional root path. */
export function ensureWorkspace(
  db: Database,
  name: string,
  rootPath: string | null = null,
): Workspace {
  const trimmed = name.trim() || "default";
  const existing = db.prepare(
    "SELECT id, name, root_path, created_at, last_active_at FROM workspaces WHERE name = ? COLLATE NOCASE",
  ).get(trimmed) as WorkspaceRow | undefined;
  if (existing) return fromRow(existing);
  return createWorkspace(db, trimmed, rootPath);
}

const ACTIVE_KEY = "active_workspace_id";

/**
 * Persist the active workspace id in `meta` so it survives restarts and the
 * WelcomeBack banner can read it via the Tauri command. Touching the
 * workspace's `last_active_at` is intentional — `setActiveWorkspace` is the
 * "user opened this" signal, and the most-recently-active ordering feeds the
 * workspace picker.
 */
export function setActiveWorkspace(db: Database, id: string): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(ACTIVE_KEY, id, now);
  db.prepare("UPDATE workspaces SET last_active_at = ? WHERE id = ?")
    .run(now, id);
}

export function getActiveWorkspaceId(db: Database): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?")
    .get(ACTIVE_KEY) as { value: string } | undefined;
  if (!row) return null;
  // Defensive parse — the meta row is TEXT, so a foreign key (e.g. an old
  // non-UUID label) would slip through unless we validate the shape.
  return isUuid(row.value) ? row.value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}