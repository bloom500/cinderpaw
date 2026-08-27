# OPUS Checkpoint — 2026-08-24 — FULL SESSION HANDOFF (v2)

**Branch stack (all local, none pushed, stacked in this order):**

```
voice-release
└── checkpoint/brsi-safe-audit-20260824   2001973, d36c2a7
    └── fix/rsi-hud-stale                 4b2f7ad
        └── fix/tui-view-layout-loop      528f72b
            └── fix/verify-sh-package-rename 7875d50
                └── fix/cloud-stop-during-tools e05a885
                    └── fix/rename-drift-guards 58ffcfe, 6dbf368
                        └── feat/arc-perception-dsl 6ee2ee4
                            └── ui/glass-black-matte c8f4acb, f195d64,
                                3d79c90, 59f7018, 021d8c1, 2b698e7,
                                518d252, 615d427 ← TIP (running build)
```

Everything below was done by opencode on 2026-08-24. Nothing merged anywhere.
Verify by reading the diffs commit-by-commit; every claim has a test or a log.

---

## Commit-by-commit receipts

### checkpoint branch
1. **`2001973` chore(brsi): tag I10/I11/I12** — 6 files, only `// INVARIANT`
   comments. Coverage checker went from ignoring these to ✓Test/✓Runtime for
   I10/I11/I12. Audit pillar intentionally NOT faked.
2. **`d36c2a7` fix(safe)** — brain.json malformed → derived fallback instead of
   boot crash; dispatchMessage unhandled rejection logged; leaf-store
   `#persist()` try/catch; lora `#save()` atomic write. Verified pre-commit:
   tsc clean + targeted tests.

### fix/rsi-hud-stale (`4b2f7ad`)
MemoryLayersPage stored the RSI snapshot in a ref and "touched" render with
`setNow(n => n)` — Object.is bail meant the HUD pill froze on its initial phase.
Snapshot is React state now; store emits fresh object per update.

### fix/tui-view-layout-loop (`528f72b`)
`tui/app/view.go` wrote `ChatVP.Height/Width` unconditionally every repaint
(wizard + chat branches). Now stores only on change; width changes force a
viewport rebuild too (prevChatH only covered height). go test ./... green.

### fix/verify-sh-package-rename (`7875d50`)
verify.sh ran `cargo test -p feral`; package renamed to `cinderpaw-core` —
gate dead for everyone. 1-line fix. NOTE: bash is absent on this box, so
verify.sh still can't run as-is; steps were executed manually in PowerShell.

### fix/cloud-stop-during-tools (`e05a885`)
Cloud BYOK agentic loop only checked the stop flag at iteration top → Stop
during a long tool call appeared dead. New `execute_with_stop` races the tool
future against a 100ms stop-watcher via `tokio::select!{ biased }`. Dropping
the future cancels reqwest requests; code_execute child is kill_on_drop.
chat:: tests 5 pass; full `-p cinderpaw` suite green.

### fix/rename-drift-guards (`58ffcfe`, `6dbf368`) — both PRE-EXISTING failures
- **SECURITY**: desktop-control HARD_DENY listed only `"feral"`; process is now
  `cinderpaw.exe` → self-manipulation guard stopped matching the app's own
  binary. Added `"cinderpaw"`, kept `"feral"` for old builds. Test pinned it.
- commands baseline 156→160 (+ LiveKit quartet: start_livekit_call,
  end_livekit_call, list_s2s_providers, stt_local_available).
- Both reproduced failing WITHOUT my changes before fixing (git stash proof).

### feat/arc-perception-dsl (`6ee2ee4`) — ARC-AGI foundation, spec Steps 1-2
Strict rules honored: ONLY new files, zero deps, zero imports from existing
code, nothing wired into index.ts / rsi/repl.ts / core / brain / rsi.
- `src/types/perception.ts` — SpatialObject/SpatialRelation/SceneGraph schema
  verbatim from docs/cinderpaw-agi-harness-spec.md.
- `src/research/perception/scene-graph.ts` — parseSceneGraph (CCA
  8-connectivity), bbox/shape/symmetry-on-own-bbox, relation graph with
  documented deterministic semantics, dominantColors, YAML formatter.
- `src/rlm/dsl/primitives.ts` — rotate/mirror/shift/crop/floodFill/
  applyGravity/recolor+replaceColor/selectByColor/selectLargest/Smallest.
  All pure, all loud errors ("what's wrong + what was expected").
- Tests: 53 new (properties: rotate⁴=id, mirror²=id, gravity idempotent,
  same-color floodFill terminates, full-bbox crop = id, purity guard asserting
  no primitive mutates input). Full gates at commit time:
  `bun test` 3200 pass/0 fail; `tsc --noEmit` clean (both re-run after).

### ui/glass-black-matte (5 commits) — visual polish + two real bug fixes
- `c8f4acb` dark glass: brightness(0.30) crushed wallpaper into bottom 76
  levels (matte showing nothing). Solved against the exact worst-case model in
  src/test/glass.test.ts (all 9 text roles ≥4.5:1 over white AND black
  wallpapers, bare + over bg-surface/bg-elevated).
- `f195d64` more transparent both themes (dark tint 0.49→0.25 then…)
- `18b26b9` user said still not BLACK → tint 0.48, contrast(0.35),
  brightness(0.36); scene lights 0.16→0.08 (amber wash was the grey-brown
  read). Band now 23–40. Worst-case contrast ROSE to 6.79:1 (whiter disabled
  token freed headroom). Latest pill solid; Cloud Keys cards own material.
