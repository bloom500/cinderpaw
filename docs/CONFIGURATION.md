# FERAL configuration reference

> **Audience:** operators, integrators, and security reviewers. End users
> who only want the wizard-driven experience can stop after §1.
>
> **Machine-checked:** the canonical list of `FERAL_*` env vars lives
> in the fenced `feral-env-vars` block at the bottom of this file.
> `scripts/check-env-docs.mjs` greps source for `FERAL_*` and fails if
> anything in code is missing from that block (or vice-versa). Run it
> after adding a new env var.

Feral reads ~90 env vars across two runtimes (the Rust host
`crates/feral-core` and the TypeScript sidecar `FeralAgent/`). This
document lists every one, the default, the read site, and — for the
security-relevant ones — an explicit threat note.

## 1. Security-critical vars (read this first)

If you only have time to read one section, read this one. Each row
below is an env var that can grant capabilities beyond the default
sandbox. **Do not enable any of these on a multi-user host, a CI
runner, or anything that handles untrusted input.**

| Var | Default | Threat when enabled | Mitigation |
|---|---|---|---|
| `FERAL_ENABLE_SHELL_EXEC` | off | Spawns `cmd` / `pwsh` / `sh` from the `shell_exec` tool, with a whitelist of programs (`process-sandbox.ts`). Any listed binary inherits the agent's prompt — prompt-injection = full process creation. | Keep the whitelist tight; deny `pwsh -Command "iex …"` patterns. |
| `FERAL_ENABLE_CODE_EXEC` | off | Runs Python in a subprocess with a sanitized env. The process can read files the agent has access to and emit subprocesses of its own. | Restricted env, no network by default. |
| `FERAL_ENABLE_DESKTOP_CONTROL` | off | `control_app` tool can move the mouse, click, type, and drive any focused OS app. There is no per-window permission — "the desktop" is one privilege. | Keep the per-action confirmation ON (`FERAL_DESKTOP_CONTROL_CONFIRM` not set to `false`). |
| `FERAL_DESKTOP_CONTROL_CONFIRM=false` | off (i.e. confirmation is on) | Disables the per-action confirmation dialog. Same privilege as above, but silently — the user no longer sees what's about to happen. | Don't set this on shared machines; document who is YOLO. |
| `FERAL_DESKTOP_CONTROL_ALLOWED_APPS` | empty | Comma-separated allowlist of app names the `control_app` tool will target. Empty = no targets accepted (tool fails closed). | Use this even if the tool itself is enabled; deny untrusted app names. |
| `FERAL_DESKTOP_CONTROL_NO_PROMPT_OK` | off | Sidecar-internal kill-switch that the desktop host uses to remember "user already approved this exact action"; see `control-app.ts`. | Not a security boundary; remains a UX shortcut only. |
| `FERAL_DB_KEY` | unset (no encryption at rest) | 32-byte key for the agent's SQLite DB. **Anyone who can read this value can read the DB.** Treat it as a root secret. | Generate once per install; persist in OS keychain, not dotfiles. |
| `FERAL_AGENT_WORKSPACE` | unset (deny all tool access to host FS) | Sidecar-internal Rust tools accept absolute paths under this value. Set to `/` on Unix or `C:\` on Windows to grant full disk access to code-exec and shell. | Always absolute, never `/`, never `C:\`. |
| `FERAL_WORKSPACE` | (TS list — see trap below) | Agent FS roots. Anything in this list, plus any child, is exposed to write tools. Unset = launch cwd + the user's home dir. | The call-time deny wall (`tool-permissions.ts`) refuses `~/.feral` (except scratch), `~/.ssh`, and `FERAL_FS_DENY` targets on every access, whatever the roots. |
| `FERAL_FETCH_DOMAINS` | empty | Comma-separated URL allowlist for the `fetch_url` tool. Empty = tool fails closed. With this set, the agent can pull arbitrary HTML from each listed origin. | Add only origins you trust to serve benign HTML. |
| `FERAL_HTTP_DOMAINS` | empty | Same shape, for the lower-level `http_request` tool. | Same advice. |
| `FERAL_TRUSTED_BASE_URLS` | empty | Comma-separated base URLs the inference router may call beyond the loopback default. Bypasses the egression posture in `inference-router.ts`. | List one provider base URL per entry; never `*`. |
| `FERAL_SHELL_WHITELIST` | default set | Extends the spawn whitelist for `shell_exec`. Same threat as `FERAL_ENABLE_SHELL_EXEC`. | Audit on every change; this list can grow silently. |
| `FERAL_SHELL_DENYLIST` | default set | Overrides the built-in denylist of dangerous binaries `shell_exec` refuses even in YOLO mode. | Only ever extend it; shrinking it removes a safety net. |
| `FERAL_PROACTIVE_ENABLED` | off | Enables the inner-thoughts / mood engines. Same prompt-injection surface as the agent loop, just on a timer. | Don't enable on shared hosts. |
| `FERAL_INNER_THOUGHTS_ENABLED` | off | Sub-flag of proactive. Same threat. | Don't enable on shared hosts. |
| `FERAL_SEARXNG_URL` | unset | The one origin exempted from the egress SSRF guard's loopback/private block, so `web_search` can reach a SearXNG you host. A wrong value points the agent at an internal service. | Set it to an instance **you** run. The exemption is exact-origin (port included), waives only the private-address check (the domain whitelist still applies), and is re-checked on every redirect hop. |

## 1b. Web search

With nothing configured, `web_search` queries DuckDuckGo — keyless, no setup,
real ranked results.

DuckDuckGo rate-limits automated queries, so Feral **paces** them: at most one
every 5 seconds (`FERAL_DDG_MIN_INTERVAL_MS`), serialised, so parallel tool
calls queue instead of bursting. That gap is what keeps the backend working —
measured from one IP, 12 queries back-to-back got 7 served and then a
ten-minute block, while the same queries paced 3, 5 or 10 seconds apart all
succeeded. If the limiter is tripped anyway, Feral backs off for two minutes
and says so (`rate_limited`) rather than pretending the web went empty.

The limit is per-IP, so everything else on your connection shares it. Raise the
interval if you see `rate_limited`; about 3s is the floor.

The cost of that pacing is latency: a research loop doing eight searches spends
about 40 seconds waiting. If that bothers you, or you search heavily, run
[SearXNG](https://docs.searxng.org/) — a self-hosted metasearch aggregator:
several engines at once, no rate limit, no pacing delay, no API key, no
per-query cost, and the queries never leave your machine, which is the point of
a local-first agent.

```bash
docker run -d --name searxng -p 8888:8080 \
  -e SEARXNG_BASE_URL=http://127.0.0.1:8888/ \
  searxng/searxng
