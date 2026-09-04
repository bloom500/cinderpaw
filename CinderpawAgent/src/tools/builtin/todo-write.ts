/**
 * todo_write — agent-managed checklist of work-in-progress items.
 *
 * A persistent task list that survives across sessions. The agent uses
 * it as a working memory: mark an item as in-progress, swap to done,
 * reprioritize. The shape is intentionally tiny — one row per item,
 * identified by a slug-style id, with a free-form `status` string so
 * the agent can invent its own workflow ("todo", "in_progress",
 * "blocked", "needs_review", …).
 *
 * Actions:
 *   - list      → all items (optionally filtered by status)
 *   - add       → new item with a chosen id
 *   - set       → mutate one item (status, content, or both)
 *   - remove    → delete by id
 *   - clear     → drop all items (use with care)
 */

import type { Database } from "bun:sqlite";
import type { Tool, ToolManifest } from "../../types.ts";

type Action = "list" | "add" | "set" | "remove" | "clear";

const VALID_ACTIONS: ReadonlySet<Action> = new Set([
  "list", "add", "set", "remove", "clear",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface TodoItem {
  id: string;
  content: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export class TodoStore {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  list(statusFilter?: string): TodoItem[] {
    const rows = statusFilter
      ? this.#db
        .query<{ id: string; content: string; status: string; created_at: number; updated_at: number }, [string]>(
          "SELECT id, content, status, created_at, updated_at FROM todos WHERE status = ? ORDER BY updated_at DESC",
        )
        .all(statusFilter)
      : this.#db
        .query<{ id: string; content: string; status: string; created_at: number; updated_at: number }, []>(
          "SELECT id, content, status, created_at, updated_at FROM todos ORDER BY updated_at DESC",
        )
        .all();
    return rows.map((r) => ({
      id: r.id, content: r.content, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  add(id: string, content: string, status = "todo"): TodoItem {
    const now = Date.now();
    this.#db
      .query("INSERT OR REPLACE INTO todos (id, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, content, status, now, now);
    return { id, content, status, createdAt: now, updatedAt: now };
  }

  set(id: string, patch: { content?: string; status?: string }): TodoItem | null {
    const existing = this.#db
      .query<{ id: string; content: string; status: string; created_at: number; updated_at: number }, [string]>(
        "SELECT id, content, status, created_at, updated_at FROM todos WHERE id = ?",
      )
      .get(id);
    if (!existing) return null;
    const newContent = patch.content ?? existing.content;
    const newStatus = patch.status ?? existing.status;
    const now = Date.now();
    this.#db
      .query("UPDATE todos SET content = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(newContent, newStatus, now, id);
    return { id, content: newContent, status: newStatus, createdAt: existing.created_at, updatedAt: now };
  }

  remove(id: string): boolean {
    const res = this.#db.query("DELETE FROM todos WHERE id = ?").run(id);
    return res.changes > 0;
  }

  clear(): number {
    const res = this.#db.query("DELETE FROM todos").run();
    return res.changes;
  }
}

export function createTodoWriteTool(store: TodoStore): Tool {
  const manifest: ToolManifest = {
    name: "todo_write",
    description:
      "Manage the agent's working-memory todo list. Actions: " +
      "`list` (optionally filter by status), `add` (create with id+content), " +
      "`set` (mutate content or status), `remove` (delete by id), `clear` " +
      "(drop all — use with care). Items persist across sessions.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "One of: 'list' (default), 'add', 'set', 'remove', 'clear'.",
        required: false,
      },
      id: { type: "string", description: "Item id (slug, e.g. 'fix-auth-bug'). Required for add/set/remove.", required: false },
      content: { type: "string", description: "Item text. Required for `add`, optional for `set`.", required: false },
      status: { type: "string", description: "Free-form status. Defaults to 'todo' on add. Examples: 'in_progress', 'blocked', 'done'.", required: false },
      status_filter: { type: "string", description: "When action='list', only return items with this status.", required: false },
    },
    async execute(args) {
      const action = (typeof args.action === "string" && args.action.trim()
        ? args.action : "list") as Action;
      if (!VALID_ACTIONS.has(action)) {
        return { ok: false, content: `todo_write: unknown action "${action}".`, error: "bad_args" };
      }

      switch (action) {
        case "list": {
          const filter = typeof args.status_filter === "string" && args.status_filter.trim()
            ? args.status_filter : undefined;
          const items = store.list(filter);
          if (items.length === 0) {
            return { ok: true, content: filter ? `No todos with status "${filter}".` : "Todo list is empty.", data: { items } };
          }
          const lines = items.map((it) => `- [${it.status}] ${it.id}: ${it.content}`);
          return {
            ok: true,
            content: `${items.length} todo(s):\n${lines.join("\n")}`,
            data: { items, count: items.length },
          };
        }
        case "add": {
          const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
          const content = typeof args.content === "string" ? args.content : "";
          if (!id || !ID_PATTERN.test(id)) {
            return { ok: false, content: `todo_write add: 'id' must match ${ID_PATTERN.source}.`, error: "bad_args" };
          }
          if (!content.trim()) {
            return { ok: false, content: "todo_write add: 'content' is required.", error: "bad_args" };
          }
          const status = typeof args.status === "string" && args.status.trim() ? args.status.trim() : "todo";
          const item = store.add(id, content, status);
          return {
            ok: true,
            content: `Added todo: [${item.status}] ${item.id}: ${item.content}`,
            data: { item },
          };
        }
        case "set": {
          const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
          if (!id) return { ok: false, content: "todo_write set: 'id' is required.", error: "bad_args" };
          const patch: { content?: string; status?: string } = {};
          if (typeof args.content === "string") patch.content = args.content;
          if (typeof args.status === "string" && args.status.trim()) patch.status = args.status.trim();
          if (Object.keys(patch).length === 0) {
            return { ok: false, content: "todo_write set: at least one of 'content' or 'status' is required.", error: "bad_args" };
          }
          const updated = store.set(id, patch);
          if (!updated) return { ok: false, content: `todo_write set: no item with id "${id}".`, error: "not_found" };
          return {
            ok: true,
            content: `Updated todo: [${updated.status}] ${updated.id}: ${updated.content}`,
            data: { item: updated },
          };
        }
        case "remove": {
          const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
          if (!id) return { ok: false, content: "todo_write remove: 'id' is required.", error: "bad_args" };
          const removed = store.remove(id);
          if (!removed) return { ok: false, content: `todo_write remove: no item with id "${id}".`, error: "not_found" };
          return { ok: true, content: `Removed todo: ${id}`, data: { id } };
        }
        case "clear": {
          const n = store.clear();
          return { ok: true, content: `Cleared ${n} todo(s).`, data: { removed: n } };
        }
      }
    },
  };
}
