# BRSI Layer 4 — Architecture Evolution: Specification

**Date:** 2026-07-04 · **Author:** Fable (architecture) · **Implementer:** another model (Sonnet/MiniMax) — this document is the contract.
**Status:** SPEC ONLY. Artifact paths verified on branch `feat/faza4-5-runtime-extraction`.

## 0. Mandate

L4 lets Feral grow **new architectural components** — planners, retrieval/memory strategies, runtime modules — as *additions behind fixed seams*, never as edits to the runtime.

Three hard rules, stated up front because everything below derives from them:

1. **L4 may create new planners, memory systems and runtime modules.**
2. **L4 may NEVER modify the runtime directly.** No file inside `FeralAgent/src/` (or any repo source) is written by L4. This is what separates L4 from L3 (code-RSI, which patches existing sources through the worktree + approval pipeline).
3. **Everything happens inside isolated sandboxes.** A candidate module has no filesystem, no network, no environment access until promoted — and even then, only what its manifest declares.

The consequence of rule 2 is the central design decision: the runtime exposes a small set of **seams** (typed extension points with a builtin default), and L4 modules are *plugged into* seams via a registry. The runtime's own code never changes; the registry's mapping does. Rollback is therefore always "point the seam back at the builtin" — O(1), no rebuild, no git.

### Distinction from L3 (do not blur it)
| | L3 code-RSI | L4 architecture |
|---|---|---|
| Object | unified diff over existing repo sources | new, self-contained module directory |
| Danger | can change anything → worktree + policy wall + human gate | cannot touch runtime → sandbox host + seam contract + human gate |
| Rollback | `git apply -R` + rebuild (Faza 3 watchdog) | registry re-points to builtin, instant |
| Reuses | `code-sandbox.ts`, `pending-patches.ts` | envelope + registry + module host (new) |

### Non-goals (v1)
- No new seams beyond the two below; no module-defined seams.
- No module-to-module dependencies; no npm installs inside modules (single-file TS, stdlib only — enforced, §4).
- No hot-swap mid-episode; seam re-resolution happens at documented decision points.
- No LLM-driven module *generation* pipeline requirements beyond "a proposer produces a `ModuleCandidate`" — the generator (dream-cycle hook, operator file drop) is pluggable and out of scope here.

## 1. Seams (v1: exactly two)

A **seam** is a TS interface + a builtin implementation + a registry key. Seams live in runtime code (written once by humans/L3, not by L4).

### 1.1 `retrieval_strategy`
The natural first seam: `GenomeConfig.retrievalStrategy` (`FeralAgent/src/rsi/genome.ts`, pool `RETRIEVAL_STRATEGIES = ["episodic","semantic","graph","hybrid"]`) already treats retrieval as a selectable strategy. L4 extends the pool: a promoted module adds a fifth-plus entry, and **L1 evolution then selects it like any other** — L4 creates capability, L1 discovers whether it is fitter. This coupling is the payoff of the whole layer.

```ts
interface RetrievalStrategyModule {
  /** Rank/assemble context for a query. Pure request/response. */
  retrieve(req: { query: string; k: number; sessionId: string }): Promise<{
    items: Array<{ text: string; score: number; sourceId: string }>;
  }>;
}
```
Builtin = the current FMS paths (`FeralAgent/src/memory/fractal/`). The seam adapter feeds module results through the same context-assembly code the builtin uses — modules produce *candidates*, the runtime keeps final assembly.

### 1.2 `planner`
```ts
interface PlannerModule {
  /** Decompose a task into ordered sub-goals. Bounded by maxDepth. */
  plan(req: { goal: string; maxDepth: number; toolNames: string[] }): Promise<{
    steps: Array<{ description: string; suggestedTools: string[] }>;
  }>;
}
```
Builtin = the current implicit decomposition in `core/agent-loop.ts` (`decompositionDepth` genome field caps `maxDepth`). The agent loop consults the seam only when a planner module is active; builtin behavior is bit-identical to today when none is.

Both interfaces are **pure request/response over JSON-serializable values** — mandatory, because modules run out-of-process (§4).

