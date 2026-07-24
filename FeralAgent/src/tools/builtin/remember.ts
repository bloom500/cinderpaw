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

export function createRememberTool(semantic: SemanticMemory): Tool {
  const manifest: ToolManifest = {
    name: "remember",
    description:
      "Store a durable fact about the user or their world, so you still know it " +
      "in future sessions. Use it whenever the user says remember / note this / " +
      "don't forget, or states a stable preference worth keeping. `key` is a " +
      "short stable slug (e.g. 'codename', 'home_city', 'preferred_editor'); " +
      "writing the same key again overwrites it. Set `forget: true` to delete a " +
      "fact the user asks you to forget. Read facts back with the `recall` tool.",
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
