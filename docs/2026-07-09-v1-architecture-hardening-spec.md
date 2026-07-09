# FERAL v1.0 Architecture Hardening — Specification

**Date:** 2026-07-09 · **Author:** Fable (architecture review) · **Implementer:** another model (Sonnet 5 / MiniMax) — this document is the contract.
**Status:** SPEC ONLY. Every artifact path named below was verified to exist on branch `feat/l5-governance` at spec time. If a path does not exist when you implement, STOP and report — do not invent a substitute.

## 0. Context

Output of the pre-1.0 Principal-Architect review (2026-07-09). Verdict: the safety/evolution
architecture (L3–L6) is sound; the debt lives in **legibility, protocol plumbing, and
configuration sprawl**. This spec turns every finding into a scoped task.

Two tracks:

- **Track B (Blockers)** — must land before the v1.0 public release.
- **Track R (Refactors)** — high-value, post-blocker; ordered by impact/cost.

General rules for the implementer:

1. **No behavior changes unless the task says so.** Most tasks are documentation,
   mechanical moves, or additive schemas. If a test goes red, you broke something.
2. **Verify premises**: grep the real code before writing. Specs have named dead
   artifacts before (see `docs/superpowers/` history). Fail loud, don't improvise.
3. Baseline: `cd FeralAgent && bun test` (≈2082+ pass), `cargo test` in `src-tauri/`
   and `crates/`, `go test ./...` in `tui/`. All three suites must be green before AND
   after every task. Run them per task, not once at the end.
4. One commit per task, message prefix `chore(arch):` / `docs(arch):` / `refactor(arch):`.

---

# Track B — v1.0 Release Blockers

## B1. API stability declaration

**Problem.** The public HTTP surface (`crates/feral-core/src/api.rs` — `/runtime/*`,
`/governance/*`, `/modules/*`, `/meta/*`, plus Ollama-compat `/api/*` and `/v1/*`)
ships with no version namespace and no stability contract. Deciding stability *after*
release is itself a breaking change.

**Decision required from Darius (do not decide yourself):** option (a) freeze the
current paths as implicitly-v1 and commit to additive-only changes, or (b) declare the
whole `/runtime|governance|modules|meta` surface **unstable pre-2.0** in docs and
response headers. Recommendation from review: **(b)** — cheapest, honest, reversible.

**Deliverable (assuming (b)):**
- `docs/API.md`: every route from `router()` in `api.rs`, grouped read/evolve/govern
  (the comment tags already in the file), each with method, params, response shape,
  stability tag (`stable` only for `/api/*` + `/v1/*` Ollama/OpenAI-compat routes,
  `unstable` for everything else).
- Add response header `X-Feral-Api-Stability: unstable` on the unstable group (one
  axum middleware layer, not per-route edits).
- CHANGELOG note.

