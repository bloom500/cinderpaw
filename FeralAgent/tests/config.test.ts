import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA } from "../src/config.ts";

const SRC = join(import.meta.dir, "..", "src");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "config.ts") continue; // the schema itself may reference names as strings
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Grandfathered: vars read directly via process.env.FERAL_* outside
// config.ts as of R3. Shrink this list opportunistically; do NOT add to it.
//
// Every name below falls into one of two buckets:
//   1. Not migrated in this pass (grandfathered for real).
//   2. A literal `process.env.FERAL_X` read whose semantics don't fit the
//      cfgBool/cfgInt/cfgPath/cfgList contract without changing behavior
//      (inverse-toggle booleans, dynamic non-literal defaults resolved via
//      `?? fallbackExpr()`, or a genuine cross-call-site default conflict) —
//      see task-3-report.md for the reasoning on each.
const GRANDFATHERED = new Set<string>([
  // Inverse-toggle booleans (default ON, "false"/"off" disables) — cfgBool's
  // "1"/"true" = on convention would silently flip on any other non-empty
  // value (e.g. "0", "no"). Left as-is rather than risk a security regression.
  "FERAL_ENABLE_SHELL_EXEC",
  "FERAL_DESKTOP_CONTROL_CONFIRM",
  "FERAL_PII_REDACTION",
  "FERAL_TOOL_GRAMMAR",
  // Same var, conflicting effective default across call sites — see report.
  // rsi/sidecar.ts:551 intentionally keeps its own "" fallback for pricing
  // lookup; the other FERAL_MODEL call sites were migrated to cfgPath.
  "FERAL_MODEL",
  // Not migrated: general env harvest / non-security, non-top-10.
  "FERAL_AGENT_BASE_PROMPT",
  "FERAL_API_KEY",
  "FERAL_BUDGET_CONVERSATION",
  "FERAL_BUDGET_DAY",
  "FERAL_BUDGET_POLICY",
  "FERAL_BYOK_PROVIDER",
  "FERAL_CLOUD_TRANSCRIPT_BUDGET",
  "FERAL_CRON_JOB_TIMEOUT_MS",
  "FERAL_CRON_TICK_MS",
  "FERAL_DB",
  "FERAL_DESKTOP_CONTROL_ALLOWED_APPS",
  "FERAL_EMBED_CHUNK",
  "FERAL_EMBED_GPU_LAYERS",
  "FERAL_FALLBACK_API_KEY",
  "FERAL_FALLBACK_BASE_URL",
  "FERAL_FALLBACK_MODEL",
  "FERAL_FALLBACK_PROVIDER",
  "FERAL_FETCH_DOMAINS",
  "FERAL_FMS_DEDUP_SPAN_MS",
  "FERAL_FMS_EVICTION",
  "FERAL_FMS_MERGE_THRESHOLD",
  "FERAL_FRACTAL_BENCH_COUNT",
  "FERAL_FRACTAL_BENCH_QUERIES",
  "FERAL_FRACTAL_BENCH_SEED",
  "FERAL_HEARTBEAT_INTERVAL_MS",
  "FERAL_HTTP_DOMAINS",
  "FERAL_JINA_API_KEY",
  "FERAL_LORA_TRAINER_BIN",
  "FERAL_LORA_TRAIN_TIMEOUT_MS",
  "FERAL_MERGE_THRESHOLD",
  "FERAL_MODULE_SEED",
  "FERAL_NO_COLOR",
  "FERAL_OLLAMA_NUM_CTX",
  "FERAL_RSI_EVAL_TOKEN_BUDGET",
  "FERAL_RSI_MAX_ITER",
  "FERAL_RSI_STAGNATION_THRESHOLD",
  "FERAL_RSI_TELEMETRY",
  "FERAL_RUN_FRACTAL_BENCH",
  "FERAL_SHELL_DENYLIST",
  "FERAL_SHELL_WHITELIST",
  "FERAL_SUBAGENT_MAX_SUMMARY_CHARS",
  "FERAL_THOUGHTS_COOLDOWN_MS",
  "FERAL_THOUGHTS_DAILY_CAP",
  "FERAL_THOUGHTS_INTERVAL_MS",
  "FERAL_THOUGHTS_MIN_IDLE_MS",
  "FERAL_THOUGHTS_MOOD_THRESHOLD",
  "FERAL_TRUSTED_BASE_URLS",
  // tree-builder.ts's readers clamp out-of-range values to a floor
  // (n >= 2 / n >= 100 / n >= 500) before falling back to their default;
  // cfgInt has no clamp hook, so a mechanical swap would silently accept
  // e.g. FERAL_TREE_BRANCH=1 instead of falling back to 8.
  "FERAL_TREE_BRANCH",
  "FERAL_TREE_ITEM_MAX_CHARS",
  "FERAL_TREE_CLUSTER_MAX_CHARS",
]);

describe("config.ts", () => {
  test("no new process.env.FERAL_ reads outside config.ts and the grandfathered list", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const matches = text.matchAll(/process\.env\.(FERAL_[A-Z_]*)/g);
      for (const m of matches) {
        if (!GRANDFATHERED.has(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every schema entry has a getter-compatible type", () => {
    for (const entry of CONFIG_SCHEMA) {
      expect(["bool", "int", "path", "list", "string"]).toContain(entry.type);
    }
  });
});
