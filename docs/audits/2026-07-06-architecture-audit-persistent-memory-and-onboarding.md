# Feral Architecture Audit — Persistent Memory & Onboarding

**Scope.** Persistent Memory (all layers). Terminal Agent onboarding (Go TUI at `tui/`). Desktop TUI onboarding (React/TypeScript at `frontend-react/`).
**Out of scope.** Provider layer, agent tools/permissions, desktop automation, embedding providers, performance, security hardening — except where they directly affect these three systems.
**Method.** Direct read of source: `crates/feral-core/src/rsi/`, `FeralAgent/src/memory/` (1 file + 13 fractal files, 4708 LOC), `FeralAgent/src/db.ts`, `tui/app/{wizard,model,update,view,state,keymap}.go`, `tui/main.go`, `tui/api/client.go`, `frontend-react/src/components/onboarding/OnboardingWizard.tsx`, `frontend-react/src/stores/{onboarding,onboardingPersistence}.ts`, `src-tauri/src/{memory_graph,conversations,projects}.rs`, `crates/feral-core/src/settings.rs`. No code was modified.

---

# Executive Summary

Feral's memory layer is **architecturally ambitious and well-conceived** — episodic, semantic, working, knowledge-graph, and a RAPTOR-style Fractal Memory Search all exist with clear separation, sophisticated guards (embedding-dim migration, PII redaction, atomic tree rebuild, hash-chained audit log), and a careful "augment-never-replace" fallback to FTS5. The Achilles' heel is **process boundary fragmentation**: the persistent memory lives in the TS sidecar (FeralAgent) at `~/.feral/`, the knowledge graph is also written by a Tauri Rust command to the **same JSON file with no locking** (data-loss race), embeddings are computed in `crates/feral-core::inference::embed_text` and round-tripped across the sidecar, and there is no concept of cross-workspace, cross-machine, or cross-version memory portability. The model is **coupled to memory in the wrong places** (the `MemoryExtractor` triggers an LLM call after every Nth turn to populate facts; the wizard hard-codes fake hardware and a fake key-validation; the React TUI's wizard makes the user click through 5 steps but then throws them into /chat with the provider choice discarded).

**Onboarding is the weakest part of the product.** The Go TUI's setup wizard is a *partially-mocked* flow that simulates hardware detection, simulates API-key validation, and exposes a `/setup` slash command whose handler explicitly says "coming in a future update." The React TUI's wizard is the more polished of the two, but it still: (a) drops the user's local-vs-cloud choice when "Continue" is clicked, (b) never asks the user about memory, embedding, or workspace, (c) silently fails when the sidecar is not running, and (d) treats a "Skip" click the same as a successful finish.

**Recommendation.** Memory architecture is sound in isolation; the most expensive fixes are about the *boundaries* between runtimes and about giving the user real memory controls. Onboarding is not safe to ship: the TUI Go wizard is a prototype, and the React wizard is missing the parts that matter most (memory/workspace). Treat both as "developer demo, not product" until the issues below are fixed.

---

# Persistent Memory Findings

## What's implemented well

1. **Five cleanly separated memory layers** with explicit contracts.
   - **Working** — `FeralAgent/src/memory/working.ts` holds the live transcript; compression to a summary note is token-bounded (not message-count-bounded) and degrades gracefully when the summarizer throws.
   - **Episodic** — every turn persisted to `episodic` with FTS5 triggers keeping the index in sync; `clearEmbeddings` cleanly handles model swaps.
   - **Semantic** — key-value facts, PII-redacted at write, encrypted at rest (`sandbox/field-crypto.ts`).
   - **Knowledge Graph** — entity/concept/event/fact nodes, idempotent upserts, edge dedup, structured-clone snapshots.
   - **Fractal Memory Search** — RAPTOR tree with provenance-bearing LeafStore, `rebuildIfStale` (1.2× gate), cross-session dedup, and a documented "augment, never replace" fallback to FTS5.

2. **Embedding-dimension migration guard.** `fractal-memory.ts:310-329` runs a cheap probe embed, detects a dimension mismatch (e.g. bge-small 384 → bge-m3 1024), wipes the stale vectors, and re-embeds the corpus. Without this, a model swap silently degrades every recall to FTS5 forever.

3. **Tamper-evident audit log.** `db.ts:62-86` adds `prev_hash`/`entry_hash` columns idempotently; `audit_log` rows form a hash chain that detects post-hoc UPDATE/DELETE (H-2).

4. **Atomic memory-write hooks.** `HookRegistry` + `Reconciler` (Pathway 3) subscribe to `after_memory_write`; the contract guarantees handlers never throw, so the capture pipeline never crashes the agent. Idempotency: `start()` is idempotent so a double-mount in tests/HMR can't double-subscribe.

5. **PII redaction at write** (`M-2` in `semantic.ts:51-55`) — high-confidence PII is stripped from semantic facts before encryption.

6. **Prompt-cache-friendly rendering.** `WorkingMemory.render()` appends per-turn dynamic blocks (skill menu, recall) to the *last* user message rather than injecting them as separate system messages — keeps the static prefix token-stable so llama.cpp can reuse the KV cache.

7. **Tree is offline, recall is online.** `FractalMemory.rebuild()` does the (cloud-summary-cost) work; `recall()` only embeds the single query vector. The shared `#rebuildInFlight` Promise dedupes concurrent rebuilders — the explicit fix for the live "3× rebuild thrashing" bug.

8. **FTS5 query sanitization.** `toFtsQuery()` in `episodic.ts:232-245` is NFKC-normalized, prefix-wildcarded, AND-of-tokens (precision), with a single-token OR fallback.

## Architectural issues — by severity

### High

**H-1. The model is too tightly coupled to memory write paths.**
The `MemoryExtractor` (`extractor.ts`) calls `router.complete({...})` after the *first* assistant turn and then every third one. On a slow local model this is a hidden wall-clock cost on every chat. The extraction prompt is a wall of text with no examples. There is no batching, no per-session cap, no way for the user to disable it. The LLM is *producing* memory; this is exactly the coupling the brief warns against ("the LLM should consume memory, never own it").

*Fix.* Make extraction a *background* job with its own rate limit and an explicit user toggle (Settings → Memory → Auto-extract: off / conservative / aggressive). When off, the LLM still consumes memory but never writes to it.

**H-2. Knowledge graph is written by two runtimes with no locking.**
`FeralAgent/src/memory/graph.ts:57-61` does `fs.writeFileSync` (no atomic write — no temp+rename). `src-tauri/src/memory_graph.rs:30-40` does its own read-modify-write on the *same* `~/.feral/memory-graph.json`. The Rust side admits: "a concurrent sidecar write can win the race, which loses at most one extraction pass." The TS side has no comment acknowledging the race. Two writers, no lock, no atomic write on the TS side. **Real data loss possible on crash mid-write.**

*Fix.* Pick one writer (Rust is the natural home — it owns the home dir). The TS side should call a Tauri command instead of writing directly. Both sides should use `write-to-temp + fsync + rename` for atomicity.

**H-3. Embedding round-trip crosses the host/sidecar boundary on every recall.**
`feral-core::inference::embed_text` runs in the Rust process; `FractalMemory.#embed` is a bridge call from the TS sidecar. Every query embed pays an IPC hop. There's no in-process embedding cache keyed by text hash. Recurring queries (e.g. session-opener prompts) re-embed the same string.

*Fix.* Add a tiny LRU keyed by `sha256(text)` inside the bridge; evict at 256 entries. Reads are O(1), writes are bounded.

**H-4. No cross-workspace memory.**
`projects.rs` in Tauri knows about projects (workspace buckets) with a `conversation_ids` list. Memory (episodic, semantic, graph, FMS) is *not* scoped to projects. A fact learned in `/home/user/work` is mixed with a fact from `/home/user/personal`. The TUI's `cwd` is shown on the welcome screen but never gates recall.

*Fix.* Add a `workspace_id` column to `episodic` and `semantic`; the `RecallEngine` filters by the active workspace (default = the cwd at session start). FMS tree stays global, but retrieval joins the workspace filter at the leaf level. The Projects feature in Tauri then becomes the *workspace* abstraction, and the existing `feral-cli` workspace roots align with it.

**H-5. No portable memory.**
Everything is under `~/.feral/` on one machine. There is no `feral memory export` / `import` command. A user who reinstalls, switches machines, or wants to back up cannot do so. This matters acutely for a "memory is the moat" product.

*Fix.* Add a `feral memory export <path>` that writes a portable bundle (episodic + semantic + graph + FMS tree as one tar/zip), and a matching `import` that re-stitches.

### Medium

**M-1. Working memory compression is bound to a summarizer the user can never see.**
`WorkingMemory.maybeCompress()` calls an injected `summarize(messages)` callback. On a local model this is slow; on a cloud model it costs money. The user has no way to know what was summarized or to undo a compression. There is also no UI for "show me the working-memory summary note" — it's buried in the messages array as a system-role message.

*Fix.* (a) Surface a "memory snapshot" pane in /chat that shows the current working-memory summary. (b) Add a `feral memory working` debug command that dumps it.

**M-2. The `SemanticMemory.MAX_PROMPT_FACTS = 30` cap is silent.**
The user has hundreds of facts, but only 30 are ever surfaced. There is no UI showing "you have 247 facts; I'm only showing the 30 most recent." Worse, `MAX_PROMPT_FACTS` slices from `updated_at DESC` — if a user has a *critical* old fact ("allergic to peanuts") and 30 newer ones, the critical fact is dropped from every prompt.

*Fix.* Add explicit fact *priority* (default 0) and a hybrid sort: by priority desc, then by updated_at desc within priority band. Surface the cap in Settings → Memory with a "see all" link.

**M-3. `MemoryGraph` snapshot returns `structuredClone` (deep copy) on every recall.**
`graph.ts:144` — every `RecallEngine.recall` call does a deep clone of the entire graph. For a user with 10K+ nodes/edges this is non-trivial garbage. There's no streaming or windowed view.

*Fix.* Return a lazy iterable (or just `Object.values(this.#data.nodes)`) and let the formatter read what it needs.

**M-4. `setEmbeddings` updates one row at a time in a transaction.**
`episodic.ts:119-137` — single `UPDATE` per row inside a `db.transaction`. For a 50K-row backfill this is 50K statements, each allocating a Float32Array. The Drizzle/Bun SQLite bindings don't support bulk update with parameterized BLOB arrays. The performance is acceptable for first-time embed but hostile to incremental re-embed.

*Fix.* Use a single `UPDATE … CASE WHEN id=? THEN ? …` statement, or write a temp file and `INSERT INTO … SELECT` from a CSV.

**M-5. `MemoryGraph` is a JSON file written synchronously from the TS hot path.**
`graph.ts:57` — `fs.writeFileSync` blocks the event loop on large graphs. The `persist()` wrapper (`:134-142`) catches errors and schedules a 100ms retry but the synchronous write still blocks.

*Fix.* Migrate `MemoryGraph` to SQLite (an `edges` table + a `nodes` table) — same shape, atomic, indexed, no rewrite-on-merge cost. The Rust side already serializes to JSON; change the file to a `.sqlite` and keep a JSON export for debugging.

**M-6. FTS5 index is rebuilt from scratch after the schema migration in `db.ts:113-138`.**
The `episodic_fts` triggers cover INSERT/DELETE/UPDATE on `episodic` correctly, but the *content table* declaration is `content='episodic'`. If a future migration ever changes the `episodic` schema in a way the FTS5 shadow can't reflect (column renames, type changes), the FTS5 index silently goes stale and FTS5 recall returns wrong rows.

*Fix.* Add a `rebuildFts(db)` helper called from the migrate function when it detects a schema-version bump; have it `INSERT INTO episodic_fts(episodic_fts) VALUES('rebuild')`.

**M-7. Embedding model identity is not stored anywhere.**
A user switches from bge-small to bge-m3, the dim guard wipes and re-embeds — but the *fact* that the user used bge-m3 is not persisted anywhere. The TreeStore (`tree-store.ts`) only persists centroids + ids + summaries, not the embedding model name. Next time someone debugs "why is recall bad", they can't tell which model was used.

*Fix.* Add a `meta` table or a sidecar JSON storing `{embedding_model, embedding_dim, last_built_at}` and write it on every successful rebuild.

### Low

**L-1. `MemoryGraph.persist()` retry uses `setTimeout(... 100)` and `structuredClone` — both fire-and-forget.** A shutdown during the retry window loses the write.

**L-2. `episodic.record()` audits even a no-op (`!content.trim()`).** A flood of empty assistant turns (e.g. a tool-only response) inflates the audit log. Audit gating: skip when content is empty.

**L-3. `working.ts:42` has an inline `ponytail:` comment marking the blunt middle-cut truncate.** It is honest but it ships a known low-quality behavior. The "do the right thing" version is a streaming summarizer — fine, but the comment should also live in a tracked issue, not in code.

**L-4. The `Reconciler` does not retry on embed failure.** A transient embedder crash during `upsertLeaf` loses the capture. There is no DLQ.

**L-5. `WorkingMemory` is in-memory only.** A crash mid-session loses the unsummarized tail. (Working memory is recomputable from episodic, so this is acceptable but worth documenting.)

---

# Terminal Agent Onboarding Findings

The Terminal Agent here is the Go TUI at `tui/`. Its onboarding story has two paths: an auto-launched "Setup Wizard" (spec §13) on first boot, and a `/setup` slash command. **Both are partially mocked.**

## What's implemented well

1. **Resumable wizard.** `wizard.go:11-42` writes the last completed step to `~/.feral/.wizard-progress` so Ctrl+C mid-wizard doesn't force a restart.
2. **Wired into first boot.** `update.go:74-77` checks the `wizardDoneMarker` (`~/.feral/.wizard-done`); on first boot it auto-launches the wizard. The marker replaces the progress file when done.
3. **Plain mode for screen-reader users** (`main.go:105-203`) — `/plain` bypasses the Bubble Tea TUI and streams to stdout.
4. **Polished state FSM** (`state.go`) with exhaustive footer hints per state.
5. **Compact keymap** (`keymap.go`) with help overlay (`F1`), single source of truth.
6. **Welcome screen with status rows** (`view.go:128-211`) — model, lora, backend, session, recent sessions.
7. **Multi-step wizard rendered in the chat zone** — header / body / footer pattern, with auto-advance between auto-probed steps.

## Critical issues

### C-1 (BLOCKER). The hardware probe is fake.
`tui/app/update.go:1339-1350` — `startWizardHardwareProbe` hardcodes:
```go
a.Wizard.Hardware = WizardHardware{
    GpuName: "rtx 4070", GpuVram: 12, RamGB: 64, DiskGB: 412, GpuOK: true,
}
```
A user with no GPU sees "✓ rtx 4070 · 12 GB" and proceeds to pick a 27B model that won't fit in their VRAM. The "spec §13: model recommendation by detected hardware" claim is a lie.

*Fix.* Call the real `system_info` IPC the Tauri app already exposes (`gpu_detect.rs`), or call `wmic`/`lshw` directly with a Go shim. Render the probe as a spinner — never fake it.

### C-2 (BLOCKER). The API-key validation is fake.
`tui/app/update.go:1387-1389`:
```go
case tea.KeyEnter:
    if w.APIKey == "" { return true }
    w.KeyValid = true
    if w.KeyValid { ... }
```
A user pastes "asdf" and the wizard says "✓ Connected." The same pattern exists for the connector prompt (`w.Connecting = true` is set on `y` without any handshake).

*Fix.* The gateway already exposes provider test endpoints (the React onboarding uses `testByokProvider` via Tauri). Mirror the call here: POST the key to the gateway, wait for 200, then mark `KeyValid`.

### C-3 (BLOCKER). No first-run API token.
`main.go:33-37`:
```go
token, err := api.ReadToken()
if err != nil {
    fmt.Fprintf(os.Stderr, "feral: no API token found at ~/.feral/api-token\n")
    os.Exit(1)
}
```
A new user who runs `feral` for the first time gets a cryptic one-line error and quits. There is no way to bootstrap the token from the TUI.

*Fix.* On `os.IsNotExist(token)`, fork a "first-run setup" mode that:
1. Generates an API token.
2. Writes it to `~/.feral/api-token` with 0600 perms.
3. Proceeds to the wizard.
The Tauri app already does this in `crates/feral-core/src/db_key.rs`-style logic — call into the same code path.

### C-4 (BLOCKER). `/setup` slash command is a stub.
`tui/app/update.go:627`:
```go
case "setup":
    a.setFlash("setup wizard — coming in a future update")
    return nil
```
The wizard does exist, but the command to *re-enter* it is mocked. A user who skipped the wizard on first boot has no recovery path.

*Fix.* Replace with `a.startWizard()`.

### C-5 (BLOCKER). The "download model" step has no actual download.
`wizard.go` defines `WizLocalDownload`; `view.go:1421-1453` renders a fake progress bar with hardcoded `4.2 MB/s` and "preparing download…". There is no command wired to the sidecar's model loader.

*Fix.* Wire `W3a` to a `GET /runtime/models/install` (or similar) endpoint on the gateway and stream progress over SSE — the React TUI already does this.

### C-6 (HIGH). Auto-start of the gateway silently fails for `cargo install` users.
`main.go:42-63` looks for `feral.exe` / `feral-gateway.exe` / `feral` *next to the TUI binary*. A user who installed via `cargo install feral-tui` (or any package manager that puts binaries in different dirs) will see:
```
feral: could not start gateway (exec: "feral": cannot find …)
       start it manually: feral gateway start
```
with no follow-up. The TUI is unusable in this case.

*Fix.* Search `$PATH` before giving up. If still not found, print a single actionable sentence: "install the gateway with `cargo install feral-cli` or download the latest release from …".

### C-7 (HIGH). No way for a Terminal Agent user to configure anything beyond `/model` and `/lora`.
`/setup` is the only re-entry to onboarding and it's mocked. `/help` lists commands but `/settings` does not exist. There is no way to:
- pick the embedding model
- pick the workspace (cwd is implicit)
- change the API key
- configure tool permissions
- inspect or delete memory

For a "use it daily" tool, this is a non-starter.

*Fix.* A `/settings` command that opens an in-TUI modal with a tabbed view: Model, Embedding, Memory, Workspace, Keys. Use the same palette as the wizard — keep the TUI self-contained.

### C-8 (HIGH). No onboarding for memory or embedding.
The TUI is *memory-rich* (the sidecar persists facts, builds a fractal tree) but the user has no idea. The welcome screen shows model/lora/backend but nothing about "you have 0 facts, 0 leaves, last index: never."

*Fix.* Add a "memory" row to the welcome status (fact count, leaf count, last-indexed). Add `/memory` that shows the current semantic facts and the FMS tree summary.

### C-9 (HIGH). No workspace selection in the TUI.
`model.go:303` stores `Cwd` at boot and never changes it. The Projects feature in Tauri is invisible here.

*Fix.* `/workspace` command that lists known projects (`runtime/sessions?by_project=true` or a new endpoint) and lets the user pick one. The chat session and memory filter follow.

### C-10 (HIGH). The wizard's "wizardDoneMarker" gate is invisible.
A user who has no idea what `~/.feral/.wizard-done` is might delete it by accident and be re-wizard'd on the next launch. A user who *wants* to re-run the wizard on every launch has no flag.

*Fix.* Document the marker in `/help` and `/setup`; add `--reset-wizard` (or `/setup reset`) as an explicit way to re-run.

## Medium issues

**M-T1. The model picker (`/model`) lists installed models with no signal about cost/quality.** A new user sees `*llama-3.1-8b-instruct-q4_k_m.gguf` and `nvidia:meta/llama-3.1-70b-instruct` with no indication that the latter costs money and is slower.

*Fix.* Tag rows with a small `·cloud $` or `·local` chip.

**M-T2. The wizard is opened *before* the user understands why.** `update.go:74-77` checks the marker; on first launch, the wizard is auto-opened. The user just saw "○ starting" for 100ms; now they have to make a model choice. The TUI should explain *why* the wizard is opening: "We need to know which model to use. Pick one and we won't ask again."

**M-T3. The keyboard hints in the wizard footer are inconsistent.**
`wizLine("1 2 3  choose    " + AccentStyle.Render("Enter") + "  confirm")` mixes two typefaces and the "Enter" hint is rendered in the accent color while "1 2 3" is not.

**M-T4. `Esc` in `WizModelChoice` is "go back one step"** but in `WizConnectorPrompt` is "back to connectors" (two steps). Inconsistent and the user has no way to know without trying.

**M-T5. `WizHardware` is a "render and wait for Enter"** but Enter does nothing — the `default` branch in `wizardHandleKey` just consumes the key. The footer says "Press Enter" but Enter has no effect because there's nothing to advance to without picking 1/2/3.

## Low issues

**L-T1.** `WizCloudKey` accepts the key but stores it in `ws.APIKey` as a plaintext field. If the wizard crashes after the user pastes the key, the key is in process memory and the on-disk `~/.feral/.wizard-progress` file does *not* contain the key. (This is good — but the comment doesn't say so explicitly.)

**L-T2.** `WizConnectorPrompt` says "Y" or "n" but treats both as "advance to finish" (`tui/app/update.go:1431`). The branch logic is `if y/ Y: w.Connecting = true; (then advance)`. The user thinks pressing n does something different from y but the final step is the same.

**L-T3.** The welcome moment on `finishWizard` (`:1479-1482`) prints a generic "What would you like to accomplish?" — but the user just answered "what should I call you" in the React TUI's wizard, and the Terminal Agent's wizard never asked. There's no handoff.

**L-T4.** The chat-mode TUI never tells the user that the sidecar is offline. The header shows `● online` or `● offline` but on first launch it's almost certainly offline for a few seconds; the user types into the input and gets no feedback.

---

# TUI Onboarding Findings

The TUI in this section = the React/TypeScript desktop app's onboarding flow at `frontend-react/src/components/onboarding/OnboardingWizard.tsx`.

## What's implemented well

1. **Five steps, one clear purpose per step.** Welcome → Personalize → Provider (local vs cloud) → Showcase → Done. The intent is documented at the top of the file ("we don't want to overwhelm a first-time user").
2. **Hardware-aware model recommendation.** `LocalBranch` reads `useSystemInfo` and calls `recommendModel(sysInfo)` to pick a tier from the pinned `TIER_MODELS` map. One-click download.
3. **Cost/availability notes on cloud providers.** `CURATED_PROVIDERS` includes a `note` per provider ("Free tier — no credit card needed" for Gemini, "Paid — add ~$5 credit under Billing before the key will work" for Anthropic). This is a product-reviewer's dream.
4. **Live Test of the cloud key** before Save (`CloudProviderForm.handleTest`).
5. **Disk-encryption notice** at the end (H-1 surfaced as a security check, not a banner).
6. **Layered persistence.** `onboardingPersistence.ts` uses `localStorage` (sync, fast) + Tauri command (async, survives uninstall). The fallback is graceful.
7. **FeralMascot** greets the user — same component the chat input uses, brand continuity from minute one.
8. **Skip is non-destructive** — pressing Skip sets `hasOnboardedBefore = true` and the user can re-open from Settings.

## Critical issues

### CR-1 (BLOCKER). The user's local-vs-cloud choice is dropped on "Continue."
`OnboardingWizard.tsx:415`:
```ts
const [choice, setChoice] = useState<'local' | 'cloud' | null>(null);
```
This is *local React state* in the `ProviderStep` component. It is never written to the onboarding store, never persisted, never sent to the sidecar. When the user clicks the "Continue" button (`:151-159`) at the bottom of the wizard, it calls `next()` and advances to `ShowcaseStep`. The `choice` is lost the moment the component unmounts.

So the *promised* outcome of the Provider step — "I need a model to think with" — never actually selects a model. The "Open chat" CTA at the end of the wizard opens the chat, which (on a fresh install) has no model loaded. The chat says `● offline` and the user has no idea why.

*Fix.* Move `choice` into the onboarding store. On "Continue" from the Provider step, write it. On the "Done" step, *if* the choice was local and no model is loaded, route to the LocalBranch and *wait* for the download to succeed before navigating to /chat.

### CR-2 (BLOCKER). The ProviderStep's "Continue" → "Open chat" path validates nothing.
`StepNavigation` (`:127-160`): the only validation is `canProceed = !isPersonalize || userName.trim().length > 0` — i.e. the *only* step with a validation gate is the name step. The Provider step has no validation, no check that a model was actually downloaded or a key was actually saved. The "Open chat" button always works.

A user who skips the Provider cards entirely, clicks Continue → Continue → "Open chat", lands in /chat with no model. The wizard is "done" but the product is broken.

*Fix.* The Done step (`:650-682`) should check `useDownload` and `useSettings` for an active model. If none, show a clear "no model configured — let me set one up" CTA inline and refuse to navigate.

### CR-3 (HIGH). The "Skip" button silently closes the wizard with default values.
`onboarding.ts:87-102`: Skip sets `agentName = "Feral"`, `userName = ""`, and the wizard closes. There is no "before you go, are you sure?" prompt, no warning that no model will be configured.

*Fix.* On Skip, show a "Skip onboarding? You can always re-run from Settings." confirmation. The "Skip" path should also include a one-line summary: "We'll open the chat — pick a model in Settings to start."

### CR-4 (HIGH). Onboarding never asks about memory, embedding, or workspace.
For a "memory is the moat" product, the wizard has *zero* memory screens. No "how would you like Feral to remember things?" No "would you like to share facts across workspaces?" No "Feral can use an embedding model for semantic search; want me to set one up?"

The user learns about memory only when the agent tells them mid-conversation. There is no `/memory` page, no memory settings, no visible counter.

*Fix.* Replace the Showcase step (which is mostly decorative) with a "Memory & Workspace" step:
1. Memory mode: "private" (default — only this machine) / "shared" (synchronize across machines via the user's account — not implemented yet, so this is opt-in for later).
2. Workspace: pick a default cwd (defaults to `~/Documents` or `~`).

Both can be skipped with one click and set later in Settings.

### CR-5 (HIGH). The "local model download" button is wired to Tauri commands, not to the sidecar.
`LocalBranch` (`:476-534`) calls `useDownload.start(model.repoId, model.filename)`. The download is a Tauri command. But the *sidecar* is the source of truth for "what models are installed and which one is active." The Tauri download may succeed; the sidecar's `/runtime/models` may not include it. The "I'll use it automatically" promise (`:500`) is not actually checked.

*Fix.* On the success of the Tauri download, call a sidecar command (`/runtime/models/refresh` or similar) to make the sidecar pick up the new file. Verify before claiming "ready."

### CR-6 (HIGH). The wizard does not check if the sidecar is running.
`OnboardingOrchestrator` (`:749-776`) loads persisted state and shows the wizard. It does not check `useStatus` for `sidecar_alive`. If the sidecar is dead, the user picks a model, clicks "Open chat", and the chat input is unresponsive.

*Fix.* At orchestrator mount, fetch status. If sidecar is down, show a banner inside the wizard: "the Feral backend isn't running — start it from the tray menu." Disable "Open chat" until the sidecar is alive.

### CR-7 (HIGH). The disk-encryption notice is a soft check.
`DiskEncryptionNotice` (`:691-739`) calls `tauri.system.diskEncryption()`. On *any* error, it returns `null` and the component renders nothing. A user on a machine with no encryption (the highest-risk case) gets no warning if the call fails.

*Fix.* Render an "unknown" state with a clear "we couldn't verify" message — the existing variant map already has `unknown`; just make sure it surfaces. Add a manual "check now" button.

## Medium issues

**M-R1. The 5 steps don't match `totalSteps: 5` semantically.** Step indices 0..4, total 5. Fine, but the `next()` action's `Math.min(s.step + 1, s.totalSteps - 1)` means the user can *never* be on step 4 if `totalSteps` is 5 — the last index is 4, the "Done" step. The naming is fine but the math is fragile: if a new step is added, the gate logic needs to be re-derived.

**M-R2. The Provider step's small footer links "Browse other models" and "More providers in Settings" call `finish()` first, then `navigate(...)`.** If the user came to the Provider step from a deep link to `/models` (the React Router pathname), the navigation drops them into the right page — but the wizard is *closed* and any in-flight download or key test is abandoned. There is no "defer" state.

**M-R3. The `useEffect(() => { void (async () => { ... setTimeout(() => start(), 300) })()}, [...])` in the orchestrator** uses a 300ms timeout to avoid a white flash. That's a band-aid for a layout problem; the right fix is to render the wizard above a "loading" app shell, not delay its appearance.

**M-R4. The "Continue" button's `disabled={!canProceed}` is silent** — there is no `aria-describedby` explaining *why* it's disabled. A keyboard user on the Personalize step with an empty name input gets a disabled button with no explanation.

**M-R5. The cloud key `Test` and `Save` buttons are adjacent and the same size.** A user may hit Save before Test; if the key is invalid, the BYOK config is saved with a known-bad key. The "Save" button should be visually subordinate (e.g. `Save and continue` is the primary, `Save without testing` is a ghost button).

**M-R6. The `Tauri` capability check (`isTauriAvailable()`)** returns false in pure browser dev (Vite without Tauri). The `loadPersisted` falls back to localStorage. This is fine for dev, but the wizard in *production* (Tauri) tries to read the persisted record from the Tauri command; if the command isn't registered in `capabilities/default.json`, the user sees `console.warn` and falls back to localStorage. Add a build-time check that the capability is present.

## Low issues

**L-R1.** The `step` prop is the index in the JSX `switch` (`:85-90`). The order in the JSX is Welcome → Personalize → Provider → Showcase → Done. The progress dots use the same indices. Consistent, but the indices are magic numbers.

**L-R2.** `useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo])` — fine, but no error UI if sysInfo fails. The LocalBranch falls back to `TIER_MODELS['3–4B']` (`:486`) which is OK, but the *reason* for the fallback is invisible.

**L-R3.** The animations use `framer-motion` (`stepVariants` with `y: 12 → 0 → -12`). There is no `prefers-reduced-motion` check. Users with motion sensitivity get a brief vertical translate on every step change.

**L-R4.** The `FeralMascot state="wave"` appears in `WelcomeStep` but not in `DoneStep`. The Done step has only a 🎉 emoji. The mascot is the brand; the closing should feature it.

**L-R5.** The `Preview` block in `PersonalizeStep` is a static mock conversation. It does not show that the names will be injected into the system prompt — the user has to trust the wizard's "the names you pick here are the ones I'll use" promise. Show the literal system-prompt snippet that uses them.

---

# Recommended Architecture

A unified design that fixes the three audit areas at once. The principles:

> **The LLM consumes memory; the user owns memory; the platform persists memory.**
> Memory is a single, addressable, portable surface. The model is a pluggable consumer of that surface.

## Memory

1. **Single source of truth = `MemoryStore` (Rust, in `crates/feral-core/src/memory_store.rs`)**.
   SQLite database, one file under `~/.feral/memory.sqlite`. Tables: `episodic`, `semantic`, `graph_nodes`, `graph_edges`, `fractal_leaves`, `fractal_clusters`, `audit_log`, `meta`, `workspaces`.
   The TS sidecar calls Tauri commands to read/write — it never opens the SQLite file directly.
   Atomic writes via `write-temp + fsync + rename` (or SQLite's own atomicity).
2. **One writer, many readers**. Knowledge graph writes flow through the Rust command. The TS reconciler posts `add_memory_facts` over Tauri; the Rust side upserts, returns the node count, and broadcasts the change as an event.
3. **Workspace-scoped memory**. `episodic.workspace_id`, `semantic.workspace_id`, `graph_nodes.workspace_id` — nullable for global facts. A `RegisterWorkspace(path) -> workspace_id` command. The `RecallEngine` filters by the active workspace (or "global" for cross-workspace recall). Projects in Tauri become workspaces.
4. **Portable bundle**. `feral memory export <path.tar>` and `import` produce/ingest a single archive of the SQLite file + FMS tree JSON. The bundle includes the embedding model name and dim so import on a different machine is a no-op if the model exists, else a re-embed.
5. **Embedding cache** inside the sidecar→host bridge, keyed by `sha256(text)`, 256-entry LRU.
6. **User-owned memory controls**. Settings → Memory shows fact count, leaf count, cluster count, last-indexed timestamp, "Export", "Clear", "Forget last conversation", "Pin this fact to always-surface".
7. **Extraction as a background job**. The LLM no longer writes memory on its own initiative. A background tick (every 30 minutes, or on idle) reviews recent turns, asks a *single* summarization call, and writes a batch of facts. The user can disable it from Settings.

## Terminal Agent onboarding

A wizard that **actually works** and a settings panel that **actually saves**.

1. **The wizard is honest.** Hardware probe calls `system_info` (the real Tauri command). API key validation calls the real provider test. The download step shows real progress over SSE.
2. **One-shot first-run bootstrap.** If `~/.feral/api-token` is missing, the TUI generates one, writes it 0600, and proceeds. No "could not read token" exit.
3. **A `/settings` modal** (Tab between Model, Embedding, Memory, Workspace, Keys, About). Tabs are full-screen, navigate with j/k or Tab. Persist to `~/.feral/settings.json` via the gateway's `/settings` endpoint.
4. **A `/memory` view** (Table of facts with checkboxes, search box, "Forget selected" button, "Export" button, "Show FMS tree" expandable).
5. **A `/workspace` picker** (reads projects from the gateway, sets the active workspace, applies the filter to recall).
6. **`/setup` actually works** — calls `startWizard()`. Add `--reset-wizard` flag for "always re-run".
7. **Auto-recovery on sidecar offline.** If the sidecar is down at boot, the TUI shows "the Feral backend isn't running — start it from the tray" with a "retry" button. The input is disabled.

## TUI onboarding

The React wizard gets a structural rewrite. The two-CTA problem (Provider choice dropped on Continue) is the headline fix.

1. **Provider step writes to the store**, not local component state. On "Continue", the store commits `choice` and `model_id` (local) or `provider_id` + `key_saved` (cloud).
2. **The "Open chat" CTA validates the configuration.** If no model is loaded and the gateway is online, fetch `/runtime/models` and refuse to proceed if the list is empty. Show an inline "you need a model — let me download one" with a button that goes to the LocalBranch flow.
3. **Add a "Memory & Workspace" step** between Personalize and Provider. Three questions: (a) memory mode, (b) default workspace, (c) embedding model (auto / explicit). All skippable.
4. **Sidecar liveness is checked** at orchestrator mount. If the sidecar is down, the wizard shows a banner and disables "Open chat".
5. **A `useOnboarding` "Continue" gate** is universal — every step has a `canProceed` validator. Provider step: model is downloaded or key is saved. Memory step: defaults accepted or custom values set.
6. **Reduced-motion respect** via `framer-motion`'s `useReducedMotion` hook.
7. **The DiskEncryptionNotice is mandatory** — no silent null on error.
8. **The wizard is openable from Settings as a "Re-run welcome" link** (already supported via `reopen()`; needs a Settings entry point).
9. **The local model download notifies the sidecar** to refresh its model list.
10. **A final "Test it" step** before "Open chat" — sends a one-line prompt ("hello") to the configured model and shows the response, so the user *sees* the product work before entering the chat.

---

# Missing Features

Ranked by user-visible impact.

1. **`/memory` and `/workspace` in the TUI.** Without these, the TUI is a chat client with a hidden persistent state. A daily-use product needs visible memory controls.
2. **TUI `/settings` panel.** All configuration in the TUI is currently buried in slash commands or non-existent.
3. **A real first-run API token bootstrap.** Currently the TUI exits if the token is missing.
4. **A real hardware probe in the TUI wizard.** Hardcoded "rtx 4070" is a lie that costs the user a 27B model that won't fit.
5. **A real API-key validation in the TUI wizard.** "✓ Connected" on garbage input.
6. **A real model download in the TUI wizard.** The progress bar is fake.
7. **Workspace-scoped memory.** A fact learned in `/work` should not bleed into `/personal`.
8. **Portable memory export/import.** Without this, a user who reinstalls loses everything that makes the product "theirs".
9. **Sidecar liveness check at TUI mount.** A dead sidecar should not be hidden behind a "Open chat" button.
10. **Provider-choice persistence in the React wizard.** The headline bug.
11. **Embedding model setup flow in the React wizard.** No UI for picking an embedding model.
12. **Background-task-aware memory extraction.** A toggle in Settings; off by default for local-model users.
13. **Memory controls in Settings (Desktop).** Show count, last-indexed, "Export", "Forget this conversation", "Pin a fact".
14. **A test-your-model step in the React wizard.** Verify before "Open chat".
15. **A way to set the active workspace from the TUI.** The cwd is implicit and never changes.
16. **Error-message localization in the TUI.** All messages are English; some are jargon-heavy.
17. **Reduced-motion support in the React wizard.**
18. **A "Re-run welcome" entry in Desktop Settings.**
19. **A `feral memory` CLI subcommand** for headless inspection and export.
20. **A "What's this?" tooltip on the model picker's row icons.** The icons are pretty but the meaning is opaque.

---

# Technical Debt

Ranked by blast radius.

1. **Two runtimes writing the same `memory-graph.json`** with no lock and no atomic write (TS `fs.writeFileSync` + Rust read-modify-write). Fix: single-writer Rust + Tauri command.
2. **`MemoryExtractor` fires an LLM call on the user's chat path.** Fix: background job with a user toggle.
3. **Hardcoded fake data in the TUI wizard** (hardware, key validation, download progress, connector handshake). Fix: wire to real sidecar endpoints.
4. **The TUI's `/setup` is a stub that says "coming soon".** Fix: call `startWizard()`.
5. **No schema migration versioning.** `addColumnIfMissing` handles column adds only. Fix: a `schema_version` row + a migration log; refuse to start on an unknown future version.
6. **`MemoryGraph.persist()` retry uses `setTimeout(... 100)` and `structuredClone`** — fire-and-forget; a shutdown during the retry window loses the write. Fix: SQLite.
7. **`setEmbeddings` per-row UPDATE in a transaction.** O(N) statements for backfill. Fix: `UPDATE … CASE` or a temp-table bulk insert.
8. **`semantic` has no priority field**; the 30-fact cap drops critical-but-old facts. Fix: priority band.
9. **`WorkingMemory` is in-memory only.** Crash mid-session loses the unsummarized tail. (Acceptable — recomputable from episodic — but document it.)
10. **`MemoryGraph` is a JSON file written synchronously from the hot path.** Fix: SQLite.
11. **The two `MemoryGraph` writers (TS + Rust) have different sanitization rules** (TS has `isJunkFactKey`; Rust has its own `normalize_id` and length caps). Fix: single canonical sanitizer in Rust.
12. **Embedding model identity is not persisted.** Fix: a `meta` table or sidecar JSON.
13. **The React wizard's Provider step uses local component state for a value that needs to outlive the step.** Fix: move to the store.
14. **`onboardingPersistence.ts` falls back silently to localStorage** when the Tauri command fails. Fix: log a one-time warning the user can see; add a "sync" button to retry.
15. **`OnboardingOrchestrator` uses `setTimeout(() => start(), 300)`** to avoid a flash. Fix: render a "loading" app shell beneath the wizard.
16. **`MemoryExtractor` extraction prompt is a wall of text with no examples** and the output is parsed by hand-rolled `parseCombined` / `parseObservation` / `sanitizeFact`. Local-model output variance is high. Fix: a tiny "show me what the extractor would have written" UI in Settings, so the user can see and correct the extraction behavior.
17. **`FractalMemory.query` is exposed via a tool but not surfaced in the TUI** — no way to invoke semantic search ad-hoc. Fix: `/search` command.
18. **`projects.rs` exists but is not wired to the sidecar's workspace abstraction.** Fix: make Tauri Projects the workspace authority.

---

# Recommended Implementation Order

Ordered by user-visible value, each step small enough to ship in a day or two.

1. **TUI: real hardware probe + real API key validation in the wizard.** Unblocks every other wizard improvement. *Single Tauri command + Go shim.*
2. **TUI: real model download via SSE.** Show real progress. *Wire to `/runtime/models/install`.*
3. **TUI: `/setup` calls `startWizard()`.** Trivial. *One line.*
4. **TUI: bootstrap the API token on first run.** Trivial. *One branch in `main.go`.*
5. **React wizard: move Provider `choice` to the store; validate on Done step.** Unblocks the headline bug. *Store refactor + Done step guard.*
6. **React wizard: sidecar-liveness check at orchestrator mount.** *Add `useStatus` + a banner.*
7. **React wizard: replace Showcase with Memory & Workspace step.** *New step + new questions.*
8. **Memory: single-writer Rust `MemoryStore` (SQLite).** *New `crates/feral-core/src/memory_store.rs` + Tauri commands; migrate the TS writers.*
9. **Memory: workspace scoping** (column + filter). *Schema migration + `RecallEngine` filter.*
10. **Memory: portable export/import.** *New CLI subcommand.*
11. **TUI: `/memory` view.** *New screen + slash command.*
12. **TUI: `/settings` modal.** *New screen + slash command.*
13. **TUI: `/workspace` picker.** *New screen + slash command.*
14. **Memory: embedding cache in the sidecar bridge.** *LRU keyed by text hash.*
15. **Memory: background-task-aware extraction + Settings toggle.** *Refactor `MemoryExtractor` + Settings UI.*
16. **Memory: priority field on `semantic`.** *Schema migration + sort change.*
17. **Memory: embedding model identity persisted.** *`meta` table write on rebuild.*
18. **React wizard: `useReducedMotion` respect.** *`framer-motion` hook.*
19. **React wizard: final "Test it" step.** *Send a one-line prompt; show the response.*
20. **Memory: bulk UPDATE for `setEmbeddings`.** *Performance fix.*

A clean memory + onboarding story in roughly four weeks, assuming the Tauri command + sidecar bridge are the only new surface area; everything else is refactor of existing code.
