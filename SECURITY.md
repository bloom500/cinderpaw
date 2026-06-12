# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

- Email: **bloommediacorporation@gmail.com** with subject `[SECURITY] Feral`
- Or use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability).

You can expect an acknowledgement within a few days. Please include steps to
reproduce and the version (Settings → About). Coordinated disclosure is
appreciated — we'll credit you in the release notes unless you prefer
otherwise.

## Threat model (what protects what)

Feral is a local-first desktop app: a Tauri (Rust) shell, a bundled llama.cpp
engine behind a loopback HTTP API, and a Bun/TypeScript agent sidecar.

### Local inference API (port 11435)

- Binds to **127.0.0.1 only** — never exposed to the LAN.
- Every route requires a **per-launch random bearer token**, shared only with
  the sidecar (injected env) and, for external consumers, `~/.feral/api-token`.
  This closes the same-host surface: other local processes and browser-based
  DNS-rebinding/CORS probes can reach the port but cannot authenticate.
- Token comparison is constant-time; CORS is restricted to loopback origins.
- Model-deletion routes validate bare filenames and canonicalize against the
  models directory (symlink/`..`/TOCTOU defenses).

### API keys (BYOK)

- Cloud provider keys are stored by the Rust shell and injected server-side;
  **keys never enter the React renderer**. The UI only ever sees a
  display-safe model config view.
- Requests go directly from your machine to the provider you configured —
  there is no Feral relay server.

### Agent sidecar sandbox

Every tool call passes a security layer before execution:

- **Manifest permissions** — tools declare `fs:read` / `fs:write` /
  `network:outbound` / `process:spawn`; undeclared permissions are blocked.
- **Egress proxy** — all network I/O goes through `ctx.fetch()` with per-tool
  domain allowlists, SSRF blocking (loopback / private / link-local ranges),
  rate limits, and an audit log.
- **Path containment** — filesystem tools resolve against declared roots with
  `realpath` symlink-following; traversal is rejected before any disk access.
- **Process sandbox** — `shell_exec` is **off by default**
  (`FERAL_ENABLE_SHELL_EXEC`), argv-only (no shell interpretation), restricted
  to a binary whitelist, with a scrubbed environment (`LD_PRELOAD`,
  `NODE_OPTIONS`, `PYTHONPATH` etc. stripped) and output caps.
- **Audit log** — every tool call, network request, and inference call is
  written to SQLite.

### Updates

- Releases are signed (tauri-plugin-updater / minisign) and verified against
  the public key embedded in the installed app.
- The 0.1.x signing key was exposed in git history and has been **rotated**;
  see `docs/UPDATER_KEY_MIGRATION.md` for the migration plan and its
  transition-window risk analysis.

### Privacy

- Local models: prompts, conversations, and memory never leave the machine.
- `<private>…</private>` blocks are stripped before any memory write.
- No telemetry, no analytics, no crash reporting.

## Out of scope

- Vulnerabilities requiring an already-compromised machine (malware running
  as the same user can read the same files any local app can).
- Prompt-injection making the model *say* something — in scope only when it
  escalates to unauthorized tool actions that bypass the sandbox above.
- Third-party provider behaviour (what OpenAI/Anthropic/… do with traffic
  you send them via your own key).

## Supported versions

Only the latest release receives security fixes.
