// Pure logic for the usage summary and the public leaderboard. Kept apart
// from worker.js so it is tested without a Workers runtime.
const OUTCOMES = ['completed', 'stuck', 'out_of_time', 'ceiling', 'stopped', 'no_answer', 'error'];
const ERRORS = ['network', 'auth', 'billing', 'rate_limit', 'context_overflow', 'provider_error', 'tool_error', 'other'];
const TOP = ['v', 'code', 'day', 'app', 'os', 'groups'];
const GROUP = ['provider', 'model', 'tasks_part', 'tasks_main', 'outcomes', 'errors', 'thumbs_up', 'thumbs_down',
  'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'cost_reported_usd', 'cost_estimated_usd',
  'duration_buckets', 'tool_calls', 'fallbacks', 'retries', 'by_flags'];
const MAX = 1e9;
// One install, one model, one day. Far above a person; the app drops a group over it.
export const MAX_TASKS_PER_DAY = 10_000;
const sum = (xs) => xs.reduce((a, x) => a + x, 0);
const NAME = /^[A-Za-z0-9._:/@+-]{1,128}$/;
const num = (x, nullable = false) => (nullable && x === null) || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX);
const str = (x, n) => typeof x === 'string' && x.length > 0 && x.length <= n;
const exactKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => k in o);

export function validatePayload(b, now = Date.now()) {
  const bad = (error) => ({ ok: false, error });
  if (!exactKeys(b, TOP)) return bad('fields');
  if (b.v !== 1) return bad('v');
  if (typeof b.code !== 'string' || !/^[0-9a-f]{32}$/.test(b.code)) return bad('code');
  if (typeof b.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.day)) return bad('day');
  const dayMs = Date.parse(`${b.day}T00:00:00Z`);
  const todayMs = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  // Only completed days, at most ~a month back (the app keeps 30).
  if (!(dayMs < todayMs) || todayMs - dayMs > 32 * 86_400_000) return bad('day range');
  if (!str(b.app, 32) || !['windows', 'macos', 'linux', 'other'].includes(b.os)) return bad('app/os');
  if (!Array.isArray(b.groups) || b.groups.length === 0 || b.groups.length > 50) return bad('groups');
  const seen = new Set();
  for (const g of b.groups) {
    if (!exactKeys(g, GROUP)) return bad('group fields');
    // Shown on a public page: model-id characters only (the app maps anything else to `<provider>-other`).
    if (!str(g.provider, 64) || !NAME.test(g.provider) || !NAME.test(g.model)) return bad('provider/model');
    // One row per (code, day, provider, model) in D1: a duplicate would fail the insert.
    const key = `${g.provider}\u0000${g.model}`;
    if (seen.has(key)) return bad('duplicate model');
    seen.add(key);
    for (const k of ['tasks_part', 'tasks_main', 'thumbs_up', 'thumbs_down', 'tokens_in', 'tokens_out', 'cost_reported_usd', 'cost_estimated_usd', 'tool_calls', 'fallbacks', 'retries']) {
      if (!num(g[k])) return bad(k);
    }
    if (!num(g.cache_read, true) || !num(g.cache_write, true)) return bad('cache');
    if (!exactKeys(g.outcomes, OUTCOMES) || !OUTCOMES.every((k) => num(g.outcomes[k]))) return bad('outcomes');
    if (!exactKeys(g.errors, ERRORS) || !ERRORS.every((k) => num(g.errors[k]))) return bad('errors');
    if (!Array.isArray(g.duration_buckets) || g.duration_buckets.length !== 8 || !g.duration_buckets.every((x) => num(x))) return bad('buckets');
    if (!g.by_flags || typeof g.by_flags !== 'object' || Array.isArray(g.by_flags)) return bad('by_flags');
    for (const [k, f] of Object.entries(g.by_flags)) {
      if (!/^brsi[01]_mem[01]$/.test(k) || !exactKeys(f, ['tasks', 'completed', 'up', 'down']) || !Object.values(f).every((x) => num(x))) return bad('by_flags');
    }
    // The numbers must agree with each other, or one POST could print any rate
    // on the public table. The app's rollup always produces groups that do
    // (CinderpawAgent/tests/usage-rollup.test.ts sends a real day through here).
    const t = g.tasks_main;
    if (sum(Object.values(g.outcomes)) !== t || sum(g.duration_buckets) !== t
      || sum(Object.values(g.by_flags).map((f) => f.tasks)) !== t
      || sum(Object.values(g.errors)) !== g.outcomes.error
      || g.thumbs_up + g.thumbs_down > t || t > g.tasks_part || g.tasks_part > MAX_TASKS_PER_DAY) return bad('inconsistent');
  }
  return { ok: true };
}

