# Agent tool-injection diet (core set + tool drawer) — design

**Date:** 2026-06-28
**Status:** Approved, implementing
**Branch:** feat/reactive-pixel-tree

## Problem

The Feral Agent (sidecar) injects **all ~28 builtin tool schemas on every
`complete()` call**. `#openAITools`/`#nativeTools` are built once from the full
registry (`agent-loop.ts`) and threaded into every call; for native-tool
providers the prose tool block is stripped (`stripToolsFromSystemPrompt`, so
it's *not* double-injected), but the 28 native JSON schemas alone are ~5-8K
tokens. With the base prompt (~600) + SOUL.md (~1.2K) that's **~10-11K tokens
before the model reads the task** — measured by the user, on both local and
cloud, in the Agents tab. On a local Qwen3.5 4B this overflows the KV-cache
window and times out.

The earlier "token economy" work moved **memory and skills** to on-demand
drawers (`recall`, `list_skills`/`read_skill`); tools were left injected
wholesale and are now the dominant bloat.

## Goal

Drop the always-on agent prompt from ~10-11K to **~4-5K** by advertising only a
small **core** toolset and loading the rest **on demand** — without losing any
capability (every tool stays reachable) and without touching skills or the
connector-profile path.

## Core / extended split

- **Core (always advertised, ~14):** `read_file`, `write_file`, `edit_file`,
  `list_directory`, `grep`, `shell_exec`, `git`, `web_search`, `read_webpage`,
  `recall`, `list_skills`, `read_skill`, `ask_user`, `todo_write`.
  Plus the two meta-tools below.
- **Extended (drawer):** `file_search`, `scan_workspace`, `fetch_url`,
  `calculator`, `time_date`, `http_request`, `tool_health`, `code_quality`,
  `control_app`, `deep_research`, `delegate_task`.
- **Connector-only (unchanged):** `capture_lead`, `escalate_to_human`,
  `schedule_meeting` — already gated to connector profiles; removed from the
  owner default (they leak into it today).

The split lives as a declared property so it's the single source of truth (see
"Where the split lives" below) — not a hardcoded list duplicated per builder.

## Design

### 1. Declare tier on the tool manifest
Add an optional `tier?: 'core' | 'extended'` to the tool manifest (default
`'core'` when omitted, so nothing regresses silently). Tag the extended +
connector tools at their definitions. Connector tools keep their existing
profile gating; `tier` is orthogonal (it only affects the **owner default**
advertised set).

### 2. Owner default advertises core only
`buildOpenAITools`/`buildNativeTools` already take the registry. Add a filter
so the **owner default** `#openAITools`/`#nativeTools` include only
`tier === 'core'` tools. Connector profiles are built from their explicit name
list and are unaffected.

### 3. Per-session loaded set
`AgentLoop` holds `#loadedTools: Map<sessionId, Set<string>>`. When building the
per-call toolset (`#complete`, currently `profile?.openAITools ?? this.#openAITools`),
union the core default with the schemas of any tools the session has loaded.
Execution is unchanged — the registry already runs any registered tool by name;
the drawer only controls which **schemas** are advertised.

### 4. Two meta-tools (core, always on)
- `list_tools(query?)` → returns extended tool **names + one-line descriptions**
  (no schemas), optionally substring-filtered, minus already-loaded ones.
- `load_tool(names: string[])` → validates against the registry's extended
  tools, adds them to the session's loaded set, returns what's now active.
  Unknown name → error listing valid extended names.

Both reach `AgentLoop` session state via the same execution context the existing
builtin tools use (mirror `list-skills.ts` / `recall.ts`). If the context
doesn't already carry sessionId + a loaded-set handle, thread it through the
tool-execution call site the same way skills context is threaded.

### 5. System prompt note
Add a `## More tools (on demand)` line beside the existing memory/skills note in
`buildSystemPrompt`: only core tools are loaded; call `list_tools` then
`load_tool` to pull in others (desktop control, deep research, etc.).

### 6. Fix the transcript budget margin
`#transcriptBudget()` subtracts a hardcoded `toolSchemaMargin = 1536` that was
wildly under the real ~5-8K — part of why the 4B overflowed. With core-only
advertising the real margin is ~2-3K; set it to match the core schema size
(derive from the built core schemas if cheap, else a corrected constant with a
`ponytail:` note).

## What must NOT break (explicit guardrails)
- **Skills:** `list_skills`/`read_skill` are core; the drawer never touches skill
  loading. No change to `read-skill.ts` or the skills registry.
- **Connector profiles:** built from explicit name lists, not the owner default;
  `tier` does not affect them. Profiled sessions keep their restricted toolset.
- **Tool execution:** any registered tool still executes by name; only schema
  advertising changes. A tool the model somehow calls without loading still runs.
- **Default-safe tiering:** missing `tier` ⇒ `core`, so an untagged/new tool is
  advertised, never silently hidden.

## Testing (Bun/TS, sidecar)
- Owner-default `#openAITools` contains exactly the core set (excludes extended +
  connector tools).
- `load_tool(['control_app'])` makes `control_app`'s schema appear in that
  session's advertised set and **not** in another session's.
- `list_tools()` returns extended-minus-loaded; `list_tools('research')` filters.
- Connector-profile advertised set is unchanged by the tiering.
- `#transcriptBudget()` margin matches the core schema token size (not 1536).
- Regression: a session that never calls `load_tool` can still complete a basic
  task using only core tools.

## Out of scope (YAGNI)
- Task-aware/automatic tool selection (option C) — deferred; the model drives the
  drawer explicitly.
- Schema compression — separate, low-yield; the core/extended split is the lever.
- SOUL.md trimming — user-facing personality, left alone.
