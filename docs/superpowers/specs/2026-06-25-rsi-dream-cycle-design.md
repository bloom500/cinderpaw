# RSI Dream Cycle — Design Spec

**Date:** 2026-06-25
**Status:** Approved design (brainstorming) → next: implementation plan
**Audit item:** B1 (Critical) in `docs/audits/2026-06-25-production-readiness-audit.md`
**Bar:** True RSI that is reliable, token-economic, and not "self-improvement slop".

## Problem

The RSI / fractal-search engine is event-driven and healthy *internally*
(`FeralAgent/src/rsi/event-bus.ts`, `engine.ts`). The defect is the **outer
scheduling**: `rsi/passive-supervisor.ts` autostarts at sidecar boot and runs a
**continuous always-on loop** with effectively-unbounded budgets:

- `passiveStartOptions` (`passive-supervisor.ts:90-99`): `maxIterations 100_000`,
  `maxTotalTokens 1_000_000_000`.
- `onRunEnded → scheduleRestart` (`:147-163`): re-launches the engine ~5s after
  every run end, forever.

With a cloud model this burns user tokens with **no prompt**. This diverges from
the recorded event-driven design and from the literature (survey arXiv 2507.21046:
triggers = task / threshold / **error** / schedule — *not* a clock).

**Key insight (verified in code):** the engine math is fine. The fix is a
**surgical swap of the scheduler only** — *when* to launch an episode and *with
what budget*. The engine's population, ratchet, extinction, PBT, champion
projection all stay untouched.

## Goals / Non-goals

**Goals**
- Replace the continuous loop with an **event-driven Dream Cycle**: run one
  *bounded* episode, then **sleep** until the next trigger.
- Triggers: **idle** (user inactive) + **error** (real failures accumulate).
- Per-episode budget cap on **multiple dimensions, whichever fires first**.
- **Full evolutionary continuity** across sleeps (respect genomes / lineage /
  extinction / PBT) — a dream cycle resumes exactly where it left off.
- **Local-only by default** (USD cost cap 0); cloud requires explicit opt-in.
- Keep the existing **champion** projection + persistence; layer the new
  population snapshot on top, with champion as the degraded-resume fallback.
- Emit minimal **telemetry** per episode (hook toward audit B3).

**Non-goals**
- No changes to engine evolutionary math (selection, mutation, ratchet,
  extinction, PBT, taste, escape-time).
- Full RSI telemetry/observability dashboard (separate item B3).
- Incremental FMS indexing, embedder re-benchmark, etc. (separate backlog items).

## Architecture

Swap **scheduling only**. `PassiveSupervisor` → `DreamScheduler`. The engine and
its bus are unchanged. The host (Rust) gains **no new logic**: the inbound
`message` it already forwards (`transports/tauri.ts:142` `INBOUND_TYPES`) becomes
the activity clock.

```
boot
  └─ DreamScheduler.start()        # arms idle timer; does NOT launch engine now
       ├─ idle trigger  ─┐
       ├─ error trigger ─┤→ launch ONE bounded episode
       │                 │     └─ engine resumes population snapshot
       │                 │        evolves under caps (wall-clock/iters/tokens/plateau)
       │                 │        cap hit → graceful stop (drain in-flight)
       │                 │        persist snapshot + champion
       │                 └→ SLEEP (cooldown) → re-arm idle timer
       └─ kill switch: FERAL_RSI_PASSIVE=false → fully disabled
```

## Components (isolated, testable units)

### 1. `rsi/dream-scheduler.ts` (new) — lifecycle brain
Replaces `PassiveSupervisor`. Pure + injectable (clock + timers), so the
sleep/wake lifecycle is deterministic in tests.

Responsibilities:
- Arm an idle timer; on idle threshold reached **and** not already running **and**
  cooldown elapsed → launch a bounded episode.
- On error trigger (from `ActivityMonitor`) → launch a targeted bounded episode
  immediately (even if not idle), still bounded.
