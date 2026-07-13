// FeralAgent/src/config.ts
// Single source of truth for FERAL_* environment configuration read by the
// TypeScript sidecar (FeralAgent/src/). Rust-side vars (crates/feral-core,
// src-tauri) are documented separately in docs/CONFIGURATION.md §1/§2 and
// are NOT part of this schema.
//
// R3: replaces ad-hoc process.env.FERAL_* reads. New vars: add a schema
// row here, do not read process.env directly elsewhere (tests/config.test.ts
// enforces this for new *literal* `process.env.FERAL_X` reads; call sites
// that take an injected `env: NodeJS.ProcessEnv` parameter for testability
// — e.g. loadWorkspaceRoots, loadBrainConfig, shouldAutostartPassive,
// perf-policy's readEnvNumber — are unaffected by this schema and keep
// reading their injected `env` directly; that pattern predates R3 and
// migrating it would break test env-injection).
//
// docs/CONFIGURATION.md's TS-var table is generated FROM this file by
// scripts/gen-config-docs.mjs — do not hand-edit the table between the
// <!-- TS-SCHEMA-TABLE --> markers.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ConfigEntry {
  name: string;
  type: "bool" | "int" | "path" | "list" | "string";
  default: string | number | boolean | null;
  description: string;
  security: boolean;
}

