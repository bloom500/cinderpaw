# SP0 — Unify on one `feral` (npm bundle, Windows-first)

**Date:** 2026-07-03
**Status:** Approved (Darius + GPT 5.5 review)
**Branch:** feat/faza4-5-runtime-extraction
**Part of:** Faza 4.5 final vision — "One Brain, Many Faces". First of three
sub-projects (SP0 packaging/unify → SP1 setup wizard v2 → SP2 polish).

## Goal

`npm install -g feral-agent` gives the user **one** command — `feral` — that does
`setup`, `chat`, `doctor`, `gateway`, `stop`, `status`. The user never learns that
Rust, Bun, a sidecar, a gateway, or a runtime exist. Those are internal.

The confusion the user hit — two `feral` binaries (a TS npm CLI without `doctor`,
and a Rust CLI that npm doesn't ship) — is a **packaging artifact**, not a design
flaw. The real architecture already works:

```
feral (Rust feral-cli = command router + runtime)
   └─ spawn + stdio ─► feral-agent (TS/Bun sidecar = the agent brain)
```

SP0 makes npm ship the Rust binary as `feral`, with the TS sidecar bundled beside
it, so `find_binary()` locates the sidecar with zero code change.

## Non-goals (explicitly deferred)

- **SP1:** rich setup wizard (hardware detect, Hugging Face model browser with
  ratings + download, 13-provider cloud wizard with key validation, hybrid
  routing, dreams/memory/LoRA sections), and the idempotent "what do you want to
  change? Models / Providers / Connectors / Everything" menu.
- **SP2:** per-subsystem readiness cascade (`✓ Brain ✓ Memory ✓ Dreams`), doctor
  health score, chat slash commands, `connectors add` wizard, pretty stop output.
- macOS / Linux packaging, CI matrix builds (Windows-first, manual publish).

## Architecture — Command Router

`feral` (Rust) is a command router. Each command either runs natively (Rust) or
delegates to the sidecar internally. Delegation is invisible: no user-facing
"launching wizard" / "starting TS" text. If a command is rewritten later (e.g. the
wizard moves from TS to Rust in SP1), the user-facing `feral <cmd>` does not change.

| Command | Runs in | Notes |
|---|---|---|
| `feral chat` | Rust (chat.rs) | **Primary entrypoint.** Auto-starts gateway if down (see below). |
| `feral setup` | Rust (admin.rs) | Exec's `feral-tui.exe --wizard` (the Go/Bubble Tea onboarding TUI). The on-board wizard code that used to live in the sidecar's `tui/setup.ts` was removed 2026-07-07 in the terminal-onboarding slice (Phase 0a) — it hardcoded a cloud provider and silently dropped keys. |
| `feral-agent setup` | sidecar CLI dispatch | Friendly redirect to `feral setup` with a non-zero exit. The `tui/setup.ts` path no longer exists in the compiled sidecar. |
| `feral doctor` | Rust | Includes the brain-config check added 2026-07-03. |
| `feral gateway start\|stop\|restart\|status` | Rust | Advanced/explicit (services, Discord bot, server, debug). |
| `feral stop` | Rust | Top-level alias → `gateway stop`. |
| `feral status` | Rust | Top-level alias → `gateway status`. |
| `feral model\|logs\|connectors\|dreams\|config\|completion` | Rust | Unchanged. |

## Components

### 1. Vendor layout in the npm package

Ship both prebuilt binaries in the same directory so `find_binary()` (which probes
`current_exe().parent()` for `feral-agent.exe`) resolves the sidecar automatically:

```
FeralAgent/
  bin/feral.js               launcher (node)
  vendor/feral-cli.exe       Rust release build (~15 MB)
  vendor/feral-agent.exe     sidecar, bun --compile (~110 MB)
```

`package.json` `files` becomes: `["bin", "vendor", "brain.example.json", "README.md"]`.
Drop `src` (not needed at runtime) and `dist/feral-agent.js` (superseded by the
vendored sidecar). `vendor/` is git-ignored (build output) and populated by the
packaging script before publish.

**No change to `feral_core::feral_agent::find_binary`** — its existing
`current_exe().parent()` probe already finds a sibling `feral-agent.exe`.

### 2. Launcher `bin/feral.js` (node)

Node is guaranteed by npm; Bun is not. The launcher:

- Shebang `#!/usr/bin/env node` (replaces the old `#!/usr/bin/env bun` + TS import).
- Platform guard: if `process.platform !== "win32"`, print
  `Feral is Windows-only for now — macOS/Linux are coming.` and exit 1.
- Resolve `vendor/feral-cli.exe` relative to `__dirname`. If missing, print a clear
  "binary not found — reinstall" error and exit 1.
- `spawnSync(exe, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, FERAL_VERSION: <pkg.version> } })`.
- Exit with the child's exit code (`process.exit(status ?? 1)`).

### 3. `feral setup` bridge

Add a `Setup` variant to the Rust `Command` enum. It auto-starts the gateway
if it is down, then execs `feral-tui.exe --wizard` (the Go/Bubble Tea
onboarding TUI) with inherited stdio, forwarding the exit code. Idempotency
is the wizard's responsibility — `WizResume` covers partial progress and
`WizConfigHandling` covers existing config (Keep / Review / Reset); the Rust
side just hands control over.

> Note: `feral-agent setup` (the sidecar binary run directly) used to load
> `tui/setup.ts` (the hardcoded-Anthropic wizard). That file was removed in
> the 2026-07-07 terminal-onboarding slice (Phase 0a). The sidecar now
> emits a friendly redirect with exit code 2 and points at `feral setup`.
> Anyone using the sidecar binary directly is on a non-canonical path and
> should switch to the Rust CLI.

### 4. `feral chat` auto-starts the gateway (the key UX change)

`feral chat` is the primary entrypoint and must not require a manual
`gateway start` first (Docker Desktop / Ollama / Claude Desktop behavior).

Pre-flight in chat.rs before connecting the TUI:

1. Probe the gateway: `GET /runtime/status` on the api port with the token.
2. If reachable → connect the TUI directly.
3. If connection refused → print `Runtime not running. Starting...`, run the same
   detached-spawn logic as `gateway_start` (spawn `feral-cli.exe gateway`, write
   `~/.feral/gateway.log` + pid, wait for the port to bind, up to a timeout),
   print `✓ Runtime ready`, then connect the TUI.
4. On timeout / bind failure → clear error, exit non-zero (do not hang).

The gateway is spawned **detached**, so it persists after `feral chat` exits
(daemon stays up, like Ollama). `feral stop` shuts it down. The rich per-subsystem
cascade (`✓ Brain ✓ Memory ✓ Dreams`) is SP2; SP0 shows a single `✓ Runtime ready`.

Note: auto-start boots the runtime, not a model. If setup configured no model,
chat connects but the first message errors cleanly — model provisioning is SP1.

### 5. `feral stop` / `feral status`

Two top-level `Command` variants that call the existing `admin::gateway_stop()` /
`admin::gateway_status()`. Thin aliases, no new logic.

### 6. Version reconciliation

`package.json` version (CalVer, e.g. `2026.7.3`) is the single source of truth. The
launcher injects `FERAL_VERSION`; the Rust `version` command prefers `FERAL_VERSION`
when set, else its compiled Cargo version. (Bumping the Cargo workspace version to
match at build time is optional polish, not required for SP0.)

### 7. Packaging & publish (Windows, manual for MVP)

`scripts/package-win.mjs` (run on Darius's Windows machine before publish):

1. `cargo build --release -p feral-cli` → copy `target/release/feral-cli.exe` to
   `FeralAgent/vendor/feral-cli.exe`.
2. `bun build src/index.ts --compile --outfile FeralAgent/vendor/feral-agent.exe`
   (the sidecar; plain `feral-agent.exe` name is what `find_binary` expects beside
   the main exe).
3. `npm publish` (or `npm pack` to inspect) from `FeralAgent/`.

`publish-npm.yml` runs on ubuntu and cannot cross-build the Windows binaries, so
for the Windows-first MVP publishing is manual from Windows. A CI matrix build is
deferred (noted for the macOS/Linux migration to per-platform packages, variant C).

## Testing

- **Launcher unit test** (node): platform guard returns the "Windows-only" message
  + exit 1 on a simulated non-win32; vendor path resolves relative to `__dirname`.
- **`npm pack --dry-run`**: the tarball contains `bin/feral.js`,
  `vendor/feral-cli.exe`, `vendor/feral-agent.exe`, `brain.example.json`, README —
  and does NOT contain `src/` or `dist/feral-agent.js`.
- **Manual Windows smoke** (the chain the user cares about):
  `npm i -g .` → `feral doctor` (Rust runs, finds the sibling sidecar) →
  `feral setup` (sidecar wizard, no TS/wizard wording leaks) →
  `feral chat` from a cold state → prints `Runtime not running. Starting... →
  ✓ Runtime ready` → enters the TUI → `feral status` shows running →
  `feral stop` shuts it down.

## Risks / open points

- **130 MB tarball per publish** — accepted (Windows-first, pre-1.0; competitors
  ship Node+Python+uv/venv anyway). Migrate to per-platform `optionalDependencies`
  (variant C) when macOS/Linux land.
- **Detached gateway lifetime** — auto-started gateway persists after chat exits by
  design. `feral stop` is the off switch; `feral status` shows state. Acceptable
  daemon behavior.
- **Manual publish** — until CI matrix exists, only Darius (Windows) can publish a
  correct build. Documented in the packaging script header.
