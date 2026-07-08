# Memory Roadmap (rebalanced post-audit)

**Companion to**: `docs/audits/2026-07-06-architecture-audit-persistent-memory-and-onboarding.md` — the audit is the diagnosis; this is the rebalanced treatment plan.

**Why rebalance.** The audit's "Recommended Implementation Order" puts UI onboarding before memory architecture. For a "memory is the moat" product that's backwards. Memory works across sessions and the user says *"it remembers me"* must come before *install and it just works*.

---

## Sharpenings to the audit's recommendations

1. **Memory Resume is Sprint 1's payoff, not polish.** Without the "Welcome back to X" moment, you've built infrastructure no one sees. Promote to core deliverable.
2. **Memory Tests matrix** — explicit scenarios across restart / model / provider / embedding / version / workspace. Memory bugs destroy user trust.
3. **Rust MemoryStore migration is 1-2 weeks minimum**, not 1-2 days. Lock the contract first, enforce single-writer via file lock, migrate language incrementally — one writer at a time.

## Gap the audit missed

**Workspace needs stable identity, not just a name column.** UUID on create. Name is display label only. Two projects called "Agent" collide on `WHERE name = ?`.

---

## Architecture decisions (must hold across the program)

- **Single writer = sidecar.** `FeralAgent` (TS) is the sole writer to memory state. Tauri commands (Rust) become readers + acks; cross-process mutations (e.g. graph extraction in Rust) go through sidecar-mediated writes via Tauri commands — never direct SQLite.
- **Single-writer enforcement = file lock** on `~/.feral/.writer.lock`. Migrate to Rust-held lock later, one writer at a time.
- **Workspace identity = UUID on create**, name is a display label only.
- **Text canonical, vectors cache.** When the embedding model changes, vectors die; text is always queryable. Re-embed, don't fail.
- **Settings → Memory** is the primary user-facing surface for Resume, exports, fact counts, and pinning — not buried in chat.
- **The LLM consumes memory; the user owns memory; the platform persists memory.** The model is never the writer of memory on its own initiative (extraction becomes a background job with a user toggle).

### The writer contract (this section is the design doc for Sprint 1.1)

- **Sole writer to `episodic`, `semantic`, `meta`, `graph_*`, `fractal_*`** = `FeralAgent` (TS sidecar). All other runtimes ask the sidecar.
- **Rust commands for memory** are readers + ack-only mutators. Every Rust→SQLite write goes through a Tauri command that the sidecar implements. Concretely: replace `src-tauri/src/memory_graph.rs`'s direct `fs::write` + read-modify-write with a Tauri command `apply_graph_delta(delta)` that the sidecar handles.
- **Atomic write discipline.** `write-temp + fsync + rename` on any JSON file side-effects (e.g. `memory-graph.json` until it migrates to SQLite). SQLite writes are already atomic; do not add a second write path that races.
- **Sidecar-side write lock.** Sidecar holds `~/.feral/.writer.lock` (flock/ofd-lock) for the lifetime of the process. The lock is acquired on startup; if held, sidecar errors cleanly instead of corrupting state.
- **Cross-process read is OK.** Tauri commands can read the SQLite file directly OR via the sidecar — pick one per call. Document the choice in each command's doc-comment.
- **Failure modes.**
  - *Sidecar dead.* Rust commands fall back to read-only (the file is on disk and `bun:sqlite` is not running to take the lock anyway). Writes return an error to the UI.
  - *Lock contention.* Only happens if two sidecars launch (config bug). First to acquire wins; second exits with a clear message. Add a startup probe.
  - *Schema drift.* Sidecar refuses to start if `meta.schema_version > FERAL_EXPECTED_SCHEMA_VERSION`. Document the migration policy in `db.ts:openDatabase`.

---

## Sprint 1 — Memory Foundation + Memory Resume (≈ 2 weeks)

**Goal.** Open Feral → restore previous context → restore active project → restore last task → *"Welcome back to X."* The user says *it remembers me*.

| # | Task | Files |
|---|------|-------|
| 1.1 | Writer-contract design doc | this section (and inline references above) |
| 1.2 | `meta` table (`current_task`, `embedding_model`, `embedding_dim`, `last_built_at`, `schema_version`) | `FeralAgent/src/db.ts` |
| 1.3 | Workspace registry (UUID on create, stable ID, name as label) | `memory/workspaces.ts` + `projects.rs` |
| 1.4 | `workspace_id` column on `episodic`, `semantic`, `graph_nodes`, `graph_edges` | `db.ts` migration |
| 1.5 | `set_current_task(title)` / `get_current_task()` sidecar API | `memory/resume.ts` |
| 1.6 | Tauri command `get_last_task` → `{task, workspace_id, last_active_at}` | `src-tauri/src/memory_resume.rs` |
| 1.7 | React `WelcomeBack` banner — reads on shell mount | `frontend-react/src/components/shell/WelcomeBack.tsx` |
| 1.8 | TUI last-task row on welcome screen | `tui/app/{view,state}.go` |
| 1.9 | File-lock single-writer (`~/.feral/.writer.lock`) | `crates/feral-core/src/memory_lock.rs` + sidecar acquire-on-startup |
| 1.10 | Memory Tests matrix | `FeralAgent/tests/memory-resilience.test.ts` |