export const CONFIG_SCHEMA: ConfigEntry[] = [
  // ---- Security group (read this first) ----------------------------------
  { name: "FERAL_DB_KEY", type: "string", default: null,
    description: "32-byte base64 key for at-rest encryption of sensitive DB columns. Anyone who can read this can read the DB.", security: true },
  { name: "FERAL_WORKSPACE", type: "list", default: null,
    description: "TS sidecar path-list of FS roots. Unset = launch cwd + the user's home dir (broad by default; set to RESTRICT). The call-time deny wall (tool-permissions.ts) protects ~/.feral, ~/.ssh and FERAL_FS_DENY regardless of roots.", security: true },
  { name: "FERAL_FS_DENY", type: "list", default: null,
    description: "Extra comma/semicolon-separated paths the fs tools may never touch, on top of the built-in ~/.feral + ~/.ssh deny wall.", security: true },
  { name: "FERAL_ENABLE_SHELL_EXEC", type: "bool", default: true,
    description: "Registers shell_exec (argv-only, whitelisted). On by default; set to \"false\" to disable. Doc note: an earlier draft of this doc said default off — the code's actual default is ON.", security: true },
  { name: "FERAL_ENABLE_DESKTOP_CONTROL", type: "bool", default: false,
    description: "Registers control_app (OS accessibility-tree control). Off by default; set to \"true\" to enable.", security: true },
  { name: "FERAL_DESKTOP_CONTROL_CONFIRM", type: "bool", default: true,
    description: "Per-action confirmation dialog for control_app writes. On by default; set to \"false\" to disable (inverse-toggle var — see report for why this call site is not migrated to cfgBool).", security: true },
  { name: "FERAL_DESKTOP_CONTROL_NO_PROMPT_OK", type: "bool", default: false,
    description: "Sidecar-internal escape hatch: when true, a transport with no askUser bridge may proceed without confirmation instead of failing closed.", security: true },
  { name: "FERAL_DESKTOP_CONTROL_ALLOWED_APPS", type: "list", default: null,
    description: "Comma-separated allowlist of app names control_app may target. Empty = fail closed. (Read by the Rust host, not FeralAgent/src.)", security: true },
  { name: "FERAL_FETCH_DOMAINS", type: "list", default: null,
    description: "Comma-separated domain allowlist for fetch_url. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT.", security: true },
  { name: "FERAL_HTTP_DOMAINS", type: "list", default: null,
    description: "Comma-separated domain allowlist for http_request. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT.", security: true },
  { name: "FERAL_TRUSTED_BASE_URLS", type: "list", default: null,
    description: "Extra base URLs the inference router may call beyond loopback.", security: true },
  { name: "FERAL_SHELL_WHITELIST", type: "list", default: null,
    description: "Extends the spawn whitelist for shell_exec.", security: true },
  { name: "FERAL_PROACTIVE_ENABLED", type: "bool", default: false,
    description: "Master enable for the proactive/mood-engine loop.", security: true },
  { name: "FERAL_INNER_THOUGHTS_ENABLED", type: "bool", default: false,
    description: "Sub-flag enabling the inner-thoughts loop.", security: true },

  // ---- Inference / model selection ----------------------------------------
  { name: "FERAL_MODEL", type: "string", default: "qwen2.5:7b",
    description: "Model id sent to the inference provider.", security: false },
  { name: "FERAL_PROVIDER", type: "string", default: "openai_compatible",
    description: "Provider family adapter to use.", security: false },
  { name: "FERAL_BASE_URL", type: "string", default: "http://127.0.0.1:11435",
    description: "Inference base URL the sidecar points at.", security: false },
  { name: "FERAL_API_KEY", type: "string", default: null,
    description: "Bearer token for the primary provider.", security: false },
  { name: "FERAL_BYOK_PROVIDER", type: "string", default: null,
    description: "Wizard-saved BYOK provider id; RSI's live-router model id falls back to this.", security: false },
  { name: "FERAL_LOCAL_BASE_URL", type: "string", default: null,
    description: "Loopback address of the bundled local engine, set by the host. Used ONLY as the degrade-to-local fallback when the primary is a cloud provider; ignored when not loopback.", security: false },
  { name: "FERAL_LOCAL_MODEL", type: "string", default: null,
    description: "Model id the bundled local engine serves (fallback target companion to FERAL_LOCAL_BASE_URL).", security: false },
  { name: "FERAL_LOCAL_API_KEY", type: "string", default: null,
    description: "Bearer token for the loopback local engine (the host's local API token).", security: true },
  { name: "FERAL_RATE_LIMIT_RPM", type: "int", default: 0,
    description: "Requests-per-minute cap applied to every inference endpoint, overriding the built-in published caps (NVIDIA NIM free tier = 40). 0 uses those defaults. Set this if you are on a paid tier with a different limit, or share one API key with something outside Feral.", security: false },
  { name: "FERAL_FALLBACK_PROVIDER", type: "string", default: "ollama",
    description: "Provider to fall back to if the primary is unreachable.", security: false },
  { name: "FERAL_FALLBACK_MODEL", type: "string", default: null,
    description: "Model to fall back to.", security: false },
  { name: "FERAL_FALLBACK_BASE_URL", type: "string", default: "http://localhost:11434",
    description: "Base URL for the fallback provider.", security: false },
  { name: "FERAL_FALLBACK_API_KEY", type: "string", default: null,
    description: "Bearer token for the fallback provider.", security: false },
  { name: "FERAL_OLLAMA_NUM_CTX", type: "int", default: null,
    description: "Override Ollama's num_ctx.", security: false },
  { name: "FERAL_MAX_CONTEXT", type: "int", default: 8192,
    description: "Hard ceiling on context length the router allows.", security: false },
  { name: "FERAL_TOOL_GRAMMAR", type: "string", default: null,
    description: "Optional GBNF grammar to constrain tool-call output. Presence alone also toggles useToolGrammar (default on; set to literal \"false\" to disable — inverse-toggle var, not migrated).", security: false },
  { name: "FERAL_VERSION", type: "string", default: null,
    description: "Reported in startup logs; set by installer.", security: false },

  // ---- Embed / GPU ----------------------------------------------------------
  { name: "FERAL_EMBED_GPU_LAYERS", type: "int", default: null,
    description: "Embedding-model layers offloaded to GPU. 0 = CPU-only.", security: false },
  { name: "FERAL_EMBED_MODEL", type: "path", default: null,
    description: "Path to the embed GGUF; auto-discovered when unset.", security: false },
  { name: "FERAL_EMBED_CHUNK", type: "int", default: null,
    description: "Embedder input chunk size (tree-builder.ts).", security: false },

  // ---- Budgets ---------------------------------------------------------------
  { name: "FERAL_BUDGET_CONVERSATION", type: "int", default: 5_000_000,
    description: "Per-conversation token ceiling.", security: false },
  { name: "FERAL_BUDGET_DAY", type: "int", default: 50_000_000,
    description: "Per-day token ceiling.", security: false },
  { name: "FERAL_BUDGET_POLICY", type: "string", default: "compress_and_continue",
    description: "\"stop\" or \"compress_and_continue\".", security: false },
  { name: "FERAL_RSI_MAX_COST_USD", type: "string", default: null,
    description: "RSI background USD cap (float). Unset = local-only.", security: false },
  { name: "FERAL_CLOUD_TRANSCRIPT_BUDGET", type: "int", default: 200_000,
    description: "Cloud-specific transcript-size budget (AgentLoop.CLOUD_TRANSCRIPT_BUDGET fallback).", security: false },

  // ---- Performance -------------------------------------------------------------
  { name: "FERAL_TTFT_DEADLINE_MS", type: "int", default: null,
    description: "Time-to-first-token cap (perf-policy.ts, positive int only).", security: false },
  { name: "FERAL_TOTAL_DEADLINE_MS", type: "int", default: null,
    description: "Whole-completion cap.", security: false },
  { name: "FERAL_STALL_MS", type: "int", default: null,
    description: "Inter-token stall cap; wins over FERAL_CLOUD_IDLE_TIMEOUT_MS when both set.", security: false },
  { name: "FERAL_CLOUD_IDLE_TIMEOUT_MS", type: "int", default: 60_000,
    description: "Legacy cloud-only idle-stream timeout back-compat knob.", security: false },

  // ---- Memory (FMS) ------------------------------------------------------------
  { name: "FERAL_FMS_MAX_LEAVES", type: "int", default: null,
    description: "Cap on the FMS leaf store size.", security: false },
  { name: "FERAL_FMS_DEDUP_SPAN_MS", type: "int", default: 30 * 24 * 60 * 60 * 1000,
    description: "Coalesce leaves whose last touch is within this window.", security: false },
  { name: "FERAL_FMS_MERGE_THRESHOLD", type: "string", default: "0.92",
    description: "Cosine threshold (float) above which leaves merge.", security: false },
  { name: "FERAL_FMS_EVICTION", type: "string", default: null,
    description: "Eviction strategy (e.g. lru).", security: false },
  { name: "FERAL_MERGE_THRESHOLD", type: "string", default: null,
    description: "Older name for FERAL_FMS_MERGE_THRESHOLD, read directly (no inheritance in code).", security: false },
  { name: "FERAL_TREE_BRANCH", type: "int", default: null,
    description: "Branching factor for fractal tree build.", security: false },
  { name: "FERAL_TREE_CLUSTER_MAX_CHARS", type: "int", default: null,
    description: "Max cluster size in chars.", security: false },
  { name: "FERAL_TREE_ITEM_MAX_CHARS", type: "int", default: null,
    description: "Max item size in chars.", security: false },
  { name: "FERAL_PII_REDACTION", type: "string", default: "on",
    description: "Master switch for PII redaction in memory writes; \"off\" disables (inverse-toggle var).", security: false },
  { name: "FERAL_JINA_API_KEY", type: "string", default: null,
    description: "Jina Reader key for read_webpage / deep_research.", security: false },

  // ---- RSI / dream cycle / governance -------------------------------------------
  { name: "FERAL_RSI_PASSIVE", type: "bool", default: true,
    description: "RSI supervisor passive mode. \"false\" disables (read via injected env in passive-supervisor.ts).", security: false },
  { name: "FERAL_RSI_ALLOW_CLOUD", type: "bool", default: false,
    description: "Opt-in: allow RSI to call cloud providers (anti-burn guard).", security: false },
  { name: "FERAL_RSI_MAX_ITER", type: "int", default: null,
    description: "Pin the episode iteration cap; unset = dynamic (genome/policy-derived).", security: false },
  { name: "FERAL_RSI_MAX_TOKENS", type: "int", default: null,
    description: "Per-call token cap for RSI evaluations.", security: false },
  { name: "FERAL_RSI_EVAL_TOKEN_BUDGET", type: "int", default: null,
    description: "Per-eval token budget in rsi/sidecar.ts.", security: false },
  { name: "FERAL_RSI_CONCURRENCY", type: "int", default: 1,
    description: "Concurrent RSI evaluations.", security: false },
  { name: "FERAL_RSI_COOLDOWN_MS", type: "int", default: 600_000,
    description: "Quiet period after a successful iteration.", security: false },
  { name: "FERAL_RSI_IDLE_MS", type: "int", default: 180_000,
    description: "Quiet period before RSI wakes up.", security: false },
  { name: "FERAL_RSI_POLL_MS", type: "int", default: null,
    description: "Manual poll cadence override.", security: false },
  { name: "FERAL_RSI_ERROR_THRESHOLD", type: "int", default: 3,
    description: "Consecutive error count that triggers a sleep.", security: false },
  { name: "FERAL_RSI_ERROR_WINDOW_MS", type: "int", default: 900_000,
    description: "Sliding window for the error counter.", security: false },
  { name: "FERAL_RSI_EPISODE_MS", type: "int", default: null,
    description: "Max wall-clock per episode.", security: false },
  { name: "FERAL_RSI_PLATEAU_ITERS", type: "int", default: null,
    description: "Iters-with-no-improvement before RSI bails.", security: false },
  { name: "FERAL_RSI_SCHEDULE_MS", type: "int", default: null,
    description: "Force a fixed schedule (e.g. weekly wake).", security: false },
  { name: "FERAL_RSI_STAGNATION_THRESHOLD", type: "int", default: null,
    description: "Hard stagnation threshold.", security: false },
  { name: "FERAL_RSI_STOP_ON_ACTIVITY", type: "bool", default: false,
    description: "Pause RSI when the user is active.", security: false },
  { name: "FERAL_RSI_TELEMETRY", type: "path", default: null,
    description: "Telemetry JSONL file path override (default ~/.feral/rsi/dream.jsonl). Type is a path, not a bool — the existing doc mislabeled it as a bool switch.", security: false },
  { name: "FERAL_CODE_RSI_REPO", type: "path", default: null,
    description: "Source repo for code-RSI to propose/apply against; without it, code-RSI rounds and live-apply are unavailable.", security: false },

  // ---- L4 modules ----------------------------------------------------------------
  { name: "FERAL_MODULE_SEED", type: "int", default: 1,
    description: "Deterministic seed for module selection (module-host.ts).", security: false },

  // ---- Cron / proactive / inner thoughts ------------------------------------------
  { name: "FERAL_CRON_TICK_MS", type: "int", default: 30_000,
    description: "Tick interval for the cron scheduler.", security: false },
  { name: "FERAL_CRON_JOB_TIMEOUT_MS", type: "int", default: 300_000,
    description: "Max wall-clock for a single cron job.", security: false },
  { name: "FERAL_HEARTBEAT_INTERVAL_MS", type: "int", default: 30_000,
    description: "Watchdog / liveness heartbeat cadence.", security: false },
  { name: "FERAL_THOUGHTS_COOLDOWN_MS", type: "int", default: 14_400_000,
    description: "Quiet period between thoughts (4h).", security: false },
  { name: "FERAL_THOUGHTS_MIN_IDLE_MS", type: "int", default: 600_000,
    description: "User must be idle this long before a thought fires (10m).", security: false },
  { name: "FERAL_THOUGHTS_INTERVAL_MS", type: "int", default: 120_000,
    description: "Wake-and-evaluate cadence (2m).", security: false },
  { name: "FERAL_THOUGHTS_DAILY_CAP", type: "int", default: 3,
    description: "Hard cap on thoughts per user-day.", security: false },
  { name: "FERAL_THOUGHTS_MOOD_THRESHOLD", type: "string", default: "0.5",
    description: "Mood gate (float); thoughts fire only above this score.", security: false },

  // ---- Connectors -------------------------------------------------------------------
  // (no FERAL_DISCORD_CLIENT_ID read in FeralAgent/src today — Rust/UI side.)

  // ---- Brain Stack ------------------------------------------------------------------
  { name: "FERAL_BRAIN", type: "bool", default: false,
    description: "Force-enable Brain Stack; if brain.json is missing, loadBrainConfig throws (read via injected env in brain-config.ts).", security: false },

  // ---- Workspace / paths / state -----------------------------------------------------
  { name: "FERAL_HOME", type: "path", default: null,
    description: "Override the agent's profile dir (default ~/.feral/, resolved via homedir() when unset).", security: false },
  { name: "FERAL_DB", type: "path", default: "data/feral.db",
    description: "Override the SQLite DB path. \":memory:\" is a sentinel and is not path-resolved.", security: false },
  { name: "FERAL_AGENT_BASE_PROMPT", type: "string", default: null,
    description: "Universal operating manual injected into every model call; usually bundled.", security: false },

  // ---- Subagents ---------------------------------------------------------------------
  { name: "FERAL_SUBAGENT_MAX_SUMMARY_CHARS", type: "int", default: 4000,
    description: "Cap on subagent summary length returned to parent (negative = unlimited).", security: false },

  // ---- LoRA trainer --------------------------------------------------------------------
  { name: "FERAL_LORA_TRAINER_BIN", type: "path", default: null,
    description: "Absolute path to the trainer binary.", security: false },
  { name: "FERAL_LORA_TRAIN_TIMEOUT_MS", type: "int", default: null,
    description: "Wall-clock cap on a single trainer invocation.", security: false },

  // ---- Build / dev / smoke --------------------------------------------------------------
  { name: "FERAL_RUN_FRACTAL_BENCH", type: "bool", default: false,
    description: "Run the fractal benchmark as part of boot.", security: false },
  { name: "FERAL_FRACTAL_BENCH_COUNT", type: "int", default: 50,
    description: "Benchmark corpus size.", security: false },
  { name: "FERAL_FRACTAL_BENCH_SEED", type: "int", default: 1,
    description: "Benchmark RNG seed.", security: false },
  { name: "FERAL_FRACTAL_BENCH_QUERIES", type: "path", default: null,
    description: "Override the benchmark query set.", security: false },
  { name: "FERAL_FRACTAL_BENCH_MAX_LEAVES", type: "int", default: 0,
    description: "Cap the benchmark/dev fractal-memory leaf-store size (0 = unlimited / full corpus).", security: false },
  { name: "FERAL_NO_COLOR", type: "bool", default: false,
    description: "Disable ANSI colour output in the TUI.", security: false },
];

function findEntry(name: string): ConfigEntry {
  const e = CONFIG_SCHEMA.find((c) => c.name === name);
  if (!e) throw new Error(`config.ts: ${name} not in CONFIG_SCHEMA — add a schema row first`);
  return e;
}

export function cfgBool(name: string): boolean {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default as boolean;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function cfgInt(name: string): number {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default as number;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? (entry.default as number) : n;
}

export function cfgPath(name: string): string | null {
  const entry = findEntry(name);
  return process.env[name] ?? (entry.default as string | null);
}

export function cfgList(name: string): string[] {
  const entry = findEntry(name);
  const raw = process.env[name];
  if (raw === undefined) return entry.default ? [entry.default as string] : [];
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The agent's profile dir. FERAL_HOME was documented in the schema above but
 * never honored — three call sites (boot, connectors, self_describe) resolved
 * `~/.feral` from homedir() directly, so an isolated profile still read the
 * real one's connectors and secrets. Single resolver; import it instead of
 * re-deriving the path.
 */
export function feralHome(): string {
  return resolve(cfgPath("FERAL_HOME") ?? join(homedir(), ".feral"));
}