- `3d79c90` (a) text halo: 1px OFFSET shadow read as faux-bold on small input
  text per Darius → replaced with same-centre 1px halo. (b) reconciler fact
  branch silently dropped leaves when embed() failed (console.debug only) —
  upgraded to loud warns with fact text + reason.
- `59f7018` HOST LOGGING: tracing_subscriber wrote to stdout = invisible in a
  GUI process. Now appends to `~/.cinderpaw/logs/cinderpaw.log` (reopen-per-
  write, no new deps). First boot with it caught the root cause below.
- `021d8c1` MASTER Dream toggle + retry fix:
  - Settings field `dreams_enabled` (**default OFF**) → exported as
    `CINDERPAW_DREAMS_ENABLED`; sidecar arms the scheduler ONLY when true.
    Behavior change vs before: dreaming used to auto-arm locally. Opt-in now,
    local and cloud alike. Command `set_dreams_enabled` (persist + env +
    sidecar restart); EXPECTED_COMMAND_COUNT 160→161; FE bindings/store/
    switch in CinderpawDreamsPanel (leads with it).
  - Retry after provider switch could land with BOTH model slots transiently
    empty → fell into LOCAL pipeline → misleading "No local model is loaded".
    useSendMessage now fails fast: "No model selected yet — pick a model from
    the picker above, then retry."
- `2b698e7` final glass dial after Darius reviewed screenshots: tint neutral
  rgb(10,10,12) (was warm 16,14,9) and dark-theme scene-light trace 0.08 → 0.
  Verified by Darius visually (screenshot review loop). Glass contract 51/51.
- `518d252` material switch: see-through glass can NEVER read as pure black
  (text floors pin its ceiling at ~rgb 66 over white wallpaper), so dark
  switched to Windows-11-style acrylic — tint alpha 0.78 does the darkening,
  brightness(0.80), no compression. Band rgb(8)…rgb(53), worst 5.59:1.
- `615d427` +5% transparency (tint 0.73). NOTE: 0.73 is the feasibility
  edge — 0.70 measures 4.40:1, below AA. Do not lower without changing the
  text palette too.

## Machine-level change (outside git — Opus should know)
- `setx CINDERPAW_EMBED_GPU_LAYERS 0` (user env). Root cause found via the new
  log file: Vulkan embed crashed the ENTIRE sidecar at first embed attempt on
  this RX 580 box → that is why FMS fact capture died Aug 20 while
  conversations continued (graph mtime moved Aug 22, leaves stuck Aug 20 —
  observation branch alive, fact branch dying with the process).
- Sidecar rebuilt twice after TS changes (bun run build + copy to
  src-tauri/binaries); verified by scanning binary for new strings.
- Host exe rebuilt (cargo build -p cinderpaw) AFTER the dreams/logging Rust
  changes; running instance confirmed gating: log shows
  `rsi dream: not arming scheduler (dreaming is opt-in …)`.

## Evidence snapshot (at tip, before this file)
- CinderpawAgent: `bun test` 3200 pass / 14 skip / 0 fail; `tsc --noEmit` clean.
- frontend-react: vitest 586 pass (69 files) incl. 51 glass contract tests;
  `tsc --noEmit` clean.
- Rust: cargo check clean; `-p cinderpaw` 123 pass / 0 fail;
  `-p cinderpaw-core` ~393 pass / 0 fail.
- TUI: go test ./... + go build ./... green.

## Open items / what Opus should scrutinize
1. **self_describe lies about the leaf store**: reports
   `leaf_store_exists:false, 0 leaves` while disk has 318 leaves / 7.2MB at
   `~/.cinderpaw/agent/fractal-leaves.jsonl`. Suspect it reads in-memory
   state instead of disk truth. Not fixed here (sidecar introspection surface
   = substrate-subsystem territory).
2. **Dream default flipped OFF** — intentional, but it IS a behavior change
   for existing installs (they must flip the switch in Settings → Agent →
   Cinderpaw's Dreams). If you disagree, the revert is one serde default.
3. **Glass numbers are solver-derived** against the test's model
   (contrast()/brightness() linear math, saturate ≤1 asserted). If you change
   the filter chain, re-run src/test/glass.test.ts first — it is the contract.
4. verify.sh still needs bash; consider a PowerShell twin script.
5. The ARC work stops at spec Step 2. Step 3 (core/mcts-verifier.ts) not
   started — waiting on your integration of perception/DSL into RLM REPL, or
   say the word and I continue on top of feat/arc-perception-dsl.
6. Sidecar stderr now lands in ~/.cinderpaw/logs/cinderpaw.log via host
   tracing (info level). If volume becomes a problem, add rotation later.
7. OPUS_CHECKPOINT v1 claims above are superseded by this file.

## How to verify quickly
```powershell
git checkout ui/glass-black-matte
cd CinderpawAgent; bun test; bunx tsc --noEmit          # 3200 pass, clean
cd ../frontend-react; bunx vitest run --pool=threads --maxWorkers=1; bunx tsc --noEmit  # 586 pass, clean
cd ..; cargo test -p cinderpaw                          # 123 pass
cargo test -p cinderpaw-core                            # ~393 pass
cd tui; go test ./...; go build ./...                   # green
```

*Generated 2026-08-24 by opencode — every number above was produced on this
machine during this session.*
