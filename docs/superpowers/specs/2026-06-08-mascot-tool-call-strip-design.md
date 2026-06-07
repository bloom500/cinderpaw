# Mascot Tool-Call Strip + FeralAgent Reliability — Design

**Date:** 2026-06-08
**Target release:** v0.1.5 (same milestone as the 8-bit mascot)
**Status:** Draft → pending user review

## Summary

Two problems collapse into one fix:

1. **FeralAgent works correctly on complex multi-step tasks** (proven by
   `tests/integration.test.ts`) but the user can't *see* that from the UI.
   `useFeral.ts:144,155` discards `args` and `result` (with `_args`/`_tool`
   underscore prefixes); the streaming indicator shows only "Calling X…"
   with no detail, no elapsed time, no per-message trail. From the user's
   chair it looks like a hallucinating LLM.
2. **The agent also has real reliability rough edges** that this work
   should mop up while we're touching the loop: a streaming-text "ghost"
   pattern, a missing `stopped: true` flag in the `done` event, two
   ready-but-unregistered tools (`memory_ops`, `todo_write`), and zero
   retry on transient tool failures.

The mascot is the indicator. We replace `ThinkingBubble` (single rotating
phrase while `state === 'thinking'`) with a `ToolCallStack` of comic-strip
bubbles that reflect **every** tool call **and** every skill the agent
uses, plus a context bubble at the start of each turn listing the skills
the host pre-loaded via `skillsContext`. The mascot pose already maps to
tool type (`searching`/`reading`/`building`/`writing`/`calling`); we
extend the same mapping for the new states.

The mascot cannot lie. Therefore, in parallel, we tighten the agent
itself so the bubbles reflect reality reliably.

## Goals (acceptance criteria)

| # | Criterion | Owner |
|---|-----------|-------|
| G1 | Every `tool_start` event produces exactly one visible bubble on the mascot, no exceptions, no duplicates | UI |
| G2 | Every `tool_done` event finalises its bubble (success or error state) and does not produce a new bubble | UI |
| G3 | When the host pre-loads skills via `skillsContext`, the user sees a single "context" bubble at the start of the turn listing the skill names, distinct from tool-call bubbles | UI |
| G4 | `read_skill` invocations show as bubbles with a 📚 emoji and a "Skill: <name>" label, distinguishable from generic tool bubbles | UI |
| G5 | Streamed text from a turn that ends in a tool call is **never** rendered in the visible message — the partial text is fully discarded from the UI state, not just hidden | FeralAgent |
| G6 | `done` event carries `stopped: boolean`; frontend can distinguish user-stopped from natural-done | Both |
| G7 | `memory_ops` and `todo_write` are registered in the tool registry and reachable by the agent | FeralAgent |
| G8 | `web_search`, `read_url`, `read_webpage`, `http_request` retry once automatically on transient `fetch` failures (DNS, connection reset, 5xx) | FeralAgent |
| G9 | Manual: a 5-minute complex task (multi-tool research, edit files, run tests) shows bubbles for **every** tool call with stable emoji + main arg, never blocks, never crashes the sidecar | QA |
| G10 | Manual: clicking the Stop button visibly cancels within 1s; the `done` event arrives with `stopped: true` | QA |

## Non-goals (explicitly deferred)