**Acceptance:** `curl` any `/runtime/*` route → header present; `docs/API.md` lists
every route in `router()` (write a small test or script that diffs the route list
against the doc so it can't drift — see `api.rs:55-167`).

**Size:** S (1 day). **Risk:** low.

## B2. Security-critical configuration documentation

**Problem.** ~98 `FERAL_*` env vars exist across `FeralAgent/src`, `src-tauri/src`,
`crates/`. Several are security-critical footguns with no user-facing doc:
`FERAL_ENABLE_SHELL_EXEC`, `FERAL_ENABLE_CODE_EXEC`, `FERAL_ENABLE_DESKTOP_CONTROL`,
`FERAL_DESKTOP_CONTROL_*`, `FERAL_DB_KEY`, `FERAL_AGENT_WORKSPACE`, `FERAL_WORKSPACE`,
`FERAL_FETCH_DOMAINS`.

**Deliverable.**
- `docs/CONFIGURATION.md`: **all** `FERAL_*` vars. Harvest with
  `grep -rhoE "FERAL_[A-Z_]+" FeralAgent/src src-tauri/src crates --include=*.ts --include=*.rs | sort -u`,
  then locate each one's reader to document: purpose, type, default, and — for the
  security group — an explicit **threat note** (what turning it on exposes, e.g.
  shell_exec = full shell whitelist cmd/pwsh/sh, see
  `FeralAgent/src/sandbox/tool-permissions.ts` and `process-sandbox.ts`).
- Security group gets its own top section with a red-flag table.
- Note the `FERAL_WORKSPACE` (TS path-list) vs `FERAL_AGENT_WORKSPACE` (Rust) trap
  explicitly — it has bitten before.
- Do NOT build the typed config module here — that is R5. This task is documentation only.

**Acceptance:** every var from the grep appears in the doc (add
`scripts/check-env-docs.mjs` that runs the grep and fails if a var is missing from
`docs/CONFIGURATION.md`; wire into `bun test` or CI).

**Size:** M (2 days, mostly archaeology). **Risk:** none (docs only).

## B3. Repository hygiene

**Problem.** Build artifacts and generated output are committed: `tui/feral-tui.exe`,
`tui/target/`, `graphify-out/`, `target-check/`, possibly `data/`. A public repo's
first impression.

**Deliverable.**
- `git rm --cached` the artifacts; extend `.gitignore` (`*.exe` under `tui/`,
  `graphify-out/`, `target-check/`, `tui/target/`).
- Audit `data/` and `skills/` top-level dirs: decide keep (document what they are in
  CONTRIBUTOR_GUIDE §structure) or remove. If unsure, list contents in the PR
  description and keep — flag for Darius.
- Do NOT rewrite git history (the .exe stays in history; that's accepted — note it).

**Acceptance:** fresh clone contains no build artifacts; `git status` clean after a
full build (sidecar compile + cargo build + go build) — i.e. all build outputs ignored.

**Size:** S (half day). **Risk:** low. **Care:** don't ignore
`src-tauri/binaries/` sidecar exes if the build flow requires them committed — check
`src-tauri/scripts/build-sidecar.mjs` first (it is currently modified in the working
tree; read it, don't assume).

## B4. ARCHITECTURE.md + glossary

**Problem.** The L0–L6 layer model exists only in scattered specs
(`docs/2026-07-04-l4-*`, `-l5-*`, `-l6-*`, `docs/brsi-spec.md`). Three competing
vocabularies (L-numbers in specs, "Faza N" in commits/history — and Faza numbers do
NOT map 1:1 to L-numbers — "BRSI" in older docs). Poetic file names (`dream-cycle`,
`taste-miner`, `champion-tree`, `escape-time`, `recalcitrance`, `genome`) have no
glossary. A senior contributor cannot self-orient.

**Deliverable.** `ARCHITECTURE.md` at repo root:
1. One diagram/table: the 4 runtimes (frontend-react, src-tauri+feral-core,
   FeralAgent sidecar, Go TUI) and the 3 protocols between them (Tauri IPC / stdin
   JSON-lines / HTTP API). Base it on `docs/CONTRIBUTOR_GUIDE.md` §1-2 which already
   covers part of this — extend, don't duplicate; CONTRIBUTOR_GUIDE should link here.
2. **Layer → code map**: for each of L0–L6, one paragraph (responsibility, what it may
   and may not do) + the exact file list under `FeralAgent/src/` (and Rust halves:
   `src-tauri/src/rsi/`, `crates/feral-core/src/rsi/`). Source of truth for the
   responsibility text: the §0 "Mandate" sections of the L4/L5 specs and
   `docs/invariants.md`.
3. **Translation table**: Faza ↔ L-layer ↔ spec doc ↔ code path. (Faza 2=L3 code-RSI,
   Faza 3=watchdog/revert, Faza 4=L2 adaptation, Faza 4.5=runtime extraction,
   Faza 6=L6 meta. Verify each against the docs before writing — do not trust this
   parenthesis blindly.)
4. **Glossary**: every evocative term (dream, genome, mutation, fitness, champion,
   taste, escape-time, recalcitrance, birth/extinction, ratchet, seam, envelope,
   FMS/fractal, BRSI, RSI) → one-sentence plain-English definition + owning file.
5. **"Where do I add X"** section: new provider (today: 3 places — name them), new
   tool, new connector, new seam module, new memory strategy.

**Acceptance:** a reviewer can pick 5 random `rsi/` files and find each one's layer
and purpose from the doc alone.

**Size:** M (1–2 days, zero code). **Risk:** none.

## B5. Automate the safety smoke tests

**Problem.** The marketed safety paths are verified by hand-run markdown checklists
(`docs/2026-07-09-l4-b7-smoke.md`, `docs/2026-07-09-l5-a7-smoke.md`, Faza-3 revert
smoke). These decay silently.

**Deliverable.** One `bun test` e2e file per safety path, tagged/skippable so CI time
stays sane (`FERAL_E2E=1` gate, mirror how existing integration tests gate):
1. **Module quarantine** (L4): promote a deliberately-crashing module in a temp
   `~/.feral`-style dir (use `instance-paths.ts` override), drive the seam adapter to
   `maxStrikes`, assert registry re-pointed to builtin + `module_quarantined`
   governance-audit row. Most of the pieces already exist in
   `FeralAgent/src/rsi/seam-adapter.ts` unit tests — this is the assembled version.
2. **Governance freeze/fail-closed** (L5): corrupt `policy.json` in a temp dir, boot
   the governance loader, assert strictest defaults + `frozen` + evolve entry points
   refuse (`ok:false`).
3. **Journal tamper detection**: flip one byte in a chained journal file, assert
   `verifyJournal` flags the row and consumers skip the file.
4. **L3 crash→revert** (Rust watchdog): OUT OF SCOPE for this task if it requires a
   real rebuild cycle — instead, add a Rust unit test asserting the marker→revert
   decision logic in `src-tauri/src/rsi/watchdog.rs` if one doesn't exist; note the
   full-cycle test as deferred.

**Acceptance:** `FERAL_E2E=1 bun test <files>` green on Windows; each test fails when
its guard is deliberately broken (verify once by hand, note in PR).

**Size:** M–L (3–4 days). **Risk:** medium — temp-dir/Windows flakiness (EBUSY) is a
known issue; follow the existing test patterns for temp `FERAL_HOME` isolation.

---

# Track R — Post-blocker refactors (priority order)

## R1. Version + schema the stdin protocol (Rust ↔ sidecar)

**Problem.** The desktop↔sidecar protocol is 54 unversioned message types, hand-mirrored
across languages; the de-facto spec is the `switch` in `FeralAgent/src/index.ts:1244+`
and string literals in `src-tauri/src/lib.rs` / `feral-core`. The L4 module-host
protocol got a version handshake (`module-host.ts` hello `protocol:1`); the *main*
protocol didn't.

**Deliverable.**
1. `FeralAgent/src/protocol.ts`: one const listing every inbound message `type` and
   every outbound event `type` (harvest from the switch + `types.ts`
   `InboundMessage`/`OutboundEvent`), plus `export const SIDECAR_PROTOCOL = 1`.
2. Sidecar emits a hello line on boot: `{type:"hello", protocol:1}` (before any other
   output; stdout is protocol-reserved per `index.ts:2310`).
3. Rust side (`crates/feral-core/src/feral_agent.rs` — verify this is where stdin
   writes live): read hello; on mismatch log loud warning + continue (v1: warn-only,
   do NOT hard-fail — desktop and sidecar ship in lockstep today).
4. `crates/feral-core/src/sidecar_protocol.rs`: const slice of the same message-type
   names. Cross-language drift check: a Rust test that reads `protocol.ts` from the
   repo (path relative to CARGO_MANIFEST_DIR) and diffs the name sets. Build-time
   coupling to repo layout is acceptable — it's a dev-time test.
5. Refactor the `index.ts` switch into a handler map keyed by the protocol const
   **only if** it stays a mechanical move (each case body → named function). If the
   bodies share too much closure state to extract cleanly, skip the map and keep the
   switch — the schema consts are the point, not the dispatch style.

**Acceptance:** all suites green; killing one name from either side's const fails the
drift test; hello line visible in gateway logs.

**Size:** M (2 days). **Risk:** medium — touching `index.ts` boot order; the hello
must not precede transport setup expectations in `transports/tauri.ts`. Remember the
sidecar-rebuild rule: TS changes need `bun run build` + copy to `src-tauri/binaries/`.

## R2. Subdivide `FeralAgent/src/rsi/` by layer

**Problem.** ~85 files, six layers plus shared infra, one flat directory. No structural
layer boundaries; `sidecar.ts` imports across everything.

**Deliverable.** Mechanical move into:
```
rsi/infra/      — journal, event-bus, hash-chain, instance-paths, provenance,
                  envelope-store, budget, rsi-cost, resource-monitor, adapters, bridge
rsi/l1-config/  — genome, mutation, fitness, selection-*, population-*, crossover-*,
                  champion*, taste*, strategy-seeds, birth-policy, extinction-handler,
                  escape-time*, recalcitrance, dream-*, pbt-*, fractal.ts, goal-mode
rsi/l2-adapt/   — lora-*, trainers/, dataset-builder, personal-fitness
rsi/l3-code/    — code-*, pending-patches, contract-* (verify: contract FSM is the
                  ratchet path — if contract-* is consumed by L1 promotion too, put it
                  in infra and note why)
rsi/l4-modules/ — module-*, seam-*
rsi/l5-gov/     — governance*, 
rsi/l6-meta/    — meta-evolution
rsi/            — sidecar.ts, engine.ts, mod.ts stay at root (cross-layer orchestrators)
```
Rules: git mv (preserve history), update imports, **zero logic edits**. Where a file's
layer is ambiguous, check the L4/L5 spec citations and `docs/invariants.md` owner
column; if still ambiguous → `infra/` + a one-line comment. Add `rsi/README.md` with
the map (link from ARCHITECTURE.md).

**Acceptance:** all suites green; `git log --follow` works on moved files; no file
left in `rsi/` root except the named orchestrators.

**Size:** M (1–2 days, mechanical but wide). **Risk:** medium-low — pure import churn;
watch the text-import of `module-host.ts` in `module-host-client.ts` (embedded as
asset — path is load-bearing) and any dynamic imports/`instance-paths` relative
assumptions. Grep for `import(` and `.ts"` string literals before moving.

## R3. Central typed config module

**Problem.** 98 env knobs read ad hoc at ~98 call sites; no defaults registry, no
validation, no single doc source (B2's doc will drift without this).

**Deliverable.**
1. `FeralAgent/src/config.ts`: a schema table `{ name, type, default, description,
   security: boolean }` for every TS-side var; typed getters (`cfgBool/cfgInt/
   cfgPath/cfgList`); reading an undeclared `FERAL_*` var elsewhere becomes lint-able
   (add a test that greps `src/` for `process.env.FERAL_` outside config.ts and fails
   on new offenders — grandfather the current list, shrink it opportunistically).
2. Migrate call sites incrementally: START with the security group (shell/code
   exec, desktop control, workspace, db key) + the top-10 most-read vars. Full
   migration is allowed but not required in one pass.
3. Regenerate `docs/CONFIGURATION.md` from the schema
   (`scripts/gen-config-docs.mjs`), replacing B2's hand-written TS section; Rust-side
   vars stay hand-documented (or mirror the same pattern in `feral-core/src/settings.rs`
   later — out of scope).

**Acceptance:** suites green; generated doc committed and in sync (check-script);
security vars all flow through config.ts.

**Size:** M (2–3 days). **Risk:** low — behavior-preserving if defaults are copied
faithfully. **Trap:** several vars have *different* defaults in different call sites
today; when found, report each in the PR instead of silently unifying.

## R4. Single provider record — ✅ DONE 2026-07-09 (Fable, commit 73fe35c)

Implemented findings differed from the original scope (verified against code):
the catalog WAS already the wizard's single source (TUI + Onboarding consume it
with bundled fallbacks — the designed pattern). The real duplication was four
hand-rolled `match provider_id` copies (three missing "nvidia", one with a
drifted MiniMax URL `api.minimax.chat` vs `.io`) and Settings→Cloud Keys
(`ByokTab.tsx`) never consuming the catalog. Fixed: `Provider::from_id()` +
`Provider::family()` canonical mappings, `default_provider_configs()` derived
from the catalog, ByokTab wired to `useCatalog` (PROVIDER_DEFS kept as offline
fallback + `availableModels` carrier), 3 drift tests added. The TS sidecar
needed nothing: unknown provider ids already default to the OpenAI-compatible
family in `inference-router.ts`.

Original scope (kept for reference):

**Problem.** Adding a provider touches 3 places in 2 languages:
`FeralAgent/src/sandbox/inference-providers.ts` (protocol adapter) +
`FeralAgent/src/brain/capability-registry.ts` (capability vector) +
`crates/feral-core/src/byok.rs` `provider_catalog()` (onboarding catalog). Violates
the BYOK/extensible positioning.

**Deliverable (data unification, not code unification):**
1. `FeralAgent/src/providers/catalog.ts` (or JSON): one record per provider —
   id, display name, protocol family (openai-compat / anthropic / ollama / …),
   default base URL, key format hint, capability vector, local flag.
2. `inference-providers.ts` keeps the protocol *adapters* (few, per family) but maps
   provider→adapter via the catalog; brain registry seeds capabilities from the
   catalog.
3. Rust `byok.rs` catalog: EITHER generate from the TS catalog at build time
   (script in `src-tauri/scripts/`, mirroring how the sidecar build works) OR serve
   the catalog from the sidecar and have `feral-core` proxy it. **Decide by reading
   how `runtime_providers_catalog` (api.rs:166) sources data today; pick the path
   with the smaller diff and state the choice in the PR.**
4. Acceptance test: "add provider X" = one catalog record (+ one adapter only if a
   new protocol family) — prove it in the PR by adding a fake provider in a test.

**Size:** L (3–5 days). **Risk:** medium-high — touches onboarding, routing, and
trust config (`trustedBaseUrls` in `inference-router.ts` — the catalog must feed it,
never bypass it; the egress trust check is a security invariant, keep it fail-closed).

## R5. Unify MCP on one client — ✅ DONE 2026-07-09 (Fable, commit f7913c0)

Implemented. Key finding vs. original scope: the sidecar's `mcp-client.ts` was
DEAD code (zero consumers — the agent↔MCP bridge never existed), so R5
delivered the bridge and the unification in one move. New
`sandbox/mcp-manager.ts` owns connections (reconcile from `~/.feral/mcp.json`,
tools registered as `mcp_<name>` in the drawer tier); `index.ts` serves
`mcp_reload/status/list_tools/call_tool` → `mcp_result`; Rust `mcp.rs` is now
catalog + config CRUD + humanize + stdin proxy; rmcp removed; Windows
metachar denylist enforced at install (Rust) AND spawn (TS). Bonus fix:
desktop `TauriEvents` now fans onto `runtime.events_tx` (embedded HTTP API
roundtrips were blind before). Headless gateway gets MCP for free.
⚠️ Remaining for the smoke pass: drive the Extensions page live
(install → toggle → tools list → agent calls an MCP tool).

Original scope (kept for reference):

**Problem.** Two full MCP client stacks: `rmcp` in `src-tauri/src/mcp.rs` (Extensions
page) and hand-rolled JSON-RPC in `FeralAgent/src/sandbox/mcp-client.ts` (agent
tools). Same `~/.feral/mcp.json`, two connection stacks, two sandbox postures.

**Deliverable.** TS client becomes the single connection owner (tools execute
agent-side; its sandbox mapping is the safety-relevant one). Rust `mcp.rs` shrinks to
config CRUD + UI metadata; where the Extensions page needs live data (tool lists,
connection status), it asks the sidecar via new stdin messages (`mcp_list`,
`mcp_status` — add to the R1 protocol consts) instead of connecting itself.

**Acceptance:** Extensions page still lists servers/tools (manual smoke vs desktop
app); only one process ever spawns MCP servers (assert: `rmcp` connection code
deleted or feature-gated off); suites green.

**Size:** L (2–4 days). **Risk:** medium-high — desktop UX regression surface, and a
security posture decision (which sandbox wraps discovered tools) that must not be
weakened. If the Extensions page depends on rmcp-specific capabilities (resources,
prompts) the sidecar client lacks, STOP and report scope before building.

## R6. Move connectors persistence into `feral-core`

**Problem.** Connector catalog lives in `crates/feral-core/src/connectors.rs`,
live connections in the sidecar, but **persistence** (`~/.feral/connectors.json`,
secret handling, reload poke) is in `src-tauri/src/connectors.rs` — desktop-only.
The headless gateway cannot manage connector config; contradicts CLI parity.

**Deliverable.** Move load/save/secret-handling from `src-tauri/src/connectors.rs`
into `feral-core` (same file layout discipline as the catalog half already there);
`src-tauri` keeps only the Tauri command wrappers. Add `/runtime/connectors` GET/POST
routes (unstable group, B1 header) + `feral connectors set|list` CLI subcommands
(pattern: existing `feral connectors [reload]` in `crates/feral-cli`). Secrets
discipline unchanged: API/IPC never return secret values, only `filled` flags —
preserve exactly the existing redaction behavior.

**Acceptance:** desktop connectors page unchanged (smoke); headless
`feral connectors set discord.token …` round-trips; secrets never appear in any
GET response (test).

**Size:** M (1–2 days). **Risk:** low-medium — secret-handling move demands care;
copy the code, don't rewrite it.

## R7. Split the god files (dispatch only)

**Problem.** `src-tauri/src/lib.rs` 3524 lines / 74 IPC commands;
`FeralAgent/src/index.ts` 2403 (boot + wiring + dispatch). (`agent-loop.ts` 1814 and
`rsi/sidecar.ts` 1163 are EXCLUDED — they are stateful cores, not dispatch; splitting
them is real design work, not this task.)

**Deliverable.** Mechanical extraction by domain: `lib.rs` → `commands/` modules
(conversations, models, rsi, governance, connectors, settings, …) re-exported and
registered exactly as before; `index.ts` → `boot.ts` + `dispatch.ts` (+ R1's
`protocol.ts`) with `index.ts` as thin entry. Zero logic edits.

**Acceptance:** suites green, `cargo tauri dev` boots, sidecar binary rebuilt and
smoke-chatted.

**Size:** M (1 day each). **Risk:** low-medium (wide but mechanical; Tauri command
registration macro must list every command — miss one and the frontend breaks at
runtime, so diff the `generate_handler!` list count before/after).

## R8. Naming cleanups (batched, lowest priority)

- Rename `FeralAgent/src/sandbox/` → `egress/` or `boundary/` (it holds providers,
  router, MCP, perf policy — not process sandboxing). Pure `git mv` + imports. Do it
  in the same PR as R2 or not at all — one import-churn event, not two.
- `rsi/` README notes the acronym expansion once (B4 glossary covers the rest).
- Do NOT rename the poetic module names (dream/genome/taste…) — consistent metaphor,
  glossary is enough, churn isn't worth it.

**Size:** S. **Risk:** low.

---

# Sequencing

```
B3 (hygiene) → B2 (config doc) → B4 (ARCHITECTURE.md) → B1 (API stability) → B5 (smoke e2e)
   → v1.0 gate →
R1 (protocol) → R2+R8 (rsi/ split + renames) → R3 (config module) → R7 (god files)
   → contributor gate →
R4 (providers) → R5 (MCP) → R6 (connectors)
```

B-track has no interdependencies except B2 before B4 (the doc feeds the guide links).
R4–R6 deliberately last: highest risk, and they benefit from R1's protocol consts.

# Out of scope (explicitly rejected)

- Rewriting the Go TUI in another language (stays a thin API client — that's policy).
- Merging L5/L6 code (different write targets; presentation merged in B4 instead).
- A plugin framework beyond the two v1 seams.
- Renaming dream/genome/etc. modules (R8 note).
- Splitting `agent-loop.ts` / `rsi/sidecar.ts` (design work, separate future spec).
- Rust-side config schema mirror (noted in R3, deferred).
- Single governance choke-point gateway (documented as a known seam in B4; build it
  when a second contributor touches an evolve path).
