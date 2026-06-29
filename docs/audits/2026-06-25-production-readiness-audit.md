# Feral — Production-Readiness Audit (Security · Scale · Robustness)

**Date:** 2026-06-25
**Bar:** production-grade + token-friendly + fool-proof (incl. enterprise scale).
**Goal context:** surpass OpenClaw / Hermes / Sakana on the on-device, eval-gated,
privacy-preserving self-improvement axis — which requires the gaps below closed
*and measured*, not just designed.

## Method & honesty

Findings are grounded in the current code with `file:line` where **verified**.
Items I have not yet deep-read are marked **[VERIFY]** with the exact check to
run — they are *open audit items*, not asserted findings. Severity:

- **C (Critical)** — blocks production / active cost or security risk now.
- **H (High)** — must fix before enterprise/scale claims.
- **M (Medium)** — hardening / correctness; fix in normal course.

---

## A. SECURITY

### Strengths (verified — keep / regression-guard)
- **CSP is strict** (`tauri.conf.json:33`): `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, no `unsafe-eval`. assetProtocol scoped to `$HOME/.feral/voice/**`.
- **Sidecar tool sandbox is excellent.** `shell_exec` is **argv-only, no shell**
  (`tools/builtin/shell-exec.ts`): metacharacters are literal, binary must be on an
  absolute-path whitelist, opt-in via `FERAL_ENABLE_SHELL_EXEC`, cwd-bound, output
  capped, timeout clamped. `sandbox/tool-permissions.ts` enforces manifest validation +
  path containment **with symlink-escape defense** (`realpathBestEffort`) + per-path mode.
- **Inbound IPC is allowlisted + exhaustiveness-checked** (`transports/tauri.ts`
  `INBOUND_TYPES` + `_AssertExhaustive`): an unlisted message type can't be processed and
  a new union member that isn't allowlisted fails to compile.

### Findings
- **A1 [H] — MCP servers run `npx -y @pkg` (supply-chain RCE surface).**
  `mcp.rs` catalog spawns `npx -y <package>` (e.g. `:130`, `:145`…). `npx -y` downloads
  and executes arbitrary npm packages at runtime, outside the sidecar tool sandbox. A
  compromised/typosquatted package = code exec on the user's machine. Mitigation today:
  user opt-in per server. Recommend: pin versions + integrity (lockfile/hash), or vendor
  a curated set; surface a clear trust prompt.
- **A2 [M] — Windows MCP spawn uses `cmd /c <command> <args>`** (`mcp.rs:875-895`) because
  npx/node are `.cmd` shims. A `bad()` filter blocks `%` + metachars on command/args
  before spawn. **[VERIFY]** that `bad()` covers the full cmd.exe set (`& | < > ^ ( ) "`
  and trailing `\`) for **user-substituted field values** (`{FOLDER}`, env keys), not just
  the static catalog. If complete → downgrade to informational.
- **A3 [H][VERIFY] — Updater pubkey rotation.** `tauri.conf.json:61` carries a minisign
  pubkey. Memory (2026-06-17) flagged the *old* updater key as compromised/in git history
  and "unchanged, awaiting new pubkey." **Check:** is the current key the rotated one? If
  the pre-compromise key is still live → **Critical** (signed-update hijack). Also confirm
  the old key is not still accepted anywhere.
- **A4 [M][VERIFY] — Desktop control gating.** `desktop_control.rs` drives native apps via
  UIA. Memory says opt-in + denylist + confirmation + secret redaction. **Check:** the
  allow/deny basename match (`app_basename`) can't be bypassed, confirmation is enforced
  server-side (not just UI), and the denylist is fail-closed.
- **A5 [M][VERIFY] — Secrets / BYOK at rest.** `disk_encryption.rs` + OS keychain +
  `FERAL_DB_KEY` + `sandbox/field-crypto.ts`. **Check:** API keys never written plaintext;
  DB key derivation/source is sound; keys aren't logged; redaction covers connector creds.
- **A6 [M][VERIFY] — Egress / SSRF.** Memory notes SSRF redirect/DNS fixes applied. **Check**
  the tool egress proxy enforces `allowedDomains` on redirects + resolved IPs (no rebinding),
  and `read-webpage`/`deep-research`/`web-search` route through it.

---

## B. SCALE / ENTERPRISE

- **B1 [C] — RSI runs as a continuous always-on loop (token burn, anti-pattern).**
  `rsi/passive-supervisor.ts`: autostarts at sidecar boot, `STANDING_GOAL` fixed,
  effectively-unbounded budget (`maxIterations 100_000`, `maxTotalTokens 1e9`), and
  `onRunEnded → scheduleRestart` re-launches forever. With a cloud model this consumes
  user tokens with **no prompt**. Diverges from the recorded **event-driven** design and
  from the literature (survey arXiv 2507.21046: triggers = task/threshold/**error**/schedule,
  *not* a clock). **Fix = the "Dream Cycle" redesign** (see separate RSI spec): event/idle
  trigger + eval-gate + per-episode budget cap, local-only default. Migration = swap the
  *scheduling* only; keep the engine math.