- On run end (the existing `onIdle` callback path, `sidecar.ts:407/417`) → **do
  not** immediately restart; enter SLEEP + start cooldown, then re-arm idle.
- `shutdown()` breaks the loop on teardown (keep current semantics).

Reuses the existing boot gate `shouldAutostartPassive(env)`
(`passive-supervisor.ts:52-66`) for the disable/placeholder-model checks — that
logic is good and stays (possibly renamed).

### 2. `rsi/activity-monitor.ts` (new) — signal source
Pure. Fed from the sidecar's inbound-message switch in `FeralAgent/src/index.ts`.
Tracks:
- `lastActivityAt` — updated on inbound `message` and on tool/agent activity.
- a rolling **error window** — counts agent/eval errors within a time window.

Exposes: `idleFor(now): ms since last activity`, `errorsInWindow(now): number`.
No timers of its own — the scheduler owns time.

### 3. `episodeStartOptions(env)` (replaces `passiveStartOptions`)
Small, bounded defaults; every value env-overridable (operator tuning without
code). Produces an `RsiStartOptions` (`sidecar.ts:66-73`) with:
- `maxIterations` (small, e.g. 40)
- `maxTotalTokens` (bounded local cap)
- `maxTotalCostUsd: 0` (local-only default)
- plus the two new GoalMode caps below, passed through `GoalConfig`.

### 4. GoalMode — two new stop reasons
Add to `rsi/goal-mode.ts` `GoalConfig`:
- `maxWallClockMs` — episode wall-clock cap (timer-based; cannot hang).
- `plateauIterations` — stop early after N iterations with no new ratchet.

Both must drain in-flight evals and emit `stopped` with the precise
`stopReason`, matching existing stop semantics (`sidecar.ts:393-408`).
Existing `maxIterations` / `maxTotalTokens` / `maxTotalCostUsd` are unchanged.
**Whichever cap fires first ends the episode.**

### 5. `rsi/population-snapshot.ts` (new) — full evolutionary continuity
Serialize/deserialize the complete evolutionary state so a dream cycle resumes
exactly where it stopped:
- `PopulationManager` genomes + lineage + per-genome fitness,
- extinction state, recalcitrance + escape-time tracker state.

Persisted atomically to `~/.feral/rsi/population.json` at **episode end**
(best-effort, same discipline as `writeChampion`, `sidecar.ts:368-372`).
Resumed at **episode start**. PBT strategy population already persists in the DB
(`loadStrategyGenomes`/`persistStrategyGenomes`, `sidecar.ts:498-544`) — reused
as-is.

**Resume cascade (degraded-resume):**
`population.json` (full) → if missing/corrupt → `champion.json` (best-only,
current behaviour `sidecar.ts:151-154`) → if absent → cold seeds
(`defaultEngineSeeds`). Never throws; a bad snapshot logs + falls through.

### 6. Telemetry hook (toward B3)
On each episode start/stop, append one JSONL line: trigger reason, duration,
iterations, tokens, ratchets, stop reason. Minimal but makes the loop
observable. Full telemetry remains separate (B3).

## Defaults (operator-overridable via env)

| Knob | Default | Env |
|------|---------|-----|
| Idle threshold | 3 min | `FERAL_RSI_IDLE_MS` |
| Cooldown between episodes | 10 min | `FERAL_RSI_COOLDOWN_MS` |
| Error trigger | ≥3 errors / 15 min | `FERAL_RSI_ERROR_*` |
| Episode wall-clock cap | 8 min | `FERAL_RSI_EPISODE_MS` |
| Episode iteration cap | 40 | `FERAL_RSI_MAX_ITER` |
| Episode token cap | bounded local | `FERAL_RSI_MAX_TOKENS` |
| Plateau (no-ratchet) stop | 12 iters | `FERAL_RSI_PLATEAU_ITERS` |
| Cost cap | USD 0 (local-only) | `FERAL_RSI_MAX_COST_USD` |
| Cloud auto-dream | **off** unless opt-in | `FERAL_RSI_ALLOW_CLOUD` |
| Stop episode on user return | off (local), recommended on for cloud | `FERAL_RSI_STOP_ON_ACTIVITY` |
| Kill switch | enabled | `FERAL_RSI_PASSIVE=false` |

