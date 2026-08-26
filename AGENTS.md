# Cinderpaw — Agent Working Notes

> This file is the project-memory index for AI agents working on the Cinderpaw
> repo. Topic files live in `docs/agents-memory/` and are referenced from
> here. Per the project-memory protocol: drift in these files is a real
> bug (the next agent will believe the wrong thing), so update them when
> the underlying fact changes.

## Agent rules (all models, all sessions)

- Never work on `main`. One branch per task.
- No refactoring outside the stated task. No drive-by "improvements".
- Prefer the smallest measured fix that satisfies acceptance. Do not add abstractions,
  redesign adjacent systems, or expand scope when a local change and focused test suffice.
- Do NOT modify unless the task names them explicitly:
  `useCallSession.ts`, `vad.ts`, the Rust audio pipeline, `mcp.json`.
- Before declaring done, run `./scripts/verify.sh` — CinderpawAgent tests/typecheck,
  React tests/typecheck, Rust workspace check/Tauri tests, and TUI tests/build
  must all be green.
- Keep diffs small. If a task needs more than 3 files, stop and ask.
- Do not invent library APIs. If unsure, stop and report instead of guessing.
- Conventional commits. One logical change per commit.

## How Cinderpaw works at a glance

Cinderpaw = Tauri (Rust) host + Leptos/React frontend + a Bun/TypeScript
sidecar (`CinderpawAgent/`) that the host spawns and talks to over
newline-delimited JSON on stdin/stdout. RSI (Faza 1) and Fractal Memory
Search (Faza 5) are the two big engine pieces. Both are correct and
unit-tested; what blocks live numbers in this dev env is documented
below.

## Sidecar rebuild workflow — the easy thing to forget

`cargo tauri dev` does **NOT** auto-rebuild the sidecar binary. The
build IS wired through `src-tauri/scripts/build-sidecar.mjs` (see
`tauri.conf.json` → `beforeDevCommand` / `beforeBuildCommand`), but only
when the script is actually executed. If you change TS in `CinderpawAgent/`
and just restart the app, you're running the old binary.

Quick rebuild, in the worktree root:

```bash
cd CinderpawAgent && bun run build
# then copy (or let the script do it):
cp dist/cinderpaw-agent.exe ../src-tauri/binaries/cinderpaw-agent-x86_64-pc-windows-msvc.exe
```

Verify the fix landed: scan the binary for the new string.

```powershell
$bytes = [IO.File]::ReadAllBytes('<binary>')
[Text.Encoding]::UTF8.GetString($bytes) -match 'your-new-string'
```

## Topic files

- **`project_fractal_bench_blockers.md`** — what's actually blocking the
  Fractal bench from producing live numbers on this dev box (GPU crash
  on embed, rebuild thrashing). Pipeline is correct.
- **`project_fractal_activity_pulses.md`** — the three `fractal_activity`
  event kinds (`grow` / `recall` / `seed`) and the regression guard
  for the per-iteration pulse. Read before touching the organism
  wiring.
- **`reference_windows_vulkan_build.md`** — the Windows Vulkan build
  recipe that finally worked (cl 14.44 + Ninja + short `CARGO_TARGET_DIR`).
  Re-use when next fighting llama.cpp × MSVC.
- **`project_local_models_gpu.md`** — the on-disk models, the bge-small
  Vulkan crash, the `FERAL_EMBED_GPU_LAYERS=0` knob, and the
  `discover_active_model` "wrong chat model" footgun (now fixed).
- **`project_brsi_evolution.md`** — the BRSI (Bounded RSI) work: locked
  decisions (D1-D10), audit summary of the existing engine, refactor
  sequence (10 steps), landmines for any contract / dream-cycle work,
  and the opencode-vs-Opus division of labor. **Read before touching
  any file in `CinderpawAgent/src/rsi/` or `src-tauri/src/rsi/`.**
- **`project_brain_stack.md`** — Brain Stack (Faza 4.6) engine that picks
  the right model per task. Slice 1 done (CapabilityRegistry +
  `isConfigured`); Slice 2 plan (task classifier) + the four-
  responsibility split (Registry=Data / Router=Policy / Health=Observation
  / Cost=Optimisation). **Read before touching any file in
  `CinderpawAgent/src/brain/`.**
- **`project_memory_roadmap.md`** — rebalanced post-audit roadmap
  (Memory Foundation before Onboarding). Three sharpenings to the
  audit's implementation order + the writer contract design. Read
  before touching `CinderpawAgent/src/memory/`, `CinderpawAgent/src/db.ts`,
  `src-tauri/src/memory_*.rs`, or any `workspace_id` migration.
  **Sprint 1 (Memory Foundation + Memory Resume) + Sprint 2 (Terminal +
  Desktop Onboarding) shipped 2026-07-06** — see the Status table at
  the bottom of the file for the file-level landing points of every
  shipped item.
- **`project_chat_tui.md`** — `feral chat` is a Go/Bubble Tea TUI
  (`tui/`, launched by `crates/feral-cli/src/chat.rs`). Also flags the
  open follow-up: local-Ollama reasoning for models like MiniMax-M3
  arrives inline in `content` (no `think` tags), so the TUI cannot
  split it — needs a sidecar fix (`CinderpawAgent/src/sandbox/inference-providers.ts`
  local path) or a host-side `delta.reasoning_content` forward. **Read
  before touching chat reasoning rendering or the local Ollama path.**