```

Then enable the JSON API — **SearXNG ships with it off**, and without this every
search returns HTTP 403:

```yaml
# in the container's /etc/searxng/settings.yml
search:
  formats:
    - html
    - json
```

Restart it, then point Feral at it:

```bash
export FERAL_SEARXNG_URL=http://127.0.0.1:8888
```

If a configured SearXNG is unreachable or misconfigured, `web_search` falls back
to DuckDuckGo and says so in the result — a working search beats a dead tool, but
a backend that has been down for a week should not be invisible either.

## 2. The `WORKSPACE` trap

There are **two** env vars with confusingly similar names. They are
**not** the same thing and are read by different runtimes:

| Var | Runtime | Type | Default | Effect |
|---|---|---|---|---|
| `FERAL_AGENT_WORKSPACE` | Rust host (`crates/feral-core`) | single absolute path | unset | Sidecar-internal Rust tools (e.g. raw FS access) accept absolute paths only under this single root. |
| `FERAL_WORKSPACE` | TS sidecar (`FeralAgent/src/boot.ts` `loadWorkspaceRoots`) | path-list | launch cwd + home + scratch | Write tools and the agent's filesystem exposure are rooted at this list, plus an automatic scratch dir. `~/.feral`/`~/.ssh`/`FERAL_FS_DENY` are denied at call time regardless. |

If you set one and meant the other, the agent will fail in confusing
ways (Rust tools will deny paths the TS sidecar allowed, or vice versa).
Set both deliberately.

The TS loader **refuses to include any path that would expose
`~/.feral/`** (and a few other self-protection walls). See
`FeralAgent/src/workspace-roots.ts` for the canonical list of dropped
roots.

## 3. Var reference — by domain (TS sidecar)

This table is generated from `FeralAgent/src/config.ts`'s `CONFIG_SCHEMA` by
`scripts/gen-config-docs.mjs`. Run that script after adding a schema row;
`scripts/check-env-docs.mjs` fails if this section drifts from the schema.
Vars not yet migrated to `config.ts` getters are still read directly via
`process.env.FERAL_*` at their call sites (see `FeralAgent/tests/config.test.ts`'s
grandfathered list) but are documented here regardless, since the schema
covers every TS-side var, migrated or not.

Rust-side vars (`FERAL_ENABLE_CODE_EXEC`, `FERAL_AGENT_WORKSPACE`,
`FERAL_DESKTOP_CONTROL_ALLOWED_APPS`'s host-side enforcement,
`FERAL_MAX_LOCAL_CONTEXTS`, `FERAL_MODEL_WAIT_MS`, `FERAL_FORCE_SIDECAR_BUILD`,
`FERAL_SKIP_SIDECAR_BUILD`, `FERAL_SMOKE_GGUF`, `FERAL_FMS_BENCH`, `FERAL_E2E`,
`FERAL_DISCORD_CLIENT_ID`, and others in `crates/feral-core` / `src-tauri/src`)
are NOT read by `FeralAgent/src` and so are out of scope for `config.ts`;
they remain hand-maintained here and are still covered by
`scripts/check-env-docs.mjs`'s full-source drift check.

<!-- TS-SCHEMA-TABLE -->
<!-- AUTO-GENERATED by scripts/gen-config-docs.mjs from FeralAgent/src/config.ts. Do not hand-edit this section. -->

| Var | Type | Default | Security | Description |
|---|---|---|---|---|
| `FERAL_DB_KEY` | string | `null` | yes | 32-byte base64 key for at-rest encryption of sensitive DB columns. Anyone who can read this can read the DB. |
| `FERAL_WORKSPACE` | list | `null` | yes | TS sidecar path-list of FS roots. Unset = launch cwd + the user's home dir (broad by default; set to RESTRICT). The call-time deny wall (tool-permissions.ts) protects ~/.feral, ~/.ssh and FERAL_FS_DENY regardless of roots. |
| `FERAL_FS_DENY` | list | `null` | yes | Extra comma/semicolon-separated paths the fs tools may never touch, on top of the built-in ~/.feral + ~/.ssh deny wall. |
| `FERAL_ENABLE_SHELL_EXEC` | bool | `true` | yes | Registers shell_exec (argv-only, whitelisted). On by default; set to "false" to disable. Doc note: an earlier draft of this doc said default off — the code's actual default is ON. |
| `FERAL_ENABLE_DESKTOP_CONTROL` | bool | `false` | yes | Registers control_app (OS accessibility-tree control). Off by default; set to "true" to enable. |
| `FERAL_DESKTOP_CONTROL_CONFIRM` | bool | `true` | yes | Per-action confirmation dialog for control_app writes. On by default; set to "false" to disable (inverse-toggle var — see report for why this call site is not migrated to cfgBool). |
| `FERAL_DESKTOP_CONTROL_NO_PROMPT_OK` | bool | `false` | yes | Sidecar-internal escape hatch: when true, a transport with no askUser bridge may proceed without confirmation instead of failing closed. |
| `FERAL_FORGE_NO_PROMPT_OK` | bool | `false` | yes | Sidecar-internal escape hatch: when true, tool_forge may create/update a tool on a transport with no askUser bridge instead of failing closed. This approves running agent-written code unattended — headless deployments only. |
| `FERAL_AUTONOMOUS` | bool | `false` | yes | Walk-away mode: ask_user does not block for a human. It takes the recommended option (or the first) immediately and logs the decision, so a long task runs unattended. The end-of-turn summary reports every auto-decision. Off by default. |
| `FERAL_DESKTOP_CONTROL_ALLOWED_APPS` | list | `null` | yes | Comma-separated allowlist of app names control_app may target. Empty = fail closed. (Read by the Rust host, not FeralAgent/src.) |
| `FERAL_FETCH_DOMAINS` | list | `null` | yes | Comma-separated domain allowlist for fetch_url. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT. |
| `FERAL_HTTP_DOMAINS` | list | `null` | yes | Comma-separated domain allowlist for http_request. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT. |
| `FERAL_EXTERNAL_WRITE_BUDGET` | int | `50` | yes | How many STATE-CHANGING external requests (POST/PUT/PATCH/DELETE) one session may make before the egress proxy stops it. Bounds a runaway loop that keeps changing things outside this machine — ad spend, published posts, CRM rows — during an unattended run. It caps VOLUME, not severity: one wrong write is inside any budget. 0 disables the cap. |
| `FERAL_DRY_RUN` | bool | `false` | yes | Log every STATE-CHANGING external request (POST/PUT/PATCH/DELETE) and do NOT send it. The agent is told the call was a dry run rather than handed a fake success, so it cannot build its next step on a write that never happened. The honest first run against a real ad or social account: let it do the whole task, then read exactly what it would have changed. |
| `FERAL_WRITE_CONFIRM_HOSTS` | list | `null` | yes | Hosts whose STATE-CHANGING requests are REFUSED while running unattended (FERAL_AUTONOMOUS). Reads are unaffected. Declared by the operator, never by the model — this is the guard that does not depend on the agent realising a call is expensive. Deliberately a human-declared list rather than built-in patterns for known money endpoints: a pattern list fails open for every API not on it while reading as though everything is covered. |
| `FERAL_TRUSTED_LOCAL_ORIGINS` | list | `null` | yes | Comma-separated exact origins (scheme+host+port) on loopback/private addresses that the SSRF guard may reach, for services the OPERATOR runs themselves. Exact-origin match only — trusting http://127.0.0.1:8080 does not trust any other local port — and the tool's own allowedDomains still applies. Extends the single FERAL_SEARXNG_URL exemption to any self-hosted backend. |
| `FERAL_TOOL_ALLOWED_DOMAINS` | list | `null` | yes | Set BY the sidecar ON a forged tool's child process — not something a user configures. Carries the hostnames that tool declared via tool_forge's `allowed_domains`; the runner turns it into an EgressProxy-backed globalThis.fetch, so a tool that declared nothing has no network. Setting it in the parent environment has no effect: createCustomTool always overwrites it from the tool's own record. |
| `FERAL_TRUSTED_BASE_URLS` | list | `null` | yes | Extra base URLs the inference router may call beyond loopback. |
| `FERAL_SHELL_WHITELIST` | list | `null` | yes | Extends the spawn whitelist for shell_exec. |
| `FERAL_SHELL_DENYLIST` | list | `null` | yes | Overrides the built-in shell_exec denylist (dangerous binaries refused even in YOLO mode). |
| `FERAL_PROACTIVE_ENABLED` | bool | `false` | yes | Master enable for the proactive/mood-engine loop. |
| `FERAL_INNER_THOUGHTS_ENABLED` | bool | `false` | yes | Sub-flag enabling the inner-thoughts loop. |
| `FERAL_MODEL` | string | `"qwen2.5:7b"` |  | Model id sent to the inference provider. |
| `FERAL_PROVIDER` | string | `"openai_compatible"` |  | Provider family adapter to use. |
| `FERAL_BASE_URL` | string | `"http://127.0.0.1:11435"` |  | Inference base URL the sidecar points at. |
| `FERAL_API_KEY` | string | `null` |  | Bearer token for the primary provider. |
| `FERAL_BYOK_PROVIDER` | string | `null` |  | Wizard-saved BYOK provider id; RSI's live-router model id falls back to this. |
| `FERAL_LOCAL_BASE_URL` | string | `null` |  | Loopback address of the bundled local engine, set by the host. Used ONLY as the degrade-to-local fallback when the primary is a cloud provider; ignored when not loopback. |
| `FERAL_LOCAL_MODEL` | string | `null` |  | Model id the bundled local engine serves (fallback target companion to FERAL_LOCAL_BASE_URL). |
| `FERAL_LOCAL_API_KEY` | string | `null` | yes | Bearer token for the loopback local engine (the host's local API token). |
| `FERAL_RATE_LIMIT_RPM` | int | `0` |  | Requests-per-minute cap applied to every inference endpoint, overriding the built-in published caps (NVIDIA NIM free tier = 40). 0 uses those defaults. Set this if you are on a paid tier with a different limit, or share one API key with something outside Feral. |
| `FERAL_FALLBACK_PROVIDER` | string | `"ollama"` |  | Provider to fall back to if the primary is unreachable. |
| `FERAL_FALLBACK_MODEL` | string | `null` |  | Model to fall back to. |
| `FERAL_FALLBACK_BASE_URL` | string | `"http://localhost:11434"` |  | Base URL for the fallback provider. |
| `FERAL_FALLBACK_API_KEY` | string | `null` |  | Bearer token for the fallback provider. |
| `FERAL_OLLAMA_NUM_CTX` | int | `null` |  | Override Ollama's num_ctx. |
| `FERAL_MAX_CONTEXT` | int | `8192` |  | Hard ceiling on context length the router allows. |
| `FERAL_SHELL_MAX_TIMEOUT_MS` | int | `300_000` | yes | Ceiling on shell_exec's per-call timeout_ms (clamped to 60s..60min). Raise it when a real build — cargo, gradle, a cold docker layer — legitimately runs past 5 minutes; the process is hard-killed at this bound and the agent cannot tell that apart from a genuine failure. |
| `FERAL_TURN_BUDGET_MS` | int | `1_200_000` |  | Wall-clock budget for ONE agent turn (clamped to 60s..6h). The iteration ceiling bounds tool-call count, not time; this bounds time. Only stops NEW iterations, so an in-flight tool is never cut off. Matters most on connectors, which have no Stop button. |
| `FERAL_SUMMARY_EXCERPT_CHARS` | int | `24_000` |  | Characters of the compacted transcript fed to the working-memory summarizer (head+tail sampled). Raise on big-context models so long tool-heavy tasks keep more detail in the summary note. |
| `FERAL_UNATTENDED_CONTINUATIONS` | int | `3` |  | Automatic continuations allowed after a turn hits the wall-clock budget during an UNATTENDED run (cron job, or a connector message answered while nobody is watching). 0 disables continuation and restores the old behaviour, where a long task simply stopped half-done and was reported as finished. Total wall clock is roughly (this + 1) x FERAL_TURN_BUDGET_MS, and is additionally capped by FERAL_CRON_JOB_TIMEOUT_MS for cron. |
| `FERAL_ATTACHMENT_MAX_CHARS` | int | `12_000` |  | Characters kept from ONE inbound attachment (a .txt/.md/code file, or the text extracted from a PDF) before it is truncated into the prompt. The default is sized for an 8k local context; raise it on a big-context cloud model so a whole document arrives in one message instead of a head slice. |
| `FERAL_TOOL_GRAMMAR` | string | `null` |  | Optional GBNF grammar to constrain tool-call output. Presence alone also toggles useToolGrammar (default on; set to literal "false" to disable — inverse-toggle var, not migrated). |
| `FERAL_VERSION` | string | `null` |  | Reported in startup logs; set by installer. |
| `FERAL_EMBED_GPU_LAYERS` | int | `null` |  | Embedding-model layers offloaded to GPU. 0 = CPU-only. |
| `FERAL_EMBED_MODEL` | path | `null` |  | Path to the embed GGUF; auto-discovered when unset. |
| `FERAL_EMBED_CHUNK` | int | `null` |  | Embedder input chunk size (tree-builder.ts). |
| `FERAL_BUDGET_CONVERSATION` | int | `5_000_000` |  | Per-conversation token ceiling. |
| `FERAL_BUDGET_DAY` | int | `50_000_000` |  | Per-day token ceiling. |
| `FERAL_BUDGET_POLICY` | string | `"compress_and_continue"` |  | "stop" or "compress_and_continue". |
| `FERAL_RSI_MAX_COST_USD` | string | `null` |  | RSI background USD cap (float). Unset = local-only. |
| `FERAL_CLOUD_TRANSCRIPT_BUDGET` | int | `200_000` |  | Cloud-specific transcript-size budget (AgentLoop.CLOUD_TRANSCRIPT_BUDGET fallback). |
| `FERAL_TTFT_DEADLINE_MS` | int | `null` |  | Time-to-first-token cap (perf-policy.ts, positive int only). |
| `FERAL_TOTAL_DEADLINE_MS` | int | `null` |  | Whole-completion cap. |
| `FERAL_STALL_MS` | int | `null` |  | Inter-token stall cap; wins over FERAL_CLOUD_IDLE_TIMEOUT_MS when both set. |
| `FERAL_CLOUD_IDLE_TIMEOUT_MS` | int | `60_000` |  | Legacy cloud-only idle-stream timeout back-compat knob. |
| `FERAL_FMS_MAX_LEAVES` | int | `null` |  | Cap on the FMS leaf store size. |
| `FERAL_FMS_DEDUP_SPAN_MS` | int | `30 * 24 * 60 * 60 * 1000` |  | Coalesce leaves whose last touch is within this window. |
| `FERAL_FMS_MERGE_THRESHOLD` | string | `"0.92"` |  | Cosine threshold (float) above which leaves merge. |
| `FERAL_FMS_EVICTION` | string | `null` |  | Eviction strategy (e.g. lru). |
| `FERAL_MERGE_THRESHOLD` | string | `null` |  | Older name for FERAL_FMS_MERGE_THRESHOLD, read directly (no inheritance in code). |
| `FERAL_TREE_BRANCH` | int | `null` |  | Branching factor for fractal tree build. |
| `FERAL_TREE_CLUSTER_MAX_CHARS` | int | `null` |  | Max cluster size in chars. |
| `FERAL_TREE_ITEM_MAX_CHARS` | int | `null` |  | Max item size in chars. |
| `FERAL_PII_REDACTION` | string | `"on"` |  | Master switch for PII redaction in memory writes; "off" disables (inverse-toggle var). |
| `FERAL_JINA_API_KEY` | string | `null` |  | Jina Reader key for read_webpage / deep_research. |
| `FERAL_SEARXNG_URL` | string | `null` | yes | Base URL of a SearXNG instance backing web_search (e.g. http://127.0.0.1:8888). A loopback/private origin here is trusted by the egress SSRF guard for web_search ONLY — set it only to an instance you run. |
| `FERAL_DDG_MIN_INTERVAL_MS` | int | `5000` |  | Minimum gap between DuckDuckGo queries on the keyless web_search fallback. DDG throttles by rate, not volume: measured from one IP, 12 back-to-back queries got 7 served then a >10min anti-bot block, while the same queries paced 3s/5s/10s apart all succeeded. The limit is per-IP and shared with everything else on the connection, so raise this if you see rate_limited; ~3s is the floor. 0 disables pacing. Ignored when FERAL_SEARXNG_URL is set. |
| `FERAL_RSI_PASSIVE` | bool | `true` |  | RSI supervisor passive mode. "false" disables (read via injected env in passive-supervisor.ts). |
| `FERAL_RSI_ALLOW_CLOUD` | bool | `false` |  | Opt-in: allow RSI to call cloud providers (anti-burn guard). |
| `FERAL_RSI_MAX_ITER` | int | `null` |  | Pin the episode iteration cap; unset = dynamic (genome/policy-derived). |
| `FERAL_RSI_MAX_TOKENS` | int | `null` |  | Per-call token cap for RSI evaluations. |
| `FERAL_RSI_EVAL_TOKEN_BUDGET` | int | `null` |  | Per-eval token budget in rsi/sidecar.ts. |
| `FERAL_RSI_CONCURRENCY` | int | `1` |  | Concurrent RSI evaluations. |
| `FERAL_RSI_COOLDOWN_MS` | int | `600_000` |  | Quiet period after a successful iteration. |
| `FERAL_RSI_IDLE_MS` | int | `180_000` |  | Quiet period before RSI wakes up. |
| `FERAL_RSI_POLL_MS` | int | `null` |  | Manual poll cadence override. |
| `FERAL_RSI_ERROR_THRESHOLD` | int | `3` |  | Consecutive error count that triggers a sleep. |
| `FERAL_RSI_ERROR_WINDOW_MS` | int | `900_000` |  | Sliding window for the error counter. |
| `FERAL_RSI_EPISODE_MS` | int | `null` |  | Max wall-clock per episode. |
| `FERAL_RSI_PLATEAU_ITERS` | int | `null` |  | Iters-with-no-improvement before RSI bails. |
| `FERAL_RSI_SCHEDULE_MS` | int | `null` |  | Force a fixed schedule (e.g. weekly wake). |
| `FERAL_RSI_STAGNATION_THRESHOLD` | int | `null` |  | Hard stagnation threshold. |
| `FERAL_RSI_STOP_ON_ACTIVITY` | bool | `false` |  | Pause RSI when the user is active. |
| `FERAL_RSI_TELEMETRY` | path | `null` |  | Telemetry JSONL file path override (default ~/.feral/rsi/dream.jsonl). Type is a path, not a bool — the existing doc mislabeled it as a bool switch. |
| `FERAL_CODE_RSI_REPO` | path | `null` |  | Source repo for code-RSI to propose/apply against; without it, code-RSI rounds and live-apply are unavailable. |
| `FERAL_MODULE_SEED` | int | `1` |  | Deterministic seed for module selection (module-host.ts). |
| `FERAL_CRON_TICK_MS` | int | `30_000` |  | Tick interval for the cron scheduler. |
| `FERAL_CRON_JOB_TIMEOUT_MS` | int | `300_000` |  | Max wall-clock for a single cron job. |
| `FERAL_HEARTBEAT_INTERVAL_MS` | int | `30_000` |  | Watchdog / liveness heartbeat cadence. |
| `FERAL_THOUGHTS_COOLDOWN_MS` | int | `14_400_000` |  | Quiet period between thoughts (4h). |
| `FERAL_THOUGHTS_MIN_IDLE_MS` | int | `600_000` |  | User must be idle this long before a thought fires (10m). |
| `FERAL_THOUGHTS_INTERVAL_MS` | int | `120_000` |  | Wake-and-evaluate cadence (2m). |
| `FERAL_THOUGHTS_DAILY_CAP` | int | `3` |  | Hard cap on thoughts per user-day. |
| `FERAL_THOUGHTS_MOOD_THRESHOLD` | string | `"0.5"` |  | Mood gate (float); thoughts fire only above this score. |
| `FERAL_BRAIN` | bool | `false` |  | Force-enable Brain Stack; if brain.json is missing, loadBrainConfig throws (read via injected env in brain-config.ts). |
| `FERAL_HOME` | path | `null` |  | Override the agent's profile dir (default ~/.feral/, resolved via homedir() when unset). |
| `FERAL_DB` | path | `"data/feral.db"` |  | Override the SQLite DB path. ":memory:" is a sentinel and is not path-resolved. |
| `FERAL_AGENT_BASE_PROMPT` | string | `null` |  | Universal operating manual injected into every model call; usually bundled. |
| `FERAL_SUBAGENT_MAX_SUMMARY_CHARS` | int | `4000` |  | Cap on subagent summary length returned to parent (negative = unlimited). |
| `FERAL_LORA_TRAINER_BIN` | path | `null` |  | Absolute path to the trainer binary. |
| `FERAL_LORA_TRAIN_TIMEOUT_MS` | int | `null` |  | Wall-clock cap on a single trainer invocation. |
| `FERAL_RUN_FRACTAL_BENCH` | bool | `false` |  | Run the fractal benchmark as part of boot. |
| `FERAL_FRACTAL_BENCH_COUNT` | int | `50` |  | Benchmark corpus size. |
| `FERAL_FRACTAL_BENCH_SEED` | int | `1` |  | Benchmark RNG seed. |
| `FERAL_FRACTAL_BENCH_QUERIES` | path | `null` |  | Override the benchmark query set. |
| `FERAL_FRACTAL_BENCH_MAX_LEAVES` | int | `0` |  | Cap the benchmark/dev fractal-memory leaf-store size (0 = unlimited / full corpus). |
| `FERAL_NO_COLOR` | bool | `false` |  | Disable ANSI colour output in the TUI. |
<!-- /TS-SCHEMA-TABLE -->

## 4. Footnotes

- *"Positive integer only"* means the perf-policy reader parses a
  `u64` and rejects zero and non-numeric strings. See
  `crates/feral-core/src/perf_policy.rs::read_env_optional`.
- *"Must be absolute"* — `FERAL_AGENT_WORKSPACE` only accepts absolute
  paths; relative paths log a warning and the value is ignored.
- All defaults reflect a *single-user, fully-local* install. The
  security group (§1) is the override surface for any multi-tenant or
  shared-host deployment.
- For the inference side, `provider(model, baseUrl, apiKey)` wins
  over `FERAL_*` when set explicitly via wizard/state. Treat the env
  vars as bootstrap-only on the wizard path.

---

<!-- The fenced block below is the canonical list. The check script
     parses ONLY this block; do not list vars anywhere else in this
     file without mirroring them here. -->

```feral-env-vars
FERAL_AGENT_BASE_PROMPT
FERAL_AGENT_WORKSPACE
FERAL_API_KEY
FERAL_ATTACHMENT_MAX_CHARS
FERAL_AUTONOMOUS
FERAL_BASE_URL
FERAL_BRAIN
FERAL_BUDGET_CONVERSATION
FERAL_BUDGET_DAY
FERAL_BUDGET_POLICY
FERAL_BYOK_PROVIDER
FERAL_CLOUD_IDLE_TIMEOUT_MS
FERAL_CLOUD_TRANSCRIPT_BUDGET
FERAL_CODE_RSI_REPO
FERAL_CRON_JOB_TIMEOUT_MS
FERAL_CRON_TICK_MS
FERAL_DB
FERAL_DB_KEY
FERAL_DESKTOP_CONTROL_ALLOWED_APPS
FERAL_DESKTOP_CONTROL_CONFIRM
FERAL_DESKTOP_CONTROL_NO_PROMPT_OK
FERAL_DISCORD_CLIENT_ID
FERAL_EMBED_CHUNK
FERAL_DRY_RUN
FERAL_EMBED_GPU_LAYERS
FERAL_EMBED_MODEL
FERAL_ENABLE_CODE_EXEC
FERAL_ENABLE_DESKTOP_CONTROL
FERAL_ENABLE_SHELL_EXEC
FERAL_EXTERNAL_WRITE_BUDGET
FERAL_FALLBACK_API_KEY
FERAL_FALLBACK_BASE_URL
FERAL_FALLBACK_MODEL
FERAL_FALLBACK_PROVIDER
FERAL_FETCH_DOMAINS
FERAL_FMS_DEDUP_SPAN_MS
FERAL_FMS_EVICTION
FERAL_FMS_MAX_LEAVES
FERAL_FMS_MERGE_THRESHOLD
FERAL_FORCE_SIDECAR_BUILD
FERAL_FORGE_NO_PROMPT_OK
FERAL_FRACTAL_BENCH_COUNT
FERAL_FRACTAL_BENCH_MAX_LEAVES
FERAL_FRACTAL_BENCH_QUERIES
FERAL_FRACTAL_BENCH_SEED
FERAL_FS_DENY
FERAL_HEARTBEAT_INTERVAL_MS
FERAL_HOME
FERAL_HTTP_DOMAINS
FERAL_INNER_THOUGHTS_ENABLED
FERAL_JINA_API_KEY
FERAL_LOCAL_API_KEY
FERAL_LOCAL_BASE_URL
FERAL_LOCAL_MODEL
FERAL_LORA_TRAIN_TIMEOUT_MS
FERAL_LORA_TRAINER_BIN
FERAL_MAX_CONTEXT
FERAL_MAX_LOCAL_CONTEXTS
FERAL_MERGE_THRESHOLD
FERAL_MODEL
FERAL_MODEL_WAIT_MS
FERAL_MODULE_SEED
FERAL_NO_COLOR
FERAL_OLLAMA_NUM_CTX
FERAL_PII_REDACTION
FERAL_PROACTIVE_ENABLED
FERAL_PROVIDER
FERAL_RATE_LIMIT_RPM
FERAL_RSI_ALLOW_CLOUD
FERAL_RSI_CONCURRENCY
FERAL_RSI_COOLDOWN_MS
FERAL_RSI_EPISODE_MS
FERAL_RSI_ERROR_THRESHOLD
FERAL_RSI_ERROR_WINDOW_MS
FERAL_RSI_EVAL_TOKEN_BUDGET
FERAL_RSI_IDLE_MS
FERAL_RSI_MAX_COST_USD
FERAL_RSI_MAX_ITER
FERAL_RSI_MAX_TOKENS
FERAL_RSI_PASSIVE
FERAL_RSI_PLATEAU_ITERS
FERAL_RSI_POLL_MS
FERAL_RSI_SCHEDULE_MS
FERAL_RSI_STAGNATION_THRESHOLD
FERAL_RSI_STOP_ON_ACTIVITY
FERAL_RSI_TELEMETRY
FERAL_RUN_FRACTAL_BENCH
FERAL_SEARXNG_URL
FERAL_DDG_MIN_INTERVAL_MS
FERAL_SHELL_DENYLIST
FERAL_SHELL_MAX_TIMEOUT_MS
FERAL_SHELL_WHITELIST
FERAL_SMOKE_GGUF
FERAL_SUMMARY_EXCERPT_CHARS
FERAL_STALL_MS
FERAL_SUBAGENT_MAX_SUMMARY_CHARS
FERAL_THOUGHTS_COOLDOWN_MS
FERAL_THOUGHTS_DAILY_CAP
FERAL_THOUGHTS_INTERVAL_MS
FERAL_THOUGHTS_MIN_IDLE_MS
FERAL_THOUGHTS_MOOD_THRESHOLD
FERAL_TOOL_GRAMMAR
FERAL_TOTAL_DEADLINE_MS
FERAL_TREE_BRANCH
FERAL_TREE_CLUSTER_MAX_CHARS
FERAL_TREE_ITEM_MAX_CHARS
FERAL_TOOL_ALLOWED_DOMAINS
FERAL_TRUSTED_LOCAL_ORIGINS
FERAL_TRUSTED_BASE_URLS
FERAL_TURN_BUDGET_MS
FERAL_UNATTENDED_CONTINUATIONS
FERAL_TTFT_DEADLINE_MS
FERAL_VERSION
FERAL_WRITE_CONFIRM_HOSTS
FERAL_WORKSPACE
```