// The app picks its own code, so the worker cannot tell a real install from a
// made-up one. It can see where codes come from: one address brings a few new
// codes a day (a household, an office), not the MIN_INSTALLS that put a model
// on the public table.
export const NEW_CODES_PER_IP_PER_DAY = 5;

/** Whether `code` may report from an address that already brought `seen` today. */
export function admitCode(seen, code, max = NEW_CODES_PER_IP_PER_DAY) {
  if (seen.includes(code)) return { ok: true, seen };
  if (seen.length >= max) return { ok: false, seen };
  return { ok: true, seen: [...seen, code] };
}

/** 95% Wilson interval for k successes out of n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Index of the bucket holding the median task, or null with no tasks. */
export function medianBucket(b) {
  const total = b.reduce((a, x) => a + x, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < b.length; i++) { seen += b[i]; if (seen >= total / 2) return i; }
  return b.length - 1;
}

// ponytail: aggregates in JS over one month of rows; move the sums into SQL
// (json_extract) when a month passes ~100k rows.
export function aggregate(rows, { minInstalls, minTasks }) {
  const per = new Map();
  const allCodes = new Set();
  for (const r of rows) {
    allCodes.add(r.code);
    const key = `${r.provider}\u0000${r.model}`;
    let m = per.get(key);
    if (!m) per.set(key, (m = { provider: r.provider, model: r.model, codes: new Set(), tasks: 0, tasks_part: 0, completed: 0, up: 0, down: 0,
      reported: 0, estimated: 0, cacheRead: null, tokensIn: 0, buckets: Array(8).fill(0), errors: Object.fromEntries(ERRORS.map((e) => [e, 0])) }));
    const g = JSON.parse(r.data);
    m.codes.add(r.code);
    m.tasks += g.tasks_main; m.tasks_part += g.tasks_part; m.completed += g.outcomes.completed;
    m.up += g.thumbs_up; m.down += g.thumbs_down;
    m.reported += g.cost_reported_usd; m.estimated += g.cost_estimated_usd;
    m.tokensIn += g.tokens_in;
    if (g.cache_read !== null) m.cacheRead = (m.cacheRead ?? 0) + g.cache_read;
    g.duration_buckets.forEach((x, i) => (m.buckets[i] += x));
    for (const e of ERRORS) m.errors[e] += g.errors[e];
  }
  const models = [];
  let hidden = 0;
  for (const m of per.values()) {
    if (m.codes.size < minInstalls || m.tasks < minTasks) { hidden++; continue; }
    const rated = m.up + m.down;
    models.push({
      provider: m.provider, model: m.model, installs: m.codes.size, tasks: m.tasks, tasks_part: m.tasks_part,
      completion_rate: m.completed / m.tasks, completion_ci: wilson(m.completed, m.tasks),
      rated, satisfaction: rated ? m.up / rated : null, satisfaction_ci: wilson(m.up, rated),
      cost_reported_per_task: m.reported / m.tasks, cost_estimated_per_task: m.estimated / m.tasks,
      median_duration_bucket: medianBucket(m.buckets),
      cache_share: m.cacheRead === null || !m.tokensIn ? null : m.cacheRead / m.tokensIn,
      errors: m.errors,
    });
  }
  models.sort((a, b) => b.tasks - a.tasks);
  return { models, hidden, installs: allCodes.size };
}
