# Security Policy

> **In plain words.** Cinderpaw runs on your computer, so most of what is below
> is about keeping other programs on that computer, and the web pages the agent
> reads, from getting at your files and your keys. Three things are worth
> knowing even if you skip the rest:
>
> 1. The agent **can run commands on your computer** as soon as you install it.
>    That is how it does real work. Turn it off by setting
>    `CINDERPAW_ENABLE_SHELL_EXEC=false`.
> 2. Its **file tools** can read and write your files, but never inside
>    `~/.cinderpaw` or `~/.ssh`, where its own keys and your login keys live.
>    That deny wall does not extend to a program `shell_exec` starts: a spawned
>    process runs with your permissions and can read what you can read. Only
>    destructive commands aimed outside the workspace roots are refused.
> 3. If you find a hole, **do not post it publicly**. Email us instead. The
>    address is right below.
>
> The rest of this page is written for security researchers.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

- Email: **bloommediacorporation@gmail.com** with subject `[SECURITY] Cinderpaw`
- Or use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability).

You can expect an acknowledgement within a few days. Please include steps to
reproduce and the version (Settings → About). Coordinated disclosure is
appreciated — we'll credit you in the release notes unless you prefer
otherwise.

## Threat model (what protects what)

Cinderpaw is a local-first desktop app: a Tauri (Rust) shell, a bundled llama.cpp
engine behind a loopback HTTP API, and a Bun/TypeScript agent sidecar.

### Local inference API (port 11435)

- Binds to **127.0.0.1 only** — never exposed to the LAN.
- Every route requires a **per-launch random bearer token**, shared only with
  the sidecar (injected env) and, for external consumers, `~/.cinderpaw/api-token`.
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
  there is no Cinderpaw relay server.

### Agent sidecar sandbox

Every tool call passes a security layer before execution:

- **Manifest permissions** — tools declare `fs:read` / `fs:write` /
  `network:outbound` / `process:spawn`; undeclared permissions are blocked.
- **Egress proxy** — all network I/O goes through `ctx.fetch()` with per-tool
  domain allowlists, SSRF blocking (loopback / private / link-local ranges),
  rate limits, and an audit log.
- **Path containment** — filesystem tools resolve against declared roots with
  `realpath` symlink-following; traversal is rejected before any disk access.
- **Process sandbox** — `shell_exec` is **on by default**; set
  `CINDERPAW_ENABLE_SHELL_EXEC=false` to unregister it. It is argv-only: the
  command is spawned directly, never through `sh -c`, so shell metacharacters
  are literal arguments rather than a second command. There is deliberately
  **no binary allowlist** (the old one listed the shells themselves, so
  `sh -c "<anything>"` walked straight past it); `CINDERPAW_SHELL_WHITELIST`
  restricts to a named set when that is genuinely wanted. What holds the line
  instead: owner-only exposure (`PUBLIC_ALLOWED_TOOLS` omits the tool, and every
  connector session is gated by that connector's inbound allowlist), a scrubbed
  environment (`LD_*`, `DYLD_*`, `NODE_*`, `PYTHONPATH` stripped, PATH forced
  from a safe base), `read_only` mode refusing mutating intents by
  classification, output caps and a hard timeout ceiling. The catastrophic-
  command denylist (`rm -rf /`, `mkfs`, fork bombs) is a footgun guard, not a
  boundary: `python -c` walks past it.
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