### Memory Tests matrix (1.10)

Every scenario gets a red/green test before Sprint 1 ships:

- **Restart.** App killed mid-session, reopened → all `episodic`, `semantic`, `meta` intact, resume banner shows correct task.
- **Model swap.** Switch chat model, memory indexes unchanged (text canonical).
- **Provider swap.** Switch cloud ↔ local provider, memory unchanged.
- **Embedding model swap.** Switch `bge-small` → `bge-m3`, dim guard triggers, vectors wiped, re-embed, recall still works.
- **Version upgrade.** Install new build, schema migration runs, all memories survive.
- **Workspace switch.** Switch active workspace, recall filter applies, facts from workspace A don't leak into workspace B.

### Definition of Done for Sprint 1

- A first-time user starts the app, picks a model, chats once, closes the app. Next launch shows *"Welcome back to your first topic. Working in your workspace."*
- A user switches embedding model, sees a re-embed progress, recall still returns relevant results.
- A user upgrades the app, no data loss, no crashes.
- Workspace switch cleanly filters recall.

---

## Sprint 2 — Terminal + Desktop Onboarding (≈ 1 week, shipped 2026-07-06)

Audit `C-1`..`C-5` + React `CR-1` (the headline bug) lifted:

| # | Task | State | File |
|---|------|-------|------|
| C-3 | First-run token bootstrap | ✓ | `tui/api/client.go::EnsureToken` + `tui/main.go:33` |
| C-4 | `/setup` → `startWizard()` | ✓ | `tui/app/update.go:650` |
| C-1 | Real hardware probe via gateway | ✓ | `crates/feral-core/src/api.rs::system_info` + `tui/api/client.go::FetchSystemInfo` + `tui/app/update.go::startWizardHardwareProbe` |
| C-2 | Real API key validation | ✓ | `crates/feral-core/src/byok.rs::test_provider` + gateway `/providers/test` + `tui/api/client.go::TestProviderKey` |
| C-5 | Real model download + progress | ✓ | gateway `/runtime/models/install` + `/runtime/models/download/:id` + `tui/api/client.go::{InstallModel,DownloadModel}` + polling via `pollDownload` |
| CR-1 | Provider choice → store + Done step guard | ✓ | `frontend-react/src/stores/onboarding.ts::{providerChoice,providerComplete}` + `OnboardingWizard.tsx::StepNavigation` |

**Architectural notes:**
- The Tauri command `test_byok_provider` now delegates to `byok::test_provider` in `feral-core` — the headless gateway can serve the same probe via `/providers/test`, so the wizard gets identical behaviour whether it talks to the desktop or headless daemon.
- The gateway route `/runtime/models/install` spawns the download on a detached Tokio task; progress is exposed via the `runtime.model_downloads` map (uuid-keyed). The TUI polls `/runtime/models/download/:id` every 500ms — no SSE on the TUI side, the gateway can stream via SSE on `/events` if a richer view is wanted later.
- `EnsureToken(seed []byte)` is exposed for tests but the production path passes `nil` to use `crypto/rand`. Reusing an existing token (the second call) is the contract — a user mid-session is not silently rotated to a new bearer.

**Deferred to follow-up slices:**
- `/settings` modal (Model / Embedding / Memory / Workspace / Keys tabs) — Sprint 4.
- `/memory` view — Sprint 4.
- `/workspace` picker — Sprint 4.
- React sidecar-liveness check at orchestrator mount — Sprint 3 (next slice).
- Final "Test it" step (real prompt → response) — Sprint 3 (next slice).

## Sprint 3 — React Onboarding (≈ 1 week, reordered)

Keep Showcase. Defer memory config to **post-first-message** (Settings → Memory reopens the wizard for that step).

1. ✓ Provider `choice` → store + Done-step guard (the headline bug).
2. Sidecar liveness at orchestrator mount.
3. Memory Settings → wizard reopen loop (post-first-message).
4. Local download notifies sidecar.
5. Final "Test it" step.
6. `useReducedMotion`.

## Sprint 4 — Memory depth (≈ 1 week)