- **`project_arc_agi3_campaign.md`** — ARC-AGI-3 public demo campaign: test
  plan (4 models × 4 harness stages on vast.ai RTX PRO 6000 WS 96GB), score
  targets anchored to NVIDIA AVO's verified 100% public-set result, budget
  (~$15-35), and the foundation branch (`feat/arc-perception-dsl`). **Read
  before any work on ARC modules or the campaign.**
- **`project_agent_cowork.md`** — Agent Cowork research baseline (Grok Bot /
  Claude Cowork / ChatGPT Work, Aug 2026) + design sketch: persistent named
  agents, shared workspace with ownership locks, A2A handoff protocol,
  approval-gated escalation, routines. Slice plan S1–S5 inside; design
  decisions locked 2026-08-25 (SQLite storage, TUI-first surface, v1
  strictly reactive). **Read before any work on cowork agents,
  mailboxes/handoffs, or worker loops.**
- **`project_voice_mode_followups.md`** — open voice-mode regressions queued for
  2026-08-17: the user's new turn can take 15–30 seconds to appear after the
  agent finishes speaking, long prompts overwhelm the transcript beneath the
  sphere, and claimed search/task activity has no visible tool widget or other
  execution evidence. Includes a 2–3 hour continuous-conversation reliability
  requirement. **Read before investigating voice transcript latency, transcript
  presentation, or voice-mode tool activity rendering.**
- **`project_tui_onboarding_sprint3.md`** — Sprint 3 onboarding in the
  TUI (`tui/`): `WizTestIt` step (real "Hello." round-trip before chat
  opens), "What's next" suggestions after wizard, recovery auto-retry on
  backend disconnect, "Welcome back" last-task row, enhanced backend
  liveness in header. Implemented 2026-07-06. **Read before touching
  wizard flow, recovery, or the welcome screen.**
- **`project_tui_connectors_f4.md`** — F4 real connectors: chat-platform
  connector configuration from the wizard (Discord/Slack/WhatsApp/Telegram).
  Token-based connectors get field-by-field masked input (like the API key
  step); WhatsApp (QR) uses Y/n toggle. Config is persisted to
  `~/.feral/connectors.json` and sidecar reloaded via
  `POST /runtime/connectors/reload`. Implemented 2026-07-06. **Read before
  touching WizConnectorPrompt, connector state fields, or
  `api.SaveConnectorConfig`.**
- **`project_tui_wizard_f3.md`** — F3 wizard health check (4-phase granular
  checks: API reachable → auth valid → model accessible → streaming
  round-trip with deterministic `FERAL_OK` prompt), model picker with
  search, finish screen with bear compact + connection benchmark timing
  metrics. Implemented 2026-07-06.
- **`project_substrate_introspection.md`** — `self.*` runtime
  introspection surface (`CinderpawAgent/src/tools/builtin/self.ts`) +
  the `feral-self` and `feral-connectors` skills. This is the
  agent's mental model of its own substrate (BRSI / FMS / LoRA /
  Dreaming / Genomes / Connectors / Brain Stack / Memory). Use the
  `self_*` tools, don't dump substrate docs into the prompt or open
  `~/.feral/` to the agent's filesystem tools — both lose. **Read
  before adding/changing a `self_*` tool, the SUBSYSTEMS catalog,
  or any path that says `~/.feral/` somewhere in it.**

## Things that are pinned at the type level (don't break these)

- `CinderpawAgent/src/transports/tauri.ts` — `INBOUND_TYPES` is pinned to
  `InboundMessage["type"]` at the type level. Adding a new inbound
  message type to the union without updating the allow-list is a `tsc`
  error, not a silent drop. **Test:**
  `tests/tauri-transport-isinbound.test.ts`.
- `CinderpawAgent/src/types.ts` `OutboundEvent` union — every event the
  sidecar emits must be a member. Add new event types there too; the
  sidecar handler in `index.ts` no longer needs the
  `as unknown as OutboundEvent` cast when the type is in the union.

## Commands you'll re-run

```bash
# Tests + typecheck (the gate)
cd CinderpawAgent && bun test            # 954/954
cd CinderpawAgent && bunx tsc --noEmit   # clean
cd frontend-react && bunx tsc --noEmit  # clean

# Rebuild the sidecar
cd CinderpawAgent && bun run build
# + copy to src-tauri/binaries/

# TUI (Go/Bubble Tea)
cd tui && go test ./...          # all tests (4 packages — wizard, app, api, ui)
cd tui && go build ./...         # verify compilation

# Cargo (may need: vcvars64 + CMAKE_GENERATOR=Ninja + CARGO_TARGET_DIR=D:\fb)
cargo build --features inference
```

## Out-of-scope TODOs (don't touch in current slice)

These are pre-existing items noticed while doing Faza 4.5 work; they
are NOT blockers for the current slice and should be addressed in their
own slice.

- `crates/feral-core/src/inference.rs` — `max_contexts()` method is
  dead (no caller; pool caps go through `effective_pool_cap(_with_env)`).
  Has an inline `// TODO(inference)` marker. Out of scope for Slice 2.
