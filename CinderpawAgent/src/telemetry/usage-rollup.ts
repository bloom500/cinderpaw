import type { Database } from "bun:sqlite";
import { blendedPricePer1kUsd, estimateUsd } from "../rsi/infra/rsi-cost.ts";
import { ERROR_CATEGORIES, type ErrorCategory } from "./error-category.ts";
import { publicProvider } from "./provider-label.ts";
import { TASK_OUTCOMES, type TaskOutcome } from "./task-metrics.ts";

export interface UsageGroup {
  provider: string;
  model: string;
  tasks_part: number;
  tasks_main: number;
  outcomes: Record<TaskOutcome, number>;
  errors: Record<ErrorCategory, number>;
  thumbs_up: number;
  thumbs_down: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number | null;
  cache_write: number | null;
  cost_reported_usd: number;
  cost_estimated_usd: number;
  duration_buckets: number[];
  tool_calls: number;
  fallbacks: number;
  retries: number;
  by_flags: Record<string, { tasks: number; completed: number; up: number; down: number }>;
}

/** Upper bounds in seconds; the 8th bucket is everything above 900 s. */
export const DURATION_BOUNDS_S = [5, 15, 30, 60, 120, 300, 900] as const;
export function bucketOf(ms: number): number {
  const s = ms / 1000;
  const i = DURATION_BOUNDS_S.findIndex((b) => s < b);
  return i === -1 ? DURATION_BOUNDS_S.length : i;
}

// A local file name can carry a person's name, so only a recognised model
// family leaves the machine, followed only by version/size/variant parts.
// Anything else after the family is cut off, and an unknown family is
// `local-other` (or `custom-other` for a server the person runs). ponytail:
// family list + segment allowlist; the bundled model catalog is the upgrade
// if this ever drifts.
const LOCAL_FAMILY = /^(qwen|llama|gemma|mistral|phi|deepseek|glm|minimax|gpt|smollm|granite|olmo|kimi)[\d.]*$/;
const QUANT = /^(i?q\d.*|f16|bf16|fp16|f32)$/;
const VARIANT = /^([a-z]{0,2}\d[a-z\d.]*|instruct|it|chat|coder|vl|base|thinking|oss|moe)$/;
/** The worker's charset for names (workers/bug-report/usage.js): outside it the whole day is refused. */
const SENDABLE = /^[A-Za-z0-9._:/@+-]{1,128}$/;
/** `provider` is the public label (provider-label.ts `publicProvider`). */
export function modelLabel(provider: string, model: string): string {
  // A fine-tune id names the org and the job: `ft:<base>:<org>:<name>:<id>` keeps the base.
  const base = model.startsWith("ft:") ? (model.split(":")[1] ?? "") : model;
  // Account-scoped ids (Fireworks `accounts/<who>/...`, Volcengine/BytePlus
  // `ep-<id>`) are the same every month, so they would follow one install.
  if (/^(accounts\/|ep-)/.test(base) || !SENDABLE.test(base)) return `${provider}-other`;
  if (provider !== "local" && provider !== "custom") return base;
  const parts = base.toLowerCase().replace(/\.gguf$/, "").split(/[-_:]/);
  if (!LOCAL_FAMILY.test(parts[0] ?? "")) return `${provider}-other`;
  const kept = [parts[0]!];
  for (const p of parts.slice(1)) {
    if (QUANT.test(p) || !VARIANT.test(p)) break;
    kept.push(p);
  }
  return kept.join("-");
}

function emptyGroup(provider: string, model: string): UsageGroup {
  return {
    provider, model, tasks_part: 0, tasks_main: 0,
    outcomes: Object.fromEntries(TASK_OUTCOMES.map((o) => [o, 0])) as Record<TaskOutcome, number>,
    errors: Object.fromEntries(ERROR_CATEGORIES.map((e) => [e, 0])) as Record<ErrorCategory, number>,
    thumbs_up: 0, thumbs_down: 0, tokens_in: 0, tokens_out: 0, cache_read: null, cache_write: null,
    cost_reported_usd: 0, cost_estimated_usd: 0, duration_buckets: Array(8).fill(0),
    tool_calls: 0, fallbacks: 0, retries: 0, by_flags: {},
  };
}

interface TaskRow { task_id: string; duration_ms: number; outcome: TaskOutcome; error_category: ErrorCategory | null;
  tool_calls: number; all_fallbacks: number; brsi_on: number; memory_on: number; feedback: number;
  attempted_provider: string | null; attempted_model: string | null }
