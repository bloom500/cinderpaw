import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_SCHEMA } from "../src/config.ts";

const SRC = join(import.meta.dir, "..", "src");

// Every directory is listed concurrently and every file read concurrently.
// This guard reads all 284 source files, which is 57ms of I/O on a warm disk
// and seconds of waiting on a busy one - and it runs at the tail of a 3700-test
// suite, where the disk is never idle. Sequential I/O waits are the whole cost:
// overlapping them is what keeps this under the 5s test budget instead of
// asking for a bigger budget.
async function walkTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === "config.ts") return []; // the schema itself may reference names as strings
      const p = join(dir, entry.name);
      if (entry.isDirectory()) return walkTsFiles(p);
      return entry.name.endsWith(".ts") ? [p] : [];
    }),
  );
  return nested.flat();
}

// Grandfathered: vars read directly via process.env.CINDERPAW_* outside
// config.ts as of R3. Shrink this list opportunistically; do NOT add to it.
//
// Every name below falls into one of two buckets:
//   1. Not migrated in this pass (grandfathered for real).
//   2. A literal `process.env.CINDERPAW_X` read whose semantics don't fit the
//      cfgBool/cfgInt/cfgPath/cfgList contract without changing behavior
//      (inverse-toggle booleans, dynamic non-literal defaults resolved via
//      `?? fallbackExpr()`, or a genuine cross-call-site default conflict) —
//      see task-3-report.md for the reasoning on each.
const GRANDFATHERED = new Set<string>([
  // Inverse-toggle booleans (default ON, "false"/"off" disables) — cfgBool's
  // "1"/"true" = on convention would silently flip on any other non-empty
  // value (e.g. "0", "no"). Left as-is rather than risk a security regression.
  "CINDERPAW_ENABLE_SHELL_EXEC",
  "CINDERPAW_DESKTOP_CONTROL_CONFIRM",
  "CINDERPAW_PII_REDACTION",
  "CINDERPAW_TOOL_GRAMMAR",
  // Same var, conflicting effective default across call sites — see report.
  // rsi/sidecar.ts:551 intentionally keeps its own "" fallback for pricing
  // lookup; the other CINDERPAW_MODEL call sites were migrated to cfgPath.
  "CINDERPAW_MODEL",
  // Not migrated: general env harvest / non-security, non-top-10.
  "CINDERPAW_AGENT_BASE_PROMPT",
  "CINDERPAW_API_KEY",
  "CINDERPAW_BUDGET_CONVERSATION",
  "CINDERPAW_BUDGET_DAY",
  "CINDERPAW_BUDGET_POLICY",
  "CINDERPAW_BYOK_PROVIDER",
  "CINDERPAW_CLOUD_TRANSCRIPT_BUDGET",
  "CINDERPAW_CRON_JOB_TIMEOUT_MS",
  "CINDERPAW_CRON_TICK_MS",
  "CINDERPAW_DB",
  "CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS",
  "CINDERPAW_EMBED_CHUNK",
  "CINDERPAW_EMBED_GPU_LAYERS",
  "CINDERPAW_FALLBACK_API_KEY",
  "CINDERPAW_FALLBACK_BASE_URL",
  "CINDERPAW_FALLBACK_MODEL",
  "CINDERPAW_FALLBACK_PROVIDER",
  "CINDERPAW_FETCH_DOMAINS",
  "CINDERPAW_FMS_DEDUP_SPAN_MS",
  "CINDERPAW_FMS_EVICTION",
  "CINDERPAW_FMS_MERGE_THRESHOLD",
  "CINDERPAW_FRACTAL_BENCH_COUNT",
  "CINDERPAW_FRACTAL_BENCH_QUERIES",
  "CINDERPAW_FRACTAL_BENCH_SEED",
  "CINDERPAW_HEARTBEAT_INTERVAL_MS",
  "CINDERPAW_HTTP_DOMAINS",
  "CINDERPAW_JINA_API_KEY",
  "CINDERPAW_LORA_TRAINER_BIN",
  "CINDERPAW_LORA_TRAIN_TIMEOUT_MS",
  "CINDERPAW_MERGE_THRESHOLD",
  "CINDERPAW_MODULE_SEED",
  "CINDERPAW_NO_COLOR",
  "CINDERPAW_OLLAMA_NUM_CTX",
  "CINDERPAW_RSI_EVAL_TOKEN_BUDGET",
  "CINDERPAW_RSI_MAX_ITER",
  "CINDERPAW_RSI_STAGNATION_THRESHOLD",
  "CINDERPAW_RSI_TELEMETRY",
  "CINDERPAW_RUN_FRACTAL_BENCH",
  "CINDERPAW_SHELL_DENYLIST",
  "CINDERPAW_SHELL_WHITELIST",
  "CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS",
  "CINDERPAW_THOUGHTS_COOLDOWN_MS",
  "CINDERPAW_THOUGHTS_DAILY_CAP",
  "CINDERPAW_THOUGHTS_INTERVAL_MS",
  "CINDERPAW_THOUGHTS_MIN_IDLE_MS",
  "CINDERPAW_THOUGHTS_MOOD_THRESHOLD",
  "CINDERPAW_TRUSTED_BASE_URLS",
  // tree-builder.ts's readers clamp out-of-range values to a floor
  // (n >= 2 / n >= 100 / n >= 500) before falling back to their default;
  // cfgInt has no clamp hook, so a mechanical swap would silently accept
  // e.g. CINDERPAW_TREE_BRANCH=1 instead of falling back to 8.
  "CINDERPAW_TREE_BRANCH",
  "CINDERPAW_TREE_ITEM_MAX_CHARS",
  "CINDERPAW_TREE_CLUSTER_MAX_CHARS",
]);

describe("config.ts", () => {
  test("no new process.env.CINDERPAW_ reads outside config.ts and the grandfathered list", async () => {
    const files = await walkTsFiles(SRC);
    const texts = await Promise.all(files.map((f) => Bun.file(f).text()));
    const offenders: string[] = [];
    for (const [i, text] of texts.entries()) {
      const matches = text.matchAll(/process\.env\.(CINDERPAW_[A-Z_]*)/g);
      for (const m of matches) {
        if (!GRANDFATHERED.has(m[1]!)) offenders.push(`${files[i]}: ${m[1]}`);
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
