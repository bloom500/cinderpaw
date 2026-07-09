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
| `FERAL_WORKSPACE` | (TS list — see trap below) | Comma-separated agent FS roots. Anything in this list, plus any child, is exposed to write tools. | Do not include `~/.feral/`; the loader refuses (see `workspace-roots.ts`). |
| `FERAL_FETCH_DOMAINS` | empty | Comma-separated URL allowlist for the `fetch_url` tool. Empty = tool fails closed. With this set, the agent can pull arbitrary HTML from each listed origin. | Add only origins you trust to serve benign HTML. |
| `FERAL_HTTP_DOMAINS` | empty | Same shape, for the lower-level `http_request` tool. | Same advice. |
| `FERAL_TRUSTED_BASE_URLS` | empty | Comma-separated base URLs the inference router may call beyond the loopback default. Bypasses the egression posture in `inference-router.ts`. | List one provider base URL per entry; never `*`. |
| `FERAL_SHELL_WHITELIST` | default set | Extends the spawn whitelist for `shell_exec`. Same threat as `FERAL_ENABLE_SHELL_EXEC`. | Audit on every change; this list can grow silently. |
| `FERAL_PROACTIVE_ENABLED` | off | Enables the inner-thoughts / mood engines. Same prompt-injection surface as the agent loop, just on a timer. | Don't enable on shared hosts. |
| `FERAL_INNER_THOUGHTS_ENABLED` | off | Sub-flag of proactive. Same threat. | Don't enable on shared hosts. |

## 2. The `WORKSPACE` trap

There are **two** env vars with confusingly similar names. They are
**not** the same thing and are read by different runtimes:

| Var | Runtime | Type | Default | Effect |
|---|---|---|---|---|
| `FERAL_AGENT_WORKSPACE` | Rust host (`crates/feral-core`) | single absolute path | unset | Sidecar-internal Rust tools (e.g. raw FS access) accept absolute paths only under this single root. |
| `FERAL_WORKSPACE` | TS sidecar (`FeralAgent/src/workspace-roots.ts`) | comma-separated list of paths | project dir(s) + scratch | Write tools and the agent's filesystem exposure are rooted at this list, plus an automatic scratch dir. |

If you set one and meant the other, the agent will fail in confusing
ways (Rust tools will deny paths the TS sidecar allowed, or vice versa).
Set both deliberately.

The TS loader **refuses to include any path that would expose
`~/.feral/`** (and a few other self-protection walls). See
`FeralAgent/src/workspace-roots.ts` for the canonical list of dropped
roots.

## 3. Var reference — by domain

### 3.1 Inference / model selection

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_MODEL` | string | `qwen2.5:7b` | Model id sent to the inference provider. |
| `FERAL_PROVIDER` | enum | `openai_compatible` | Provider family: `openai_compatible`, `ollama`, `anthropic`, … Maps to adapters in `inference-providers.ts`. |
| `FERAL_BASE_URL` | URL | `http://127.0.0.1:11435` | Inference base URL the sidecar points at. |
| `FERAL_API_KEY` | string | — | Bearer token. Loopback reuses the local API token; non-loopback must set this. |
| `FERAL_BYOK_PROVIDER` | provider id | unset | When set, the wizard saves the active selection under this id and the inference router pre-loads it. |
| `FERAL_FALLBACK_PROVIDER` | enum | `ollama` | Provider to fall back to if the primary is unreachable. |
| `FERAL_FALLBACK_MODEL` | model id | unset | Model to fall back to. |
| `FERAL_FALLBACK_BASE_URL` | URL | `http://localhost:11434` | Base URL for the fallback. |
| `FERAL_FALLBACK_API_KEY` | string | — | Bearer token for the fallback. |
| `FERAL_OLLAMA_NUM_CTX` | int | unset (model card wins) | Override Ollama's `num_ctx`. |
| `FERAL_MAX_CONTEXT` | int | `8192` | Hard ceiling on context length the router allows. |
| `FERAL_MAX_LOCAL_CONTEXTS` | int | GPU-dependent (see comment) | Parallel decode contexts on the same GPU; user override always wins over auto-detected cap. |
| `FERAL_MODEL_WAIT_MS` | ms | unset | Wall-clock max wait for a model to become ready after a load request. |
| `FERAL_VERSION` | string | unset | Reported in startup logs; set by installer. |
| `FERAL_TOOL_GRAMMAR` | json | unset | Optional GBNF grammar to constrain tool-call output. |