**Cloud anti-burn rule:** if the active model is a cloud (non-loopback) model,
the Dream Cycle does **not** auto-trigger unless `FERAL_RSI_ALLOW_CLOUD` is
explicitly set. Loopback detection already exists (`sidecar.ts:290-296`).

## Error handling & robustness

- All persistence (snapshot, champion) is **best-effort + atomic**; failures
  never abort the engine cascade (matches `sidecar.ts:368-377`).
- Corrupt/incompatible snapshot → degraded-resume cascade (§5), logged, never
  crash.
- Wall-clock cap is timer-based, so an episode **cannot hang** indefinitely.
- `FERAL_RSI_PASSIVE=false` disables the whole Dream Cycle (kept from today).
- Placeholder/empty model → no autostart (kept: `shouldAutostartPassive`).

## Data flow detail

1. **Boot:** `index.ts` builds `DreamScheduler` (replacing `PassiveSupervisor`,
   `index.ts:726/753-757`), wires `start: () => rsiSidecar.start(episodeStartOptions(env))`
   and feeds `ActivityMonitor` from the inbound `message` switch. Scheduler arms
   idle timer; **no immediate engine launch**.
2. **Idle reached:** scheduler launches one episode → engine resumes snapshot →
   evolves under caps → first cap hit → graceful stop → `stopped` event →
   `onIdle` → persist snapshot+champion → SLEEP+cooldown → re-arm.
3. **Error trigger:** crossing the error window launches a bounded episode now
   (subject to cooldown), same lifecycle.
4. **User returns mid-episode:** local default lets the short bounded episode
   finish; `FERAL_RSI_STOP_ON_ACTIVITY=true` (recommended for cloud) stops it via
   `engine.gm.stop()`.

## Testing strategy

- **`DreamScheduler`** (injected clock/timers, deterministic):
  - does not launch while a run is active;
  - launches on idle threshold; sleeps (no immediate restart) on run-end;
  - wakes on error trigger; respects cooldown;
  - `shutdown()` stops re-arming.
- **`ActivityMonitor`** — pure, table-driven: idle computation, error window
  expiry.
- **`population-snapshot`** — round-trip equality; corrupt-file fallback to
  champion; absent → cold seeds.
- **GoalMode new stops** — `maxWallClockMs` and `plateauIterations` fire and
  drain, emitting the correct `stopReason`.
- **Migration test** — passive autostart no longer loops continuously
  (the old `onRunEnded → immediate restart` behaviour is gone).

## Migration / blast radius

- **Replaced:** `rsi/passive-supervisor.ts` (`PassiveSupervisor`,
  `passiveStartOptions`, `STANDING_GOAL` kept as the episode goal).
- **Touched:** `FeralAgent/src/index.ts` wiring (`:60-64`, `:726`, `:750-757`,
  `:1162-1168`); `rsi/goal-mode.ts` (two stop reasons); `rsi/sidecar.ts` resume
  cascade + snapshot persist on run-end.
- **New:** `dream-scheduler.ts`, `activity-monitor.ts`, `population-snapshot.ts`,
  telemetry append.
- **Unchanged:** event-bus, engine wiring, selection/mutation/ratchet/extinction/
  PBT/taste/escape-time, champion projection (the Crux).
- **Rebuild note:** sidecar is compiled to `.exe`; any TS change needs
  `bun run build` + copy to `src-tauri/binaries/` to take effect (per project
  memory).

## Open questions (resolved in brainstorming)

- Trigger model → **idle + error** (respecting genomes/eval/extinction).
- Episode budget → **wall-clock ∧ iters ∧ token/cost ∧ plateau, first-to-fire**.
- Continuity → **full population + lineage + extinction** persisted across sleeps.
- Champion → **kept**, as live-agent projection + degraded-resume fallback.