interface CallRow { task_id: string; provider: string | null; m: string; prompt_tokens: number; completion_tokens: number;
  cache_read_tokens: number | null; cache_write_tokens: number | null; cost_usd: number | null; retries: number }

/** Finished tasks that STARTED in [fromMs, toMs), grouped per provider+model. */
export function rollup(db: Database, fromMs: number, toMs: number): UsageGroup[] {
  const tasks = db.query(
    // fallbacks = Brain Stack fallbacks (task row) + calls the router answered from its fallback engine.
    `SELECT t.*, t.fallbacks + (SELECT COALESCE(SUM(c.used_fallback), 0) FROM completion_cost c WHERE c.task_id = t.task_id) AS all_fallbacks
       FROM task_metrics t WHERE t.started_at >= ? AND t.started_at < ? AND t.outcome IS NOT NULL`,
  ).all(fromMs, toMs) as TaskRow[];
  if (tasks.length === 0) return [];
  const calls = db.query(
    `SELECT c.task_id, c.provider, COALESCE(c.served_model, c.model) AS m, c.prompt_tokens, c.completion_tokens,
            c.cache_read_tokens, c.cache_write_tokens, c.cost_usd, c.retries
       FROM completion_cost c JOIN task_metrics t ON t.task_id = c.task_id
      WHERE t.started_at >= ? AND t.started_at < ? AND t.outcome IS NOT NULL ORDER BY c.id`,
  ).all(fromMs, toMs) as CallRow[];

  const groups = new Map<string, UsageGroup>();
  // Only public labels leave: the local DB keeps the host and the raw name.
  const group = (storedProvider: string, rawModel: string) => {
    const provider = publicProvider(storedProvider);
    const model = modelLabel(provider, rawModel);
    const key = `${provider}\u0000${model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = emptyGroup(provider, model)));
    return g;
  };
  const callsByTask = new Map<string, CallRow[]>();
  for (const c of calls) {
    const list = callsByTask.get(c.task_id);
    if (list) list.push(c);
    else callsByTask.set(c.task_id, [c]);
  }

  for (const t of tasks) {
    const own = callsByTask.get(t.task_id) ?? [];
    const tokensByGroup = new Map<UsageGroup, number>();
    for (const c of own) {
      const g = group(c.provider ?? "unknown", c.m);
      g.tokens_in += c.prompt_tokens;
      g.tokens_out += c.completion_tokens;
      if (c.cache_read_tokens !== null) g.cache_read = (g.cache_read ?? 0) + c.cache_read_tokens;
      if (c.cache_write_tokens !== null) g.cache_write = (g.cache_write ?? 0) + c.cache_write_tokens;
      if (c.cost_usd !== null) g.cost_reported_usd += c.cost_usd;
      // No cloud price for a model on this computer or on the person's own server.
      else if (g.provider !== "local" && g.provider !== "custom") g.cost_estimated_usd += estimateUsd(c.prompt_tokens + c.completion_tokens, blendedPricePer1kUsd(c.m, false));
      g.retries += c.retries;
      tokensByGroup.set(g, (tokensByGroup.get(g) ?? 0) + c.prompt_tokens + c.completion_tokens);
    }
    for (const g of tokensByGroup.keys()) g.tasks_part += 1;
    // Most tokens wins; ties go to the first call (Map keeps insertion order).
    let main: UsageGroup | undefined;
    let best = -1;
    for (const [g, n] of tokensByGroup) if (n > best) { best = n; main = g; }
    if (!main) {
      main = group(t.attempted_provider ?? "unknown", t.attempted_model ?? "unknown");
      main.tasks_part += 1;
    }
    main.tasks_main += 1;
    main.outcomes[t.outcome] += 1;
    if (t.error_category) main.errors[t.error_category] += 1;
    if (t.feedback > 0) main.thumbs_up += 1;
    if (t.feedback < 0) main.thumbs_down += 1;
    const bi = bucketOf(t.duration_ms);
    main.duration_buckets[bi] = (main.duration_buckets[bi] ?? 0) + 1;
    main.tool_calls += t.tool_calls;
    main.fallbacks += t.all_fallbacks;
    const flag = `brsi${t.brsi_on}_mem${t.memory_on}`;
    const f = (main.by_flags[flag] ??= { tasks: 0, completed: 0, up: 0, down: 0 });
    f.tasks += 1;
    if (t.outcome === "completed") f.completed += 1;
    if (t.feedback > 0) f.up += 1;
    if (t.feedback < 0) f.down += 1;
  }
  return [...groups.values()];
}