## 2. Data Model

Paths under `~/.feral/rsi/modules/` (extend `InstancePaths` in `FeralAgent/src/rsi/instance-paths.ts`; the reserved `envelopes` dir gains its first real writer).

### 2.1 `ModuleManifest` (`modules/<id>/manifest.json`)

The manifest shape is **frozen in v1 including its forward-compat fields** — retrofitting versioning after modules exist in the wild is the one mistake this layer cannot recover from cheaply. Fields marked `v1: fixed` are validated but carry no behavior yet (see §12 for their deferred semantics).

```jsonc
{
  "schemaVersion": 1,                    // manifest schema. Loader rejects unknown values.
  "id": "mod-retrieval-recency-01",
  "seam": "retrieval_strategy",          // one of the v1 seams (from the seam catalog, §12.1)
  "seamApiVersion": 1,                   // version of the seam INTERFACE this module targets
  "compat": {                            // v1: validated, enforced at load (§12.2)
    "runtime": ">=2026.6.17"             // CalVer floor (see docs/RELEASING.md); loader refuses below
  },
  "requires": [],                        // v1: fixed — MUST be []. Reserved: module dependency ids (§12.3)
  "displayName": "Recency-weighted retrieval",
  "entry": "module.ts",                  // single file, relative, no escapes
  "permissions": [],                     // v1: MUST be [] — no fs, no net, no env
  "capabilitiesClaimed": {},             // v1: fixed — proposer HINTS only, NEVER consumed (§12.4)
  "limits": { "timeoutMs": 2000, "maxRssMb": 256 },
  "createdAt": 1751600000000,
  "sourceHash": "sha256 of module.ts",
  "proposedBy": "dream" | "operator"
}
```

Validation rules (loader, fail-loud): unknown `schemaVersion` → reject; `seamApiVersion` ≠ the catalog's current version for that seam → reject with a named reason (never crash at call time); `requires` non-empty → reject in v1; `permissions` non-empty → reject in v1; `capabilitiesClaimed` accepted but never read by any routing/promotion code path (negative test required, §11.11).

### 2.2 `ArtifactEnvelope` — reuse, don't reinvent
Provenance rides the existing `ArtifactEnvelope` type (`FeralAgent/src/rsi/provenance.ts`): extend its `kind` union with `"module"`. `parents` = incumbent module id (or `builtin:<seam>`), `data` = `{ manifest, evalReport, promotedAt, approvedBy }`. Envelope storage (`~/.feral/rsi/envelopes/`) is the module registry's source of truth for lineage; this implements the reserved write-path.

### 2.3 `ModuleRegistry` (`modules/registry.json` + append-only `modules/registry_history.jsonl`)
```jsonc
{
  "version": 1,
  "seams": {
    "retrieval_strategy": { "seamApiVersion": 1, "active": "builtin", "candidates": ["mod-retrieval-recency-01"] },
    "planner":            { "seamApiVersion": 1, "active": "builtin", "candidates": [] }
  }
}
```
The per-seam `seamApiVersion` is what makes runtime upgrades safe: when a runtime ships a breaking seam-interface change, it bumps the catalog version; every promoted module targeting the old version is **auto-demoted to builtin at boot** with a governance event and state `incompatible` (recoverable: re-evaluate against the new interface). Modules never crash the seam — they age out of it. (§12.2)
`active` is either `"builtin"` or a promoted module id. History rows record every re-pointing (who, when, why, from → to) — same append-only + temp-file+rename discipline as L6's `meta_history.jsonl`/`persist()`.

## 3. Lifecycle (state machine)

```
proposed ──scaffold──► sandboxed ──build ok──► built ──eval ok──► evaluated
    │                      │                     │                    │
    │                      └─build fail─► failed │  eval fail/timeout └─► failed
    │                                            ▼
    │                                    (gates §6: contract FSM + governance)
    │                                            │
    └──withdraw──► withdrawn         awaiting_approval ──approve──► promoted (registry: active)
                                             │                          │
                                             └─reject──► rejected       ├─demote/rollback─► retired (registry: builtin restored)
                                                                        └─crash/watchdog──► quarantined (auto, §8)
```

