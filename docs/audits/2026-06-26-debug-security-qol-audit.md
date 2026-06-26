# Feral — Debugging · Security · QoL Audit (task breakdown + delegation)

**Date:** 2026-06-26
**Branch:** feat/reactive-pixel-tree (large uncommitted tree: Dream Cycle, tree viz, workspace-roots, mascot 32px)
**Builds on:** `2026-06-25-production-readiness-audit.md` (security/scale). This pass adds the
**debugging** + **QoL** axes and re-verifies the open `[VERIFY]` items from the 25th.
**Delegation key:** per `feedback_delegation_split_and_sync` — Opus keeps internal-state / integration /
security-judgment / verification; MiniMax M3 takes **pure leaves with fixed contracts**. Always `ls`/Read
MiniMax output before trusting it landed on disk.

---

## Re-verification of prior open items (resolved this pass)

- **A2 (MCP `cmd /c` metachar filter) → DOWNGRADE to low.** Field substitution (`mcp.rs:1035-1045`,
  `{key}` → user value) runs *before* `connect()`, so the `bad()` denylist (`mcp.rs:889`) inspects the
  **substituted** command+args. `env` is passed via `cmd.env(k,v)` (process environment block), which
  cmd.exe does not re-parse as a command line → not an injection vector. Remaining gap is only a
  missing regression test pinning the denylist set. (→ S2)
- **A4 (desktop control gating) → mostly OK.** `desktop_control.rs`: hard denylist fail-closed
  (`:209-219`), optional allowlist keyed on lowercased basename (`:435-447`), enable-flag gate. One
  real hole found below (S5).

---

## A. DEBUGGING / CORRECTNESS

- **D1 [H] — Tree is not known-green.** Huge uncommitted surface since the last "tsc + 1074 tests green"
  snapshot (Dream Cycle wiring in `index.ts`/`sidecar.ts`, new `lib/tree/`, `prng.ts`, `workspace-roots`,
  mascot assets). Must run `tsc --noEmit` + sidecar tests + frontend tests + `cargo check` on the *current*
  tree before any of this is trusted. **Owner: Opus** (integration/verification — not delegable).
- **D2 [H] — Dream Cycle has no live smoke test.** `dream_cycle` memory: fully integrated, tests green,
  but never exercised end-to-end against a running sidecar (idle trigger → episode → telemetry → mascot
  `dreaming` toast). **Owner: Opus** (cross-process, stateful).
- **D3 [M] — New pixel-tree viz (`frontend-react/src/lib/tree/`) unproven under load.** `layout.ts` /
  `render.ts` / `signal.ts` / `sprites.ts` are pure-ish with a `__tests__/` dir. Need: redraw-perf check
  (canvas repaint on every signal? throttle/RAF?), and edge-case tests (empty tree, 1 node, very deep).
  Pure functions with fixed in/out → **Owner: MiniMax** (extend unit tests + add RAF throttle if missing,
  contract: signatures frozen). **Opus** integrates + eyeballs the live render.
- **D4 [M] — Dream Cycle config edge-cases under-tested.** `dream-config.ts` `finite`/`positive`/`truthy`
  parsing is subtle (the 0-threshold salvage path). `dream-config.test.ts` exists; confirm it covers
  `FERAL_RSI_ERROR_THRESHOLD=0/-1`, `ALLOW_CLOUD` typos, and the loopback gate matrix. **Owner: MiniMax**
  (pure leaf, table-driven test).

## B. SECURITY

- **S5 [H] — `control_app` confirmation fails OPEN with no `askUser` bridge.** `control-app.ts:376-379`:
  if `ctx.askUser` is absent, `confirmWrite` returns `true` and the state-changing action proceeds. The
  comment leans on the host denylist, but the *per-action user confirmation* is silently skipped. A
  transport without an askUser bridge → unconfirmed clicks/types/launches. **Fix:** fail closed (deny) when
  no askUser bridge AND the action is in `ALWAYS_CONFIRM`, or require an explicit env opt-out. **Owner: Opus**
  (security boundary judgment).
- **S1 [H] — MCP supply-chain: `npx -y @pkg` unpinned (carried from A1).** Still runs arbitrary npm at
  runtime outside the sidecar sandbox. Needs version+integrity pin or curated vendoring + a real trust
  prompt. **Owner: Opus** (policy/UX decision). Free path first — pinning is $0; no paid scanner needed.
