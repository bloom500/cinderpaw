# Security Policy

> **In plain words.** Cinderpaw runs on your computer, so most of what is below
> is about keeping other programs on that computer, and the web pages the agent
> reads, from getting at your files and your keys. Three things are worth
> knowing even if you skip the rest:
>
> 1. The agent **can run commands on your computer** as soon as you install it.
>    `CINDERPAW_ENABLE_SHELL_EXEC=false` disables that tool; other process-capable
>    tools have separate controls.
> 2. Its **file tools** apply root and protected-path checks, with an agent
>    scratch-directory exception. Those checks do not sandbox spawned programs,
>    which run with your permissions. Path checks and command classification
>    are not a complete isolation boundary; see the limits below.
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
- Every route requires a **per-launch random bearer token**, available to the
  sidecar, the desktop token command and external consumers via
  `~/.cinderpaw/api-token`. Requests without it cannot authenticate; processes
  able to read that file can authenticate. This does not isolate same-user processes.
- Token comparison is constant-time; CORS is restricted to loopback origins.
- Model-deletion routes validate bare filenames and canonicalize against the
  models directory. The later path-based operation is not atomic with these
  checks, so they do not eliminate check/use races.

### API keys (BYOK)

- Cloud provider keys use host-side storage and injection on supported paths.
  Key-entry UI necessarily handles keys; other renderer-facing paths and
  migration/redaction gaps were identified in the September 6 audit. Complete
  renderer isolation is intended but not implemented across all paths.
- Requests go directly from your machine to the provider you configured —
  there is no Cinderpaw relay server.

### Agent sidecar sandbox

Every tool call passes a security layer before execution:

- **Manifest permissions** — tools declare `fs:read` / `fs:write` /
  `network:outbound` / `process:spawn`; undeclared permissions are blocked.
- **Egress proxy** — built-in web tools using `ctx.fetch()` receive per-tool
  domain allowlists, SSRF blocking (loopback / private / link-local ranges),
  rate limits, and audit attempts. Inference, connectors, and external processes
  have separate network paths; MCP manifest hints do not sandbox server I/O.
- **Path containment** — filesystem tools resolve against declared roots with
  `realpath` symlink-following; traversal is rejected before any disk access.
- **Process sandbox** — `shell_exec` is **on by default**; set
  `CINDERPAW_ENABLE_SHELL_EXEC=false` to unregister it. It is argv-only: the
  command is spawned directly. A caller can explicitly request `sh -c` or another
  interpreter, which then interprets its arguments. There is deliberately
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
- **Audit log** — instrumented tool, network, and inference paths attempt SQLite
  writes. Failures increment a dropped-entry counter and report to stderr;
  verifying the retained hash chain does not prove every action was recorded.

### Updates

- Releases are signed (tauri-plugin-updater / minisign) and verified against
  the public key embedded in the installed app.
- The 0.1.x signing key was exposed in git history and has been **rotated**;
  see `docs/UPDATER_KEY_MIGRATION.md` for the migration plan and its
  transition-window risk analysis.

### Privacy

- Local inference runs locally; web tools, connectors, downloads and configured
  background/provider routes can still transmit data.
- Complete `<private>…</private>` blocks are stripped from the agent loop's
  episodic text, not every memory or transcript writer. The model sees the input.
- No automatic analytics or crash-report uploads in the audited runtime.

### Known limits

The September 6 promise audit found credential migration/redaction, fallback/
redirect, recursive file access, and execution-control gaps. These stronger
boundaries remain security goals; this document does not certify them as enforced.

## Out of scope

- Vulnerabilities requiring an already-compromised machine (malware running
  as the same user can read the same files any local app can).
- Prompt-injection making the model *say* something — in scope only when it
  escalates to unauthorized tool actions that bypass the sandbox above.
- Third-party provider behaviour (what OpenAI/Anthropic/… do with traffic
  you send them via your own key).

## Supported versions

Only the latest release receives security fixes.