- **Working-memory persistence across sidecar restarts** (`AgentLoop.#sessions`
  is an in-memory `Map` and a restart loses the current turn's transcript).
  Real risk; not in scope here. Tracked as #4 in the P0 list and punted.
- **`token estimation` heuristic** (V1 cosmetic only; real counts come from
  Ollama, so the `length/4` is harmless for now).
- **Per-tool progress events** (no `tool_progress` event; long-running
  tools would benefit but that's a separate design).
- **Bubbles in the assistant message history** (bubble trail is ephemeral
  on the mascot, not persisted in the chat — by user direction
  "DOAR pe mascotă").
- **The `ThinkingBubble` phrase-rotation in the `thinking` state** is
  removed as part of this work. The strip covers all agent activity
  (tools + skill context); pure "model is just thinking" without a
  tool call shows only the mascot's `thinking` pose, no bubble
  (the pose is the signal in that narrow window).

## Design — UI

### Component layout

```
                       ┌─ 🔍 web_search("agenti RO")───┐   ← oldest, fading
                       │  ✓ 1.2s                         │
                       └─────────────────────────────────┘
🐱  (pose: searching)  ┌─ 📖 read_url(clutch.co/ro)────┐   ← recent
                       │  ✓ 0.4s                         │
                       └─────────────────────────────────┘
                       ┌─ 🧮 calculator(1200*5)─────────┐   ← active, full opacity
                       │  ⏱ 0.3s                         │
                       └─────────────────────────────────┘
```

Maximum 4 bubbles visible. A 5th incoming tool call fades out the oldest
over 300ms before the new one slides in. Each bubble is positioned
**above** the mascot in `MascotPerch`, anchored bottom-left of the
mascot's CSS box, with a small pixel-art tail pointing down at the
mascot's head.

The existing `ThinkingBubble` is removed. Its rotation behaviour was
specifically for the long "model is just thinking" phase. The strip
covers everything from `tool_start` onward; pure model-thinking falls
back to the mascot's `thinking` pose alone, with no bubble (per the
user's "DOAR pe mascotă" — the pose *is* the signal in that window).

### New files

#### `frontend-react/src/components/chat/mascot/ToolCallStack.tsx`

Pure presentational component. Props:

```ts
interface ToolCallStackProps {
  events: ToolCallEvent[];   // last ≤ 4 events, oldest first
  active: boolean;            // false → fades all out
}
```

Renders up to 4 `<ToolCallBubble>` children inside a fixed-height
container, stacked vertically. Uses `framer-motion`'s `AnimatePresence`
+ `layout` so removal animates. The container is `pointer-events-none`
(bubbles are decorative, not interactive in v1).

#### `frontend-react/src/components/chat/mascot/ToolCallBubble.tsx`

Single bubble. Props:

```ts
interface ToolCallBubbleProps {
  emoji: string;          // 🔍 📖 ✏️ 🧮 🐚 🌿 🔧 ⏰ 🌐 📚 …
  label: string;          // e.g. "web_search"
  mainArg: string | null; // already-extracted, already-truncated to 50 chars
  status: 'running' | 'done' | 'error';
  startedAt: number;      // Date.now() at tool_start
  endedAt: number | null; // Date.now() at tool_done, or null while running
}
```

Layout: pill with a 2px left border in the status colour
(`running` = brand orange, `done` = muted, `error` = red). Inside:
emoji + label + `(mainArg)`. On the right: ✓ + elapsed seconds when
done, ⏱ + live elapsed while running, !  when error.

#### `frontend-react/src/components/chat/mascot/extractMainArg.ts` (pure helper)

```ts
export function extractMainArg(
  toolName: string,
  args: unknown,
): string | null;
```

Cases (single switch, exhaustive over the registered tool names):

| Tool | Source | Truncation |
|------|--------|------------|
| `web_search` | `args.query` | 50 chars |
| `read_url`, `fetch_url`, `http_request`, `read_webpage` | `args.url` (strip protocol) | 50 chars |
| `read_file` | `args.path` → basename | 50 chars |
| `edit_file`, `write_file` | `args.path` → basename | 50 chars |
| `shell_exec` | `args.command` | 40 chars |
| `git_status`, `git_diff`, `git_log`, `git_branch` | (no args) | n/a → null |
| `git_commit` | `args.message` | 40 chars |
| `calculator` | `args.expression` | 50 chars |
| `time_date` | `args.format` | 20 chars |
| `read_skill` | `args.name` → "Skill: <name>" | 30 chars |
| `file_search` | `args.pattern` | 40 chars |
| `grep` | `args.pattern` | 40 chars |
| `ask_user` | `args.questions.length` → "N questions" | n/a |
| `memory_ops` | `args.action` | 20 chars |
| `todo_write` | `args.action` + count if relevant | 30 chars |
| `deep_research` | `args.query` | 50 chars |
| `code-quality:run_tests`, `format_code`, `lint_code`, `build_project`, `install_deps` | (no args) | n/a |
| `tool_health`, `scan_workspace` | (no args) | n/a |

This list is the single source of truth for "all tools and skills". If
a new tool is added to the registry without a case here, the bubble
will fall back to just the tool name — the user sees the tool, just
without the main arg. The TS compiler will not enforce completeness
here, so we add a runtime test that iterates the registry and asserts
no unmapped tool ever reaches the bubble (logs a warning).

#### `frontend-react/src/components/chat/mascot/emojiForTool.ts` (pure helper)

```ts
export function emojiForTool(toolName: string): string;
```

Returns a per-tool emoji. `read_skill` gets 📚 to visually distinguish
skill calls from generic tool calls (G4). `calculator` 🧮, `web_search`
🔍, etc. Unknown tools get 🔧.

### Store changes

#### `frontend-react/src/stores/chat.ts`

Add to the `ChatState` interface:

```ts
toolCallStream: ToolCallEvent[];   // ring of ≤ 4 most recent events
```

Add actions:

```ts
pushToolCall(event: Omit<ToolCallEvent, 'id' | 'startedAt'>): void;
completeToolCall(id: string, result: { ok: boolean; error?: string }): void;
pushSkillsContext(names: string[]): void;  // emits one synthetic 'context' event
clearToolCallStream(): void;
```

Event shape:

```ts
type ToolCallEvent =
  | {
      id: string;            // crypto.randomUUID()
      kind: 'tool';
      name: string;          // e.g. 'web_search'
      emoji: string;
      mainArg: string | null;
      status: 'running' | 'done' | 'error';
      startedAt: number;
      endedAt: number | null;
    }
  | {
      id: string;
      kind: 'context';
      label: string;         // "Skills: foo, bar, baz"
      startedAt: number;
      endedAt: number;       // context bubbles are 'done' immediately
      status: 'done';
    };
```

The store caps the array at 4 entries (push, then if length > 4 shift
the oldest). On `done`/`error`/`stopped`/`stop`, the stream is **not**
cleared — it stays visible for a 5s window, then `clearToolCallStream`
is called from a `setTimeout` set in the action that produced the
terminating event.

### Hook changes

#### `frontend-react/src/hooks/useFeral.ts`

Replace the underscore-discarding patterns:

- `onToolStart(tool, _args)` → capture `args`; call
  `pushToolCall({ kind: 'tool', name: tool, mainArg: extractMainArg(tool, args), status: 'running' })`.
- `onToolDone(_tool)` → capture the result; call
  `completeToolCall(id, { ok: result.ok, error: result.error })`.
- The `tool_id` is currently missing from the events. The agent loop
  generates each tool call synchronously and serially, so we use a
  monotonic per-session counter in the hook as a stand-in `id`, paired
  with the tool name. (See "Stream identifier" below.)
- New: on message send, if `skillsContext` is non-empty, call
  `pushSkillsContext(skillsContext.map(s => s.name))` to surface the
  pre-loaded skills as a context bubble.

#### `frontend-react/src/lib/tauri/index.ts` (FeralAgent event types)

Add `stopped?: boolean` to the `done` event variant. The Rust side
already passes through everything verbatim, so this is type-only and
needs no Rust change.

#### `frontend-react/src/lib/feralAgentStream.ts`

Same change: accept `stopped` on `done` and forward it to the React
handler. The handler in `useFeral.ts` will use it to set a
`stoppedReason` in the store so the UI can show "Stopped by user" vs
"Done" distinctly.

### Stream identifier problem

The current `tool_start` / `tool_done` events do **not** carry a
shared ID. Looking at `FeralAgent/src/transports/tauri.ts` and the
event types in `FeralAgent/src/types.ts`, both events have a `tool`
field but no `id`. The hook today correlates them by "last one wins"
(`useFeral.ts:144,155`), which works only because tool calls are
serial within a turn (`agent-loop.ts:251-261`).

Two options:

1. **Add an `id` field to both events** (small FeralAgent change, no
   Rust change since Rust just forwards). Most correct.
2. **Keep the "last one wins" correlation** but harden it with a
   monotonic counter so a missed `tool_done` cannot get paired with the
   next `tool_start`.

We pick **option 1** — it costs ~5 lines in `types.ts` and
`agent-loop.ts` and removes a real foot-gun. Concretely:

- `OutboundEvent.tool_start` gets `id: string` (random per call)
- `OutboundEvent.tool_done` gets `id: string` (same one the start used)
- The Rust side passes them through unchanged

This is technically beyond the "no Rust change" goal above — the Rust
side needs **no** change, but the agent-side type changes count as a
FeralAgent P0 fix. Putting it in the "FeralAgent" bucket of the P0
list, since it touches the loop.

## Design — FeralAgent P0 fixes

### P0-#1: Streaming ghost text

**Problem.** `agent-loop.ts:217-223` streams tokens into the host for
*every* turn, including turns that will end with a tool call. The
frontend has to remember to discard them on `tool_start`
(`useFeral.ts:151` does this). If the frontend ever forgets, or if a
new transport is added that doesn't, the user sees a partial answer
that disappears.

**Fix.** Inside the agent loop, do not emit `chunk` events for a turn
that will emit a tool call. Concretely: stream into a local buffer;
call `parseResponse()` (already at `agent-loop.ts:227`) which already
returns both `content` and `toolCalls`; if `toolCalls.length > 0`,
**do not emit any `chunk` events at all** for that turn. The `done`
event is never emitted mid-turn; the `tool_start` event becomes the
user's first signal that this turn produced a tool call.

Trade-off: the user loses the "stream-of-thought" tokens that hint at
what the model was reasoning about. We accept this because (a) the
comment in `agent-loop.ts:217-223` already concedes this is the
intended UX, and (b) the bubble strip is a much better explanation of
the agent's intent.

**Test.** New `tests/agent-loop-no-ghost-text.test.ts`: feed a
sequenced mock where the model emits a partial sentence then a
`web_search` tool block. Assert: zero `chunk` events were emitted
during that iteration; one `tool_start` event; one `tool_done` event
with the actual result.

### P0-#2: `stopped: true` on `done`

**Problem.** `OutboundEvent.done` (`types.ts:443`) is
`{ type: "done"; id: string; content: string }` — no way for the
frontend to know if the user pressed Stop or the model finished
naturally. The inline comment at `agent-loop.ts:142` claims there's a
`stopped: true` flag; there isn't.

**Fix.**
1. Extend `OutboundEvent.done` in `FeralAgent/src/types.ts:443` to
   `{ type: "done"; id: string; content: string; stopped: boolean }`.
2. In `FeralAgent/src/core/agent-loop.ts`, set `stopped: true` on the
   `done` event whenever the loop exits because of `AbortError`
   (already caught at `agent-loop.ts:200-204`); set `stopped: false`
   on the natural-exit path (line 244) and the iteration-cap path
   (line 264-268).
3. In `frontend-react/src/lib/tauri/index.ts:160-161` and
   `lib/feralAgentStream.ts`, accept and forward `stopped`.
4. In `useFeral.ts:onDone`, store `stopped` in a new
   `lastCompletionStopped: boolean` field on the store; `MessageList`
   uses it to render "Stopped by you" vs "Done" in the message footer.

**Test.** New test in `tests/integration.test.ts`: trigger a
`router.abort()` mid-iteration; assert the `done` event has
`stopped: true`. Natural-completion case: assert `stopped: false`.

### P0-#3: Register `memory_ops` and `todo_write`

**Problem.** Both are implemented and tested
(`tools/builtin/memory-ops.ts`, `tools/builtin/todo-write.ts`) but
`src/index.ts:219-284` does not instantiate them. The agent cannot
manage its own todos or directly CRUD its semantic memory.

**Fix.**
1. `TodoStore`: new file `FeralAgent/src/db/todo-store.ts` exposing
   `list()`, `add(item)`, `set(id, status)`, `remove(id)`,
   `clear()`, all backed by the existing `todos` table in
   `db.ts:144-152`. Wire it in `src/index.ts` between the DB and the
   tool registry.
2. `src/index.ts:219-284`: add two `registry.register(...)` lines for
   `memory_ops` (with the `semantic` instance as constructor arg) and
   `todo_write` (with the `TodoStore` instance).
3. Update `tools/builtin/todo-write.ts` if needed to use the new
   `TodoStore` API instead of the existing inline SQL.

**Test.** New test in `tests/integration.test.ts`: send a message
that triggers `todo_write` (via a sequenced mock), assert the todos
table has the new row. Manual: ask the agent "add a todo to test the
app" and confirm the bubble appears with 📋 and the todo persists
across sidecar restart.

### P0-#5: Tool retry on transient fetch failures

**Problem.** `ToolRegistry.call` (`tools/registry.ts:114-160`) wraps
every tool in a try/catch but does not retry. A single
`fetch`-induced hiccup on `web_search` or `read_url` fails the
whole tool call; the agent then has to decide whether to retry,
which costs another iteration.

**Fix.**
1. Extend `ToolManifest` (`FeralAgent/src/types.ts:102-106`) with
   optional `retry?: { attempts: number; on: ('fetch' | 'process' | 'any')[] }`.
   Default `{ attempts: 0, on: [] }` — no behaviour change for tools
   that don't opt in.
2. `ToolRegistry.call` (`tools/registry.ts:114-160`): if
   `manifest.retry.attempts > 0` and the error matches one of
   `manifest.retry.on`, retry up to N times with linear backoff
   (250ms × attempt). Log the retry to the audit log.
3. Opt in for the network tools:
   - `web_search`: `{ attempts: 1, on: ['fetch'] }`
   - `read_url`, `read_webpage`, `http_request`: `{ attempts: 1, on: ['fetch'] }`
4. The `fetch` error classification is already centralised in
   `EgressProxy` / `feralFetch`; thread the error type into the
   registry's catch block so the retry policy can match on it.

**Test.** New `tests/tool-retry.test.ts`: mock the egress proxy to
fail once then succeed; assert the registry retries exactly once
and the tool result is the success payload. Audit log has one
`tool_call` row plus one `tool_retry` row.

## Architecture summary

```
┌─────────────────── Tauri host (Rust) ────────────────────┐
│  feral://agent-output  →  React (one event per stdout line)│
└───────────────────────────────────────────────────────────┘
                              │
                              ▼ JSON line per event
┌─────────────────── FeralAgent sidecar (Bun/TS) ───────────┐
│  AgentLoop                                              │
│   ├── chunk (P0-#1: NOT emitted for tool-call turns)     │
│   ├── tool_start { id, name, args }                      │
│   ├── tool_done  { id, name, ok, result, error? }        │
│   └── done       { id, content, stopped }               │
│                                                         │
│  ToolRegistry                                           │
│   ├── manifest.retry (P0-#5)                            │
│   └── wraps: memory_ops (P0-#3), todo_write (P0-#3)     │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼ tauri events
┌────────────────────── React (frontend-react) ───────────┐
│  feralAgentStream.ts → useFeral.ts → useChat store      │
│   ├── toolCallStream: ToolCallEvent[]                   │
│   └── lastCompletionStopped: boolean                    │
│                                                         │
│  ChatInput.tsx                                          │
│   └── MascotPerch                                       │
│        ├── FeralMascot (pose: agent phase)              │
│        └── ToolCallStack (≤ 4 bubbles)                  │
│             └── ToolCallBubble (emoji + name + arg)     │
└─────────────────────────────────────────────────────────┘
```

## Data flow (one tool call)

1. Model in `AgentLoop.#complete` returns a response that includes a
   `web_search` tool block.
2. `parseResponse()` (`agent-loop.ts:227`) returns
   `{ content, toolCalls: [{ name: 'web_search', args: { query: 'agenti RO' }, id: 't_1' }] }`.
3. P0-#1: because `toolCalls.length > 0`, **no** `chunk` events were
   emitted for the partial content in this turn.
4. Loop body emits `tool_start` with `id: 't_1'`, `tool: 'web_search'`,
   `args: { query: 'agenti RO' }` (`agent-loop.ts:252`).
5. `ToolRegistry.call` invokes the tool. P0-#5: if `web_search` fails
   on a fetch error, the registry retries once. On final success or
   failure, a `tool_done` event is emitted with the same `id: 't_1'`.
6. The Tauri host forwards both events to React.
7. `useFeral.ts:onToolStart('web_search', { query: 'agenti RO' })`
   runs `extractMainArg('web_search', args) === 'agenti RO'` and
   `emojiForTool('web_search') === '🔍'`, then
   `pushToolCall({ kind: 'tool', name: 'web_search', emoji: '🔍',
   mainArg: 'agenti RO', status: 'running' })`.
8. `useFeral.ts:onToolDone('t_1', result)` runs
   `completeToolCall('t_1', { ok: result.ok })`. The bubble's status
   flips to `done` and shows `✓ 1.2s`.
9. The model runs again, returns the final answer, no tool calls; the
   loop emits `chunk` events (real this time, no tool-call turn) and
   then `done { stopped: false }`.
10. After 5s, `clearToolCallStream()` runs and the stack fades out.

## Testing strategy

### FeralAgent (bun test)
- `tests/agent-loop-no-ghost-text.test.ts` — new (P0-#1)
- `tests/integration.test.ts` — extend with P0-#2, P0-#3
- `tests/tool-retry.test.ts` — new (P0-#5)
- All passing locally with `bun test`

### React (Vitest)
- `ToolCallStack.test.tsx` — new
  - renders 0 bubbles when stream is empty
  - renders a bubble on `pushToolCall`
  - caps at 4 (oldest is removed when 5th arrives)
  - active=false fades all
- `extractMainArg.test.ts` — new, exhaustive over registered tools
- `emojiForTool.test.ts` — new, exhaustive over registered tools
- All passing locally with `npm test` (or whatever the React script
  is; check `frontend-react/package.json` during planning)

### Manual QA checklist
- Run a 5-minute research task; verify one bubble per tool call
- Press Stop mid-iteration; verify "Stopped by you" footer + 1s
  cancellation
- Send a message with `skillsContext` non-empty; verify the context
  bubble appears before the first tool bubble
- Trigger a `web_search` on a network-down machine; verify the
  bubble shows the retry attempt (transient flash) and final failure
  state

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| P0-#1 removes useful "thinking aloud" tokens | Low | Low | The bubble + pose is a clearer signal; users will not miss it |
| Adding `id` to events breaks the frontend type | Low | Low | One-line type extension; Tauri Rust passes through unchanged |
| Tool retry masks real bugs (always retrying) | Low | Med | Retry is opt-in per tool manifest; logs every retry to audit |
| `ToolCallStack` overflows narrow viewports | Med | Low | Container is fixed-height, scrolls vertically; max 4 visible |
| All 24 tools emitting bubbles at once floods the stack | Low | Med | Cap at 4; auto-fade oldest; bubbles are short |

## Open questions

None. User has approved:
- "Comic Strip" style
- "Tool + main arg" content
- "DOAR pe mascotă" placement
- Fix P0 first (#1, #2, #3, #5), defer #4
- "Reflecat ABSOLUT toate tool calls si skills folosite"