### 3.2 Embed / GPU

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_EMBED_GPU_LAYERS` | int | auto-detect on Vulkan/AMD | How many embedding-model layers to offload to GPU. Set to `0` for CPU-only (canonical fix for RX 580 / Polaris bge-small Vulkan crash). |
| `FERAL_EMBED_MODEL` | path | bundled | Path to the embed GGUF; auto-discovered. |
| `FERAL_EMBED_CHUNK` | int | unset | Embedder input chunk size. |

### 3.3 Routing / trust

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_TRUSTED_BASE_URLS` | comma-list | empty | Extra base URLs the inference router may call. See §1. |
| `FERAL_HTTP_DOMAINS` | comma-list | empty | Allowlist for `http_request`. See §1. |
| `FERAL_FETCH_DOMAINS` | comma-list | empty | Allowlist for `fetch_url`. See §1. |

### 3.4 Budgets

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_BUDGET_CONVERSATION` | int / `Infinity` | 5_000_000 | Per-conversation token ceiling. `Infinity` for unlimited. |
| `FERAL_BUDGET_DAY` | int | 50_000_000 | Per-day ceiling. |
| `FERAL_BUDGET_POLICY` | enum | `compress_and_continue` | `stop` (hard-stop) or `compress_and_continue` (summarize + keep going). |
| `FERAL_RSI_MAX_COST_USD` | float / unset | unset (= local-only) | RSI background USD cap. `0.0` is treated the same as unset. |
| `FERAL_CLOUD_TRANSCRIPT_BUDGET` | int | `AgentLoop.CLOUD_TRANSCRIPT_BUDGET` | Cloud-specific transcript-size budget. |

### 3.5 Performance

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_TTFT_DEADLINE_MS` | ms (positive int) | 90_000 local, 30_000 cloud | Time-to-first-token cap. Positive integer only. |
| `FERAL_TOTAL_DEADLINE_MS` | ms (positive int) | 300_000 local, 120_000 cloud | Whole-completion cap. |
| `FERAL_STALL_MS` | ms (positive int) | 45_000 local, 30_000 cloud | Inter-token stall cap. |
| `FERAL_CLOUD_IDLE_TIMEOUT_MS` | ms (positive int) | unset | Legacy back-compat stall knob, cloud only. `FERAL_STALL_MS` wins when both set. |