- **B2 [H] — FMS rebuild is full O(N)** at 1.2× corpus growth (`fractal-memory.ts`
  `rebuildIfStale`). At enterprise corpus size, re-embedding + re-summarizing the whole
  tree is cost-prohibitive. Need **incremental indexing** (insert/merge into existing tree).
- **B3 [H] — RSI telemetry missing** (`rsi-telemetry.jsonl`). Can't operate/diagnose a
  self-improvement loop you can't observe. Required before any "it improves" claim.
- **B4 [H] — No measured recall on the current embedder.** FMS migrated to **BGE-M3 1024d**
  (`paths.rs:142`), but the published numbers (41.7% vs FTS) were on bge-small 384d.
  **Re-benchmark on BGE-M3 with a frozen JSONL gold set** — this is a production gate, and
  the honest input for any competitive claim.
- **B5 [M] — No backpressure/scheduling** across eval pool + embedding + inference; they
  contend for local compute. Define a scheduler / concurrency budget.
- **B6 [M] — git RSI substrate grows unbounded** (no GC/compaction).
- **B7 [M] — Multi-user/tenant undefined.** Product is single-user local. Decide what
  "enterprise" means concretely (per-user isolation? team sync? data residency?) before
  building toward it — otherwise it's an unanchored requirement.

---

## C. ROBUSTNESS / FOOL-PROOF

- **C1 [H] — Hardening sweep incomplete (signal).** Two latent robustness bugs were found
  in supposedly production-track code (hang on a lost bridge response → timeout fix; libgit2
  thread starvation → `spawn_blocking`). Pattern implies more un-swept edges. Do a deliberate
  pass: every cross-process request needs a timeout; every blocking call off the async pool.
- **C2 [M] — Graceful degradation is good but unaudited end-to-end.** FMS recall falls back
  to FTS5 on any error and never throws (verified, strong). **Check** the same discipline on
  every host↔sidecar path (no infinite spinners — the bench panel had one).
- **C3 [H] — Onboarding hidden dependency for non-tech users.** MCP + some connectors require
  `npx`/Node on PATH. The primary audience is non-technical (memory). A missing Node = silent
  failure. Need detection + a guided install or a bundled runtime.
- **C4 [M] — Crash-safety partial-write.** Tree persist failure is non-fatal and serves
  in-memory (good pattern, `fractal-memory.ts:322`). **Check** SQLite writes + git substrate
  are atomic/transactional under crash.
- **C5 [M] — Empty/cold-start states.** Confirm zero-friction first run: empty memory, no
  model yet, no embedding GGUF on disk (downloads first run) all degrade gracefully with
  clear UI, not errors.

---

## Prioritized backlog

| # | Sev | Item | Domain |
|---|-----|------|--------|
| 1 | **C** | RSI continuous loop → event-driven Dream Cycle + budget cap | Scale/Cost |
| 2 | **H** | Verify updater pubkey rotation (A3) | Security |
| 3 | **H** | Re-benchmark FMS on BGE-M3, frozen gold set (B4) | Scale/Proof |
| 4 | **H** | MCP supply-chain: pin/curate npx packages (A1) | Security |
| 5 | **H** | RSI telemetry (B3) | Scale/Ops |
| 6 | **H** | Incremental FMS indexing (B2) | Scale |
| 7 | **H** | Robustness sweep: timeouts + spawn_blocking everywhere (C1) | Robustness |
| 8 | **H** | Non-tech onboarding: Node/npx detection + guidance (C3) | Robustness |
| 9 | **M** | Verify: MCP cmd/c filter (A2), desktop gating (A4), secrets (A5), SSRF (A6) | Security |
| 10 | **M** | Backpressure (B5), git GC (B6), tenant model (B7), crash-safety (C4), cold-start (C5) | Scale/Robust |

## Open verification items (pass 2)
A2, A3, A4, A5, A6, C4, C5 — each has the exact check inline above. These need a
focused read pass before they move from [VERIFY] to a confirmed finding/clear.