- Terminal states: `failed`, `withdrawn`, `rejected`, `retired`, `quarantined`, plus `incompatible` (auto-demote on seam-API bump, §12.2 — recoverable via re-evaluation). All keep their directory + envelope for forensics; nothing is deleted.
- At most **one** candidate per seam in flight past `built` (serialize evaluation; the eval runner fights for the model like LoRA training does — mirror the `loraTrainBusy` one-at-a-time discipline in `FeralAgent/src/index.ts`).
- Every transition appends to `registry_history.jsonl` **and** calls the L5 governance check (§7).

## 4. Sandbox (the module host)

Modules never run in the sidecar process. A **module host** is a separate Bun subprocess:

- Spawned per active/evaluating module: `bun run module-host.ts <moduleDir>` where `module-host.ts` is runtime code that imports the module's `entry` and speaks **JSON lines over stdin/stdout** — the exact transport discipline already proven by the sidecar itself and by `desktop_control` (see project memory: bridge stdin/stdout patterns).
- **Permission wall:** v1 `permissions` must be `[]`. The host revokes ambient authority: spawned with a scrubbed `env` (empty except `PATH`), CWD = the module dir, and a request/response API that contains *only* the seam method. Defense-in-depth (Bun cannot fully sandbox in-process code): the host also statically rejects `module.ts` containing imports outside an allow-list (`node:` modules banned except pure ones: `node:assert`; no `bun:` APIs; no `fetch`/`process`/`require` tokens) — a lexical wall, same fail-loud philosophy as the L3 policy wall (CodeGenome policy wall, Faza 2 Slice 0).
- **Resource walls:** hard `timeoutMs` per request (host kills and reports), `maxRssMb` polled by the supervisor, and the host process itself is killed after N consecutive timeouts.
- **Determinism aid:** host injects a seeded RNG shim; wall-clock is allowed (read-only).
- Build step = `bun build --no-install` + `tsc --noEmit` inside the module dir, executed in the sandbox stage; artifacts stay in the module dir.

The seam adapter in the runtime holds the child handle; **any** host failure (crash, timeout burst, malformed reply) triggers instant fallback to builtin for that request *and* the quarantine path (§8). The user never sees a module error — they see builtin behavior plus a governance event.

## 5. Evaluation (shadow, paired, offline)

- **Harness:** reuse the existing eval machinery — `makeGetSpecs`/`makeRunEval` (`FeralAgent/src/rsi/get-specs.ts`, `run-eval.ts`) run the Tier 0 + Tier 1/2 suite twice on the *current champion genome*: once with the incumbent seam binding, once with the candidate module bound. Same tasks, same genome, same model → **paired samples** per task.
- **Gate math:** feed the pairs to the locked `evaluateGate` (`FeralAgent/src/rsi/confidence.ts`) with thresholds further tightened by governance policy (L5 §7). This is a *real* paired test — stronger than L6's windowed margin, and required here because a module swap is a bigger lever than a metaparameter.
- **Floors:** Tier 0 floor breach = instant fail (INVARIANT I8, same leaf semantics as `contract-leaves.ts`). Latency regression floor: candidate mean latency ≤ 1.5× incumbent (modules cross a process boundary; the tax must be visible and bounded).
- **Runs inside the Dream Cycle budget:** evaluation is a dream-episode activity, bounded by `episode-options.ts` caps; it must never run while the user is active (existing idle gating).
- **Output:** an `EvalReport` persisted into the envelope: per-task pairs, gate decision, latencies, seed, model id, genome id. Replayable.
- **Measured capabilities:** the eval suite's tasks already carry domains (Tier 0/1/2 specs via `get-specs.ts`); the EvalReport aggregates per-domain scores into `capabilitiesMeasured: { <domain>: number }` in the envelope. This — never the manifest's `capabilitiesClaimed` — is the only capability signal downstream consumers (Brain Stack routing, §12.4) may read. Self-declared scores are an unauthenticated decision input, the same poisoning class as audit finding O1.