### 3.6 Memory (FMS)

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_FMS_MAX_LEAVES` | int | unset | Cap on the FMS leaf store size. |
| `FERAL_FMS_DEDUP_SPAN_MS` | ms | 30 days | Coalesce leaves whose last touch is within this window. |
| `FERAL_FMS_MERGE_THRESHOLD` | float | `0.92` | Cosine threshold above which leaves merge. |
| `FERAL_FMS_EVICTION` | enum | unset | Eviction strategy (e.g. `lru`). |
| `FERAL_MERGE_THRESHOLD` | float | inherits `FERAL_FMS_MERGE_THRESHOLD` | Older name, retained for back-compat. |
| `FERAL_TREE_BRANCH` | int | unset | Branching factor for fractal tree build. |
| `FERAL_TREE_CLUSTER_MAX_CHARS` | int | unset | Max cluster size in chars. |
| `FERAL_TREE_ITEM_MAX_CHARS` | int | unset | Max item size in chars. |
| `FERAL_PII_REDACTION` | `on` \| `off` | `on` | Master switch for PII redaction in memory writes. |
| `FERAL_JINA_API_KEY` | string | unset | Jina Reader key for `read_webpage` / `deep_research`. Treat as a paid service secret. |

### 3.7 RSI / dream cycle / governance

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_RSI_PASSIVE` | bool | unset (auto) | RSI supervisor passive mode. `false` disables. |
| `FERAL_RSI_ALLOW_CLOUD` | bool | unset (= deny) | Opt-in: allow RSI to call cloud providers (otherwise local-only; cost guard). |
| `FERAL_RSI_MAX_ITER` | int | 100_000 (per lang) / 40 (per iter) | Iteration cap before RSI bails. |
| `FERAL_RSI_MAX_TOKENS` | int | unset | Per-call token cap for RSI evaluations. |
| `FERAL_RSI_EVAL_TOKEN_BUDGET` | int | unset | Per-eval token budget in `rsi/sidecar.ts`. |
| `FERAL_RSI_CONCURRENCY` | int | 1 | Concurrent RSI evaluations. |
| `FERAL_RSI_COOLDOWN_MS` | ms | 600_000 | Quiet period after a successful iteration. |
| `FERAL_RSI_IDLE_MS` | ms | 180_000 | Quiet period before RSI wakes up. |
| `FERAL_RSI_POLL_MS` | ms | unset | Manual poll cadence override. |
| `FERAL_RSI_ERROR_THRESHOLD` | int | 3 | Consecutive error count that triggers a sleep. |
| `FERAL_RSI_ERROR_WINDOW_MS` | ms | 900_000 | Sliding window for the error counter. |
| `FERAL_RSI_EPISODE_MS` | ms | unset | Max wall-clock per episode. |
| `FERAL_RSI_PLATEAU_ITERS` | int | unset | Iters-with-no-improvement before RSI bails. |
| `FERAL_RSI_SCHEDULE_MS` | ms | unset | Force a fixed schedule (e.g. weekly wake). |
| `FERAL_RSI_STAGNATION_THRESHOLD` | int | unset | Hard stagnation threshold. |
| `FERAL_RSI_STOP_ON_ACTIVITY` | bool | unset | Pause RSI when the user is active. |
| `FERAL_RSI_TELEMETRY` | bool | unset | Emit per-iteration telemetry events. |
| `FERAL_CODE_RSI_REPO` | path | unset | Real source repo for code RSI to revert against; without it, live-apply is unavailable. |

### 3.8 L4 modules

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_MODULE_SEED` | int | `1` | Deterministic seed for module selection. |

### 3.9 Cron / proactive / inner thoughts

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_CRON_TICK_MS` | ms | unset | Tick interval for the cron scheduler. |
| `FERAL_CRON_JOB_TIMEOUT_MS` | ms | 300_000 | Max wall-clock for a single cron job. |
| `FERAL_HEARTBEAT_INTERVAL_MS` | ms | 30_000 | Watchdog / liveness heartbeat cadence. |
| `FERAL_PROACTIVE_ENABLED` | bool | unset | Master enable for the proactive loop (mood engine). |
| `FERAL_INNER_THOUGHTS_ENABLED` | bool | unset | Sub-flag enabling the inner-thoughts loop. |
| `FERAL_THOUGHTS_COOLDOWN_MS` | ms | 14_400_000 (4h) | Quiet period between thoughts. |
| `FERAL_THOUGHTS_MIN_IDLE_MS` | ms | 600_000 (10m) | User must be idle this long before a thought fires. |
| `FERAL_THOUGHTS_INTERVAL_MS` | ms | 120_000 (2m) | Wake-and-evaluate cadence. |
| `FERAL_THOUGHTS_DAILY_CAP` | int | `3` | Hard cap on thoughts per user-day. |
| `FERAL_THOUGHTS_MOOD_THRESHOLD` | float | `0.5` | Mood gate; thoughts fire only above this score. |