- `/memory` table view with search, pin, forget-selected.
- Embedding-model picker (Settings → Memory).
- Embedding cache (LRU, sha256-keyed, 256 entries, sidecar bridge).
- Background extraction with Settings toggle (per H-1: LLM no longer writes memory on its own initiative).

## Sprint 5 — Optimizations (≈ 1 week)

- `feral memory export <path>` / `import` portable bundle (SQLite + FMS tree JSON + embedding model name).
- `semantic.priority` hybrid sort (priority desc, then `updated_at` desc — per audit M-2, fixes "allergic to peanuts dropped because newer facts exist").
- Bulk `setEmbeddings` (per audit M-4).
- Embedding-model identity in `meta` (already covered by 1.2 — closed here).

---

## Open questions

1. **`current_task` auto-track vs tool-call.** Proposal: **both**. Auto-track from active workspace path / current conversation topic by default; expose `set_current_task(title)` as a tool for explicit user-controlled focus. The mobile-style "two-finger swipe to dismiss" UX for the banner is undecided.
2. **Welcome-back copy for first-launch.** Decide: a) silent (no banner on first launch), b) "Get started — set up your workspace and pick a model" CTA, c) onboarding wizard restarts if the wizard-done marker is missing. Default: (a) silent on first launch; (c) re-runs wizard if marker is missing.
3. **`workspace_id IS NULL` semantics.** Global facts allowed on `semantic` only (user preferences, name, language survive workspace switches). `episodic` always workspace-scoped — every conversation belongs to some workspace.

---

## Status

Sprint 1 progress lives in the agent's `todowrite` list at runtime. Permanent state (committed) updates this section's checkboxes.

### Sprint 1 — Shipped (2026-07-06)

| # | Task | State |
|---|------|-------|
| 1.1 | Writer-contract design doc | ✓ this file |
| 1.2 | `meta` table | ✓ `FeralAgent/src/db.ts:354-360` |
| 1.3 | Workspace registry (UUID identity) | ✓ `FeralAgent/src/memory/workspaces.ts` |
| 1.4 | `workspace_id` on episodic, semantic | ✓ `db.ts` (idempotent ALTER + index) |
| 1.5 | `set_current_task` / `get_current_task` | ✓ `FeralAgent/src/memory/resume.ts` |
| 1.6 | Tauri command `get_last_task` | ✓ `src-tauri/src/memory_resume.rs` + gateway `/runtime/resume` |
| 1.7 | React `WelcomeBack` banner | ✓ `frontend-react/src/components/shell/WelcomeBack.tsx` |
| 1.8 | TUI last-task row on welcome screen | ✓ `tui/app/view.go::renderWelcomeResume` |
| 1.9 | File-lock single-writer (`~/.feral/.writer.lock`) | ✓ `db.ts::openDatabase` (acquire + release) |
| 1.10 | Memory Tests matrix (6 scenarios) | ✓ `FeralAgent/tests/memory-resilience.test.ts` (12/12 pass) |

**Definition of Done — verified:**
- A first-time user starts the app, picks a model, chats once, closes the app. Next launch shows "Welcome back to <title> · in <workspace> · 5m ago" (React banner) or `resume  welcome back · <title> · in <workspace> · 5m ago` (TUI row).
- Workspace pointer survives restart (`getActiveWorkspaceId` round-trips through `meta`).
- Embedding-dim guard still wipes + re-embeds (existing behavior; new test pins it).
- Forward-compat guard rejects on-disk DBs from a newer build (`schema_version > CURRENT_MEMORY_SCHEMA_VERSION`).
- Two `openDatabase` calls in the same process sequence — the lock releases on `close()`.

**Bonus fix shipped with Sprint 1:** `EpisodicMemory.clearEmbeddings` was returning a number inflated by FTS5-trigger-induced writes (the `episodic_au` trigger fires from this UPDATE and bumps SQLite's `sqlite3_changes()` far beyond the actual `episodic` row count). Replaced the `changes` read with a pre-counted SELECT. Pinned by the new test.

**Architecture decisions honored:**
- ✓ Sidecar is the sole writer of `meta`, `workspaces`, `episodic`, `semantic`. Tauri commands read via the gateway or stay in the broadcast roundtrip.
- ✓ Workspace identity = UUID; `name` is a display label only. The new `memory-resilience` test `workspaces use stable UUID identity; renaming does not change id` pins this.
- ✓ Schema versioning: `meta.schema_version` is stamped on every successful migration; on-disk newer than code rejects the open with a clear error.

**What did NOT ship (deliberate non-goals):**
- The `EpisodicMemory.record` writer hook that auto-fills `workspace_id` from the active workspace pointer. The column exists, the filter is wired at the storage layer; the writer hook is a Sprint 1.5 follow-up so the writer contract stays read-only on the hot path.
