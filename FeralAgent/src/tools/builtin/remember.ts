/**
 * remember — the agent's only WRITE path into durable memory.
 *
 * Capture is otherwise automatic (MemoryExtractor mines facts from finished
 * turns) and async, so "remember this: X" was answered with "OK" while
 * nothing was stored in time to be recalled. This tool is the explicit,
 * synchronous counterpart: when the user says "remember / note / don't
 * forget", the fact lands in SemanticMemory before the turn ends.
 *
 * The read side is `recall`, which searches these facts alongside past
 * conversations.
 */
import { memoryScope, type SemanticMemory } from "../../memory/semantic.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const MAX_VALUE_CHARS = 2_000;

/**
 * Keys under this prefix are the agent's notebook: rendered in full every turn
 * by WorkingMemory.setNotebook rather than reached through search.
 *
 * A prefix rather than a column because that is how this store already
 * partitions rows — see the `ponytail:` note on SCOPE_SEP in memory/semantic.ts.
 * No migration, no table rebuild.
 */
export const NOTE_PREFIX = "note:";

/**
 * The one notebook key a model other than the agent itself may write: the
 * compaction safety net refreshes it when the agent has not. Exempt from the cap
 * below, because a full notebook must never be able to block the net.
 */
export const POSITION_KEY = "note:position";

/**
 * How many notebook entries may exist at once.
 *
 * The cap is the point, not a limitation. Every drawer is re-sent on every turn,
 * so an unbounded notebook is an unbounded per-turn cost — and a notebook nobody
 * prunes stops being a notebook. We refuse the write instead of evicting a row:
 * blind truncation is the failure this whole feature exists to escape, and the
 * owner is the only one who knows which entry stopped mattering.
 */
export const MAX_NOTES = 10;

export function createRememberTool(semantic: SemanticMemory): Tool {
  const manifest: ToolManifest = {
    name: "remember",
    description:
      "Store a durable fact so you still know it in future sessions. Use it " +
      "whenever the user says remember / note this / don't forget, or states a " +
      "stable preference worth keeping. `key` is a short stable slug (e.g. " +
      "'codename', 'home_city'); writing the same key again overwrites it. Set " +
      "`forget: true` to delete a fact. Read facts back with the `recall` tool.\n" +
      "A key beginning `note:` is your NOTEBOOK: unlike ordinary facts, notebook " +
      "entries are shown back to you in full at the start of every turn, so they " +
      "survive compaction and long unattended runs. On a long task, keep " +
      "`note:position` current — one or two lines on where you are, what is next, " +
      "and what is blocked — and write a `note:<slug>` for any hard-won fact " +
      "(a path you created, a value you measured, an approach you ruled out). " +
      `At most ${MAX_NOTES} notebook entries; rewrite a stale one rather than ` +
      "hoarding.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      key: {
        type: "string",
        description: "Short stable identifier for the fact, e.g. 'codename'.",
        required: true,
      },
      value: {
        type: "string",
        description: "The fact to store. Omit when forget is true.",
        required: false,
      },
      forget: {
        type: "boolean",
        description: "Delete the fact stored under `key` instead of writing one.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const key = typeof args.key === "string" ? args.key.trim() : "";
      if (!key) {
        return { ok: false, content: "remember: 'key' is required.", error: "bad_args" };
      }
      // "" for every single-user surface; the speaker on a shared channel, so
      // one Discord member's "call me Alex" never renames another. See
      // `memoryScope`.
      // `ctx?.` — the registry always supplies one, but a tool's execute is a
      // public boundary and a missing ctx must degrade to global, not throw.
      const scope = memoryScope(ctx?.sessionId ?? "");

      if (args.forget === true) {
        semantic.delete(key, scope);
        return { ok: true, content: `Forgotten: ${key}.`, data: { key, forgotten: true } };
      }

      const value = typeof args.value === "string" ? args.value.trim() : "";
      if (!value) {
        return {
          ok: false,
          content: "remember: 'value' is required unless forget is true.",
          error: "bad_args",
        };
      }
      // Notebook cap. Only counts entries that would be ADDED: rewriting an
      // existing note is how a full notebook is supposed to be maintained, and
      // refusing that would leave the agent stuck with ten stale lines.
      const normalized = key.toLowerCase();
      if (normalized.startsWith(NOTE_PREFIX) && normalized !== POSITION_KEY) {
        const existing = semantic
          .all(scope)
          .filter((f) => f.key.startsWith(NOTE_PREFIX) && f.key !== POSITION_KEY);
        const isNew = !existing.some((f) => f.key === normalized);
        if (isNew && existing.length >= MAX_NOTES) {
          return {
            ok: false,
            content:
              `remember: your notebook already holds ${MAX_NOTES} entries. Rewrite one that ` +
              `is out of date, or delete one with forget: true, then write this again. ` +
              `Current keys: ${existing.map((f) => f.key).join(", ")}`,
            error: "notebook_full",
          };
        }
      }

      const stored = value.slice(0, MAX_VALUE_CHARS);
      semantic.upsert(key, stored, scope);
      return {
        ok: true,
        content: `Remembered — ${key}: ${stored}`,
        data: { key, value: stored },
      };
    },
  };
}
