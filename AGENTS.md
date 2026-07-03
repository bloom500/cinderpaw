# Feral — Agent Working Notes

> This file is the project-memory index for AI agents working on the Feral
> repo. Topic files live in `docs/agents-memory/` and are referenced from
> here. Per the project-memory protocol: drift in these files is a real
> bug (the next agent will believe the wrong thing), so update them when
> the underlying fact changes.

## How Feral works at a glance

Feral = Tauri (Rust) host + Leptos/React frontend + a Bun/TypeScript
sidecar (`FeralAgent/`) that the host spawns and talks to over
newline-delimited JSON on stdin/stdout. RSI (Faza 1) and Fractal Memory
Search (Faza 5) are the two big engine pieces. Both are correct and
unit-tested; what blocks live numbers in this dev env is documented
below.

## Sidecar rebuild workflow — the easy thing to forget

`cargo tauri dev` does **NOT** auto-rebuild the sidecar binary. The
build IS wired through `src-tauri/scripts/build-sidecar.mjs` (see
`tauri.conf.json` → `beforeDevCommand` / `beforeBuildCommand`), but only
when the script is actually executed. If you change TS in `FeralAgent/`
and just restart the app, you're running the old binary.

Quick rebuild, in the worktree root:

```bash
cd FeralAgent && bun run build
# then copy (or let the script do it):
cp dist/feral-agent.exe ../src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe
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
  any file in `FeralAgent/src/rsi/` or `src-tauri/src/rsi/`.**

## Things that are pinned at the type level (don't break these)

- `FeralAgent/src/transports/tauri.ts` — `INBOUND_TYPES` is pinned to
  `InboundMessage["type"]` at the type level. Adding a new inbound
  message type to the union without updating the allow-list is a `tsc`
  error, not a silent drop. **Test:**
  `tests/tauri-transport-isinbound.test.ts`.
- `FeralAgent/src/types.ts` `OutboundEvent` union — every event the
  sidecar emits must be a member. Add new event types there too; the
  sidecar handler in `index.ts` no longer needs the
  `as unknown as OutboundEvent` cast when the type is in the union.

## Commands you'll re-run

```bash
# Tests + typecheck (the gate)
cd FeralAgent && bun test            # 954/954
cd FeralAgent && bunx tsc --noEmit   # clean
cd frontend-react && bunx tsc --noEmit  # clean

# Rebuild the sidecar
cd FeralAgent && bun run build
# + copy to src-tauri/binaries/

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