- **S2 [M] — Pin the `cmd /c` metachar denylist with a Rust test.** Now-verified-safe filter has no
  regression guard; a future refactor that reorders substitution/spawn would silently reopen
  CVE-2024-24576-class injection. **Owner: MiniMax** (add `#[test]` asserting `bad()` rejects
  `& | < > ^ % \n \r \0` in substituted args; contract: assert-only, no prod change).
- **S3 [H][BLOCKED] — Updater pubkey rotation (A3).** `security_hardening_2026_06_17` + A3: the old
  updater key was compromised/in git history; `tauri.conf.json` pubkey "unchanged, awaiting new pubkey
  from Darius." Signed-update hijack risk until rotated. **Owner: Opus, but BLOCKED on Darius** providing
  the new minisign pubkey (and confirming old key isn't still accepted). Cost: $0.
- **S4 [M] — Secrets-at-rest (A5) + SSRF egress (A6) read-pass.** Confirm API keys never plaintext
  (`disk_encryption.rs`, `field-crypto.ts`, keychain), keys never logged, and the egress proxy enforces
  `allowedDomains` on redirects + resolved IPs (no DNS rebinding) for read-webpage/deep-research/web-search.
  **Split:** MiniMax greps + assembles the evidence table (where each secret is written/read, every fetch
  call site); **Opus** judges sufficiency. (verify-premises rule: don't trust green tests alone.)
- **S6 [M] — `workspace-roots` is a new trust boundary.** `FERAL_WORKSPACE` is now a path-LIST + scratch +
  self-protect wall (`workspace_roots_shell_2026_06_25`). New `workspace-roots.test.ts` exists. Confirm:
  no empty-segment → root escape, the self-protect wall can't be disabled by a crafted list, and
  containment still uses the realpath/symlink defense. **Owner: Opus** (path containment = security).

## C. QoL / DEVEX

- **Q1 [low] — Dev-script sprawl.** 6 `run-*.bat` deleted, `run-dream-test.bat` added; bench/run scripts
  are ad-hoc. Consolidate into one `scripts/` entrypoint or document them. **Owner: MiniMax** (mechanical,
  contract: preserve each script's exact command).
- **Q2 [H] — Non-tech onboarding: Node/npx silent failure (C3).** Primary audience is non-technical
  (`target_audience`); a missing Node makes MCP/connectors fail silently. Need detection + guided install
  or bundled runtime. **Owner: Opus** (UX-critical, touches Rust host + onboarding UI).
- **Q3 [M] — Cold-start degradation (C5).** Verify empty memory / no model loaded / no embedding GGUF on
  disk (downloads first run) each render a clear UI state, not an error or infinite spinner (the bench panel
  had one — C2). **Owner: MiniMax** (enumerate states + add guards; contract: each cold state → defined UI).
- **Q4 [H] — RSI telemetry missing (B3).** `rsi-telemetry.jsonl` — can't operate/diagnose Dream Cycle
  without it; gates any "it improves" claim. **Owner: Opus** (defines the schema/integration; the Dream
  Cycle already emits telemetry hooks per `dream_cycle` memory — wire + surface them).
- **Q5 [M] — Commit hygiene.** Branch carries a very large uncommitted WIP set (~Dream Cycle + tree + mascot
  + audits + `.drafts/`). Decide what lands, split into reviewable commits, drop `.drafts/` from tracking.
  **Owner: Opus** (judgment on what's shippable).

---

## Delegation summary

| Owner | Tasks | Why |
|-------|-------|-----|
| **Opus** | D1, D2, S5, S1, S3*, S6, Q2, Q4, Q5 + judge S4 | integration, stateful, security boundaries, UX, verification |
| **MiniMax M3** | D3, D4, S2, Q1, Q3 + grep-half of S4 | pure leaves with frozen contracts (tests, parsers, mechanical) |
| **Blocked/Darius** | S3 (new updater pubkey) | needs key material only Darius has |

*S3 is Opus-owned but blocked on Darius for the pubkey.

## Top 5 to do first
1. **D1** — get the current tree green (tsc + all tests + cargo check). Nothing else is trustworthy until this.
2. **S5** — close the `control_app` confirmation fail-open.
3. **D2** — Dream Cycle live smoke test.
4. **Q4 / B3** — wire RSI telemetry (unblocks every "it improves" claim).
5. **S3** — chase Darius for the rotated updater pubkey (security-critical, $0, just blocked).