### 3.10 Connectors / shell / desktop

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_DISCORD_CLIENT_ID` | string | unset | Discord OAuth client id for the connector wizard. |

(The rest — `FERAL_ENABLE_SHELL_EXEC`, `FERAL_ENABLE_CODE_EXEC`,
`FERAL_ENABLE_DESKTOP_CONTROL`, `FERAL_DESKTOP_CONTROL_*`,
`FERAL_SHELL_WHITELIST` — are documented in §1.)

### 3.11 Workspace / paths / state

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_HOME` | path | platform default (`~/.feral/`) | Override the agent's profile dir. **Do not set to `~/.feral/`** or you'll get a self-trap. |
| `FERAL_AGENT_WORKSPACE` | absolute path | unset | Rust-side FS access root (see §2). |
| `FERAL_WORKSPACE` | comma-list | per `workspace-roots.ts` | TS-side FS roots (see §2). |
| `FERAL_DB` | path | `<FERAL_HOME>/data/feral.db` | Override the SQLite DB path. |
| `FERAL_DB_KEY` | 32-byte key | unset | At-rest encryption key for the DB. See §1. |
| `FERAL_AGENT_BASE_PROMPT` | prompt text | bundled | The universal operating manual injected into every model call; usually bundled, can be overridden for tests. |

### 3.12 Subagents

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_SUBAGENT_MAX_SUMMARY_CHARS` | int | `4000` (negative = unlimited) | Cap on subagent summary length returned to parent. |

### 3.13 LoRA trainer

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_LORA_TRAINER_BIN` | path | unset | Absolute path to the trainer binary. |
| `FERAL_LORA_TRAIN_TIMEOUT_MS` | ms | unset | Wall-clock cap on a single trainer invocation. |

### 3.14 Build / dev / smoke

| Var | Type | Default | Description |
|---|---|---|---|
| `FERAL_FORCE_SIDECAR_BUILD` | `1` | unset | Force a `bun run build` even when `dist/` is fresh. Read by `build-sidecar.mjs`. |
| `FERAL_SKIP_SIDECAR_BUILD` | `1` | unset | Skip the sidecar build entirely (CI cache step). |
| `FERAL_BRAIN` | `1` | unset | Expect a brain config at boot. |
| `FERAL_SMOKE_GGUF` | path | unset | GGUF path for `load_smoke_real_gguf`; gates the smoke. |
| `FERAL_RUN_FRACTAL_BENCH` | `1` | unset | Run the fractal benchmark as part of boot. |
| `FERAL_FRACTAL_BENCH_COUNT` | int | `50` | Benchmark corpus size. |
| `FERAL_FRACTAL_BENCH_SEED` | int | `1` | Benchmark RNG seed. |
| `FERAL_FRACTAL_BENCH_QUERIES` | path | unset | Override the benchmark query set. |
| `FERAL_FRACTAL_BENCH_MAX_LEAVES` | int | `0` (= unlimited) | Cap the benchmark's leaf-store size. |
| `FERAL_FMS_BENCH` | `1` | unset | Enable the FMS scale benchmarks (skipped by default in `bun test`). |
| `FERAL_E2E` | `1` | unset | Enable e2e smoke tests (B5 gate). |
| `FERAL_NO_COLOR` | bool | unset | Disable ANSI colour output. |

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
FERAL_EMBED_GPU_LAYERS
FERAL_EMBED_MODEL
FERAL_ENABLE_CODE_EXEC
FERAL_ENABLE_DESKTOP_CONTROL
FERAL_ENABLE_SHELL_EXEC
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
FERAL_FRACTAL_BENCH_COUNT
FERAL_FRACTAL_BENCH_MAX_LEAVES
FERAL_FRACTAL_BENCH_QUERIES
FERAL_FRACTAL_BENCH_SEED
FERAL_HEARTBEAT_INTERVAL_MS
FERAL_HOME
FERAL_HTTP_DOMAINS
FERAL_INNER_THOUGHTS_ENABLED
FERAL_JINA_API_KEY
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
FERAL_SHELL_WHITELIST
FERAL_SMOKE_GGUF
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
FERAL_TRUSTED_BASE_URLS
FERAL_TTFT_DEADLINE_MS
FERAL_VERSION
FERAL_WORKSPACE
```