## 6. Promotion

Promotion is the **only** path to `registry.active`:

1. `evaluated` with gate `accept`;
2. Evolution Contract FSM pass — run the candidate through `runContract` (`contract-runner.ts`) with `layer: "L4"` so one journal row per candidate lands in the Evolution Journal exactly like L1/L3 candidates (the journal's `ExperimentLayer` union already includes `"L4"` — verified in `journal.ts`);
3. L5 governance check: `approvals.l4ModulePromote` — **always true in v1**, so:
4. **Human approval, always.** Reuse the pending-approval UX verbatim: a card in the Dreams panel (the `PendingPatches`/`MetaEvolutionCard` pattern), CLI `feral modules approve <id>`, IPC `module_resolve`. The card shows: seam, diff-vs-builtin description, EvalReport summary (gate p/d/confidence, latency delta), source size.
5. On approval: envelope updated (`approvedBy`, `promotedAt`), registry re-pointed via temp+rename, history row appended, module host started. **No process restart required** — the seam adapter re-resolves on next request.

Promotion never removes the builtin. `candidates` older than 30 days without approval are moved to `withdrawn` (housekeeping, event emitted).

## 7. Governance Hooks (L5 integration)

Every lifecycle transition calls L5's single entry point (see `docs/2026-07-04-l5-governance-evolution-spec.md` §8):

```
governanceCheck("l4.scaffold" | "l4.build" | "l4.evaluate" | "l4.promote" | "l4.demote", ctx)
```
- `frozen.l4` → every check refuses (G-INV-7); in-flight eval is abandoned (state stays `built`).
- Budgets: eval runs inside policy `budgets.*`.
- Audit: every transition mirrored into the chained governance audit (G-INV-5); promotion rows include the envelope hash.
- Until L5 ships, the L4 implementation calls a local stub with the v1 constants (promote requires human, nothing frozen) — the call sites are the contract; do not inline the decisions.

## 8. Rollback

Three paths, all ending at "builtin restored", all appending history + envelope events:

1. **Manual demote:** `feral modules demote <seam>` / desktop button → registry `active: "builtin"`, host stopped. One step, instant, no approval needed (rollback is always free — same asymmetry as L5/L6).
2. **Watchdog auto-quarantine:** the seam adapter counts module-host failures (crash, timeout, malformed reply) in a rolling window; ≥3 failures → automatic demote + state `quarantined` + governance event + desktop toast. Mirrors the Faza 3 crash→auto-revert watchdog discipline, but cheaper (no rebuild — just re-point).
3. **Governance freeze:** `frozen.l4` demotes all active modules to builtin for the freeze duration (conservative: frozen means *architecture as shipped*).

Because builtins never leave the runtime, rollback can never fail for want of an artifact. Re-promotion after quarantine requires a fresh evaluation pass (evidence expired by definition).

## 9. Provenance Requirements

- Lineage: envelope `parents` chain module → incumbent → … → `builtin:<seam>`; queryable through the existing `ProvenanceGraph` (`provenance.ts`) once envelope storage lands — module envelopes are the first real citizens of the reserved `envelopes/` dir.
- Replay: `sourceHash` + EvalReport (tasks, seed, model id, genome id, per-pair scores) + registry history reconstruct every promotion decision offline.
- The journal row (contract FSM, `layer: "L4"`) links `cycleId` ↔ candidate id ↔ envelope, so "what did L4 learn this week" is a journal filter, as BRSI §2.9 intends.

## 10. API / CLI / UI (thin, mirrors `/meta/*`)

- **API** (`api.rs`, same sidecar round-trip): `GET /modules` (registry + candidates + states), `GET /modules/:id` (manifest + envelope + eval report), `POST /modules/:id/approve|reject|demote`, `POST /modules/evaluate` (run/refresh eval of the pending candidate).
- **IPC:** inbound `modules_list | module_resolve | module_evaluate` → reply `modules_result` correlated by `id`; register in `types.ts` + `INBOUND_TYPES` (`transports/tauri.ts`).
- **CLI:** `feral modules [list] | show <id> | approve <id> | reject <id> | demote <seam> | evaluate` — `admin.rs` pattern, `--json` honored.
- **Desktop:** one "Architecture" card in the Dreams panel (approval inbox + active-module chips per seam), `events.onModulesResult` filtered listener — copy the `MetaEvolutionCard` wiring.

## 11. Acceptance Criteria

1. A hand-written sample module per seam (checked into `FeralAgent/tests/fixtures/modules/`) walks the full lifecycle in tests: propose → sandbox → build → eval (against a stubbed eval runner) → gate → approve → promoted → demote.
2. Rule 2 holds by construction: a test asserts the L4 pipeline performs zero writes outside `~/.feral/rsi/modules/` + envelopes + journal (fs spy / path assertion).
3. Capability wall: a module importing `node:fs`, using `fetch`, or referencing `process.env` is rejected at the sandbox stage with a named reason; a module that sleeps past `timeoutMs` is killed and reported.
4. Fallback: killing the module host mid-request returns the builtin result for that request (no user-facing error) and increments the watchdog; 3 strikes → auto-quarantine + registry restored — one integration test.
5. Paired eval: gate receives per-task pairs; a candidate identical to builtin is rejected (negligible effect), a seeded strictly-better stub is accepted; Tier-0 breach fails instantly.
6. Promotion without an approval record is impossible via any surface (API/CLI/IPC) — negative tests on all three.
7. Registry + history survive crash mid-write (temp+rename, same test shape as L6's F2 fix); corrupt registry → fail closed to builtins + governance event.
8. Provenance: from a promoted module id alone, a test reconstructs seam, parent chain, eval evidence and approver.
9. All existing suites green; sidecar rebuilt and copied (`bun run build` → `src-tauri/binaries/`); live smoke through the headless gateway documented (promote sample module → `feral modules` shows it active → demote).
10. With no modules promoted, runtime behavior is byte-identical to today (builtin fast-path does not cross a process boundary) — perf assertion on the retrieval path.
11. Forward-compat fields are inert but enforced: unknown `schemaVersion` → reject; `seamApiVersion` mismatch → reject at load / auto-demote at boot (registry bump test); non-empty `requires` or `permissions` → reject; `capabilitiesClaimed` present but provably unread (grep-level negative test: no consumer imports it).
12. `capabilitiesMeasured` lands in the envelope from the EvalReport domains and survives replay.

## 12. Future-proofing (frozen shapes now, behavior later)

This chapter exists because the manifest/registry shapes freeze the moment the first module ships. Everything here is **deferred behavior over already-frozen data** — no v1 implementation work beyond the validation rules in §2.1, but the designs are fixed so v2 is additive, not a migration.

### 12.1 Capability discovery — the seam catalog (v2)

The question "how do we add seam #7 without touching L4's plumbing every time" has a safety-shaped answer, and it is **not** `registerCapability()` from module land: a module that can mint new extension points can mint itself an escape hatch — seam creation is a governance act, not a module act.

Instead, seams become **data**: a `SeamCatalog` (runtime-shipped JSON) with one row per seam — `{ seam, seamApiVersion, requestSchema, responseSchema, builtinId, resolutionPoints }`. The generic parts of L4 (registry, manifest validation, module host protocol, watchdog, approval UX, CLI/API) are written against the catalog, not against named seams — implement them that way in v1 even with only two rows. Adding a seam then costs exactly: one catalog row + one adapter call site in runtime code (unavoidable — something must invoke the seam) — an L3-sized change of ~dozens of lines, not an L4 redesign. The v1 acceptance test for this is structural: adding a third catalog row in a test fixture requires zero changes to registry/validation/host code.

Candidate seam roadmap (each maps to a real component that already exists — a seam is *graduated*, never invented ahead of need):

| Candidate seam | Today's implementation |
|---|---|
| `tool_selector` | tiers.ts + list_tools/load_tool drawer |
| `context_builder` | context assembly in `core/agent-loop.ts` |
| `memory_compressor` | proactive compaction (local-model context fix) |
| `memory_pruner` | FMS tier maintenance (`memory/fractal/`) |
| `dream_evaluator` | `run-eval.ts` scorer path |
| `embedding_strategy` | `memory/fractal/embed.ts` |
| `prompt_composer` | system-prompt pool (`systemPromptId` genome field) |
| `response_postprocessor` | ThinkRenderer/output shaping |

Graduation criteria (all three required): the component has a stable request/response boundary that is JSON-serializable; a builtin that can serve as permanent fallback; and at least one concrete hypothesis for why an evolved alternative could beat it. `retrieval_strategy` and `planner` pass today; the rest wait.

### 12.2 Versioning & compatibility (enforced in v1, exercised in v2)

- `schemaVersion` — manifest format. Loader is a versioned parser; unknown → reject.
- `seamApiVersion` — the interface contract. Seam interfaces are **append-only within a major** (new optional request fields OK; changed/removed fields = major bump). On a major bump the registry auto-demotes stale modules to builtin at boot (state `incompatible`, governance event, re-evaluation path open) — the failure mode is "your module retired", never "the runtime crashed".
- `compat.runtime` — CalVer floor (`>=YYYY.M.D`, matching `scripts/set-release-version.mjs` semantics). Checked at load; below-floor runtime refuses the module.
- The module host protocol itself carries a version byte in its hello line so host and runtime can refuse mismatched pairs explicitly.

### 12.3 Dependencies (reserved)

`requires: []` stays mandatory-empty through v1. When it opens (v2+), the fixed rules are: DAG only (cycle = reject at propose), depth ≤ 2, dependencies must already be `promoted`, and a dependency demotion cascades a demotion (never a dangling edge). Declaring the field now costs nothing; retrofitting it into shipped manifests would cost a migration.

### 12.4 Capability scoring → Brain Stack routing (v2, fixed contract)

Two-channel rule, frozen now:
- `capabilitiesClaimed` (manifest) — proposer hints for humans reading the approval card. **Never machine-consumed.**
- `capabilitiesMeasured` (envelope, written only by the eval harness, §5) — per-domain scores in [0,1] over the same domain vocabulary the Brain Stack capability registry uses (see `docs/2026-07-03-brain-stack-minimax-brief.md`: capabilities, not names).

With that alignment, routing composes for free: when a seam has multiple promoted modules (v2 — v1 caps at one active per seam), the Brain Stack's CapabilityRouter can select per-request among them exactly as it selects models — same registry pattern, same health/cost awareness, and quarantine events feed back as health signals. No new routing machinery is invented for modules.

### 12.5 L6 ↔ L4 — evolution selects architecture (v2, fixed contract)

L6 already optimizes *how* the system searches; the natural extension is letting evolution weight *which architecture* serves. The link is deliberately indirect, preserving each layer's mandate:

- **Selection pressure via L1, not L6 (already true in v1):** a promoted `retrieval_strategy` module enters the `RETRIEVAL_STRATEGIES` pool, and L1 genomes select it under the existing evolutionary pressure. L4 creates options; L1 discovers fitness. Nothing to build.
- **Usage weights via L6 (v2):** when multi-active seams arrive (12.4), the MetaGenome gains one bounded field per seam — `module_usage_bias ∈ [0.1, 0.9]`, the probability mass tilted toward the newest promoted module vs the incumbent mix. It rides the existing L6 machinery unchanged: bounded, ratio-neutral default (0.5), mutated one-field-at-a-time, settled by journal-window fitness, rollback-able. A module that raises accept-rate gets more traffic through ordinary L6 acceptance; one that causes rollbacks loses traffic the same way.
- **Hard removal stays out of L6's reach:** demotion/quarantine remain watchdog + human + L5 territory. L6 tunes *exposure*, never *existence* — the same "bounded knobs only" contract that keeps L6 safe today.
- **Evidence already flows:** quarantine and demotion events land in the journal/governance audit, so L6's fitness (fewer halts, fewer rollbacks) already penalizes a genome-era that leaned on a bad module — no new plumbing, just the existing aggregate.
