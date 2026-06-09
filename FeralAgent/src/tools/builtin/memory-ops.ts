/**
 * memory_ops — explicit CRUD over the agent's persistent semantic memory.
 *
 * The semantic memory (see `memory/semantic.ts`) is normally fed
 * automatically by `MemoryExtractor` after each conversation. This
 * tool gives the agent direct, explicit control: when the user says
 * "remember I prefer dark mode" or "forget my old phone number", the
 * agent calls this surface to write or delete the fact immediately
 * rather than waiting for the background pass.
 *
 * Actions:
 *   - get        → read a single fact by key
 *   - search     → substring/keyword search across all facts
 *   - add        → write or overwrite a fact
 *   - forget     → delete a fact
 *   - list       → dump all facts
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { SemanticMemory, SemanticFact } from "../../memory/semantic.ts";

type Action = "get" | "search" | "add" | "forget" | "list";

const VALID_ACTIONS: ReadonlySet<Action> = new Set([
  "get", "search", "add", "forget", "list",
]);

const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function formatFacts(facts: SemanticFact[]): string {
  if (facts.length === 0) return "Memory is empty.";
  return facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}

export function createMemoryOpsTool(mem: SemanticMemory): Tool {
  const manifest: ToolManifest = {
    name: "memory_ops",
    description:
      "Read or write the agent's persistent semantic memory (facts " +
      "about the user, their preferences, projects, etc.). Actions: " +
      "`get` (single key), `search` (substring over values), `add` " +
      "(write or overwrite a fact), `forget` (delete a fact), `list` " +
      "(dump all). Keys are slug-style identifiers.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "One of: 'get' (default), 'search', 'add', 'forget', 'list'.",
        required: false,
      },
      key: { type: "string", description: "Fact key. Required for 'get', 'add', 'forget'.", required: false },
      value: { type: "string", description: "Fact value. Required for 'add'.", required: false },
      query: { type: "string", description: "Substring to search for in `key` or `value` (case-insensitive). For 'search'.", required: false },
    },
    async execute(args) {
      const action = (typeof args.action === "string" && args.action.trim()
        ? args.action : "get") as Action;
      if (!VALID_ACTIONS.has(action)) {
        return { ok: false, content: `memory_ops: unknown action "${action}".`, error: "bad_args" };
      }

      switch (action) {
        case "get": {
          const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : "";
          if (!key) return { ok: false, content: "memory_ops get: 'key' is required.", error: "bad_args" };
          const fact = mem.get(key);
          if (!fact) return { ok: false, content: `No fact stored under "${key}".`, error: "not_found", data: { key } };
          return { ok: true, content: `${fact.key}: ${fact.value}`, data: { fact } };
        }
        case "search": {
          const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : "";
          if (!query) return { ok: false, content: "memory_ops search: 'query' is required.", error: "bad_args" };
          const needle = query.toLowerCase();
          const hits = mem.all().filter((f) =>
            f.key.toLowerCase().includes(needle) || f.value.toLowerCase().includes(needle),
          );
          return {
            ok: true,
            content: hits.length === 0
              ? `No facts matched "${query}".`
              : `${hits.length} match(es):\n${formatFacts(hits)}`,
            data: { hits, query },
          };
        }
        case "add": {
          const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : "";
          const value = typeof args.value === "string" ? args.value : "";
          if (!key || !KEY_PATTERN.test(key)) {
            return { ok: false, content: `memory_ops add: 'key' must match ${KEY_PATTERN.source}.`, error: "bad_args" };
          }
          if (!value.trim()) return { ok: false, content: "memory_ops add: 'value' is required.", error: "bad_args" };
          mem.upsert(key, value);
          return { ok: true, content: `Stored: ${key} = ${value}`, data: { key, value } };
        }
        case "forget": {
          const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : "";
          if (!key) return { ok: false, content: "memory_ops forget: 'key' is required.", error: "bad_args" };
          const before = mem.get(key);
          mem.delete(key);
          if (!before) return { ok: true, content: `No fact stored under "${key}" (nothing to forget).`, data: { key, deleted: false } };
          return { ok: true, content: `Forgot: ${key} (was: ${before.value})`, data: { key, deleted: true } };
        }
        case "list": {
          const facts = mem.all();
          return { ok: true, content: formatFacts(facts), data: { facts, count: facts.length } };
        }
      }
    },
  };
}
