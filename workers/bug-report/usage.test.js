import { describe, expect, test } from 'bun:test';
import { aggregate, medianBucket, validatePayload, wilson } from './usage.js';

const group = (over = {}) => ({
  provider: 'openrouter.ai', model: 'm', tasks_part: 1, tasks_main: 1,
  outcomes: { completed: 1, stuck: 0, out_of_time: 0, ceiling: 0, stopped: 0, no_answer: 0, error: 0 },
  errors: { network: 0, auth: 0, billing: 0, rate_limit: 0, context_overflow: 0, provider_error: 0, tool_error: 0, other: 0 },
  thumbs_up: 1, thumbs_down: 0, tokens_in: 100, tokens_out: 10, cache_read: null, cache_write: null,
  cost_reported_usd: 0.01, cost_estimated_usd: 0, duration_buckets: [0, 1, 0, 0, 0, 0, 0, 0],
  tool_calls: 0, fallbacks: 0, retries: 0, by_flags: {}, ...over,
});
const payload = (over = {}) => ({ v: 1, code: 'a'.repeat(32), day: '2026-10-09', app: '2026.10.1', os: 'windows', groups: [group()], ...over });
const NOW = Date.parse('2026-10-10T08:00:00Z');

describe('validatePayload', () => {
  test('accepts the documented shape', () => expect(validatePayload(payload(), NOW)).toEqual({ ok: true }));
  test('rejects unknown fields', () => expect(validatePayload(payload({ email: 'x' }), NOW).ok).toBe(false));
  test('rejects unknown group fields', () => expect(validatePayload(payload({ groups: [group({ prompt: 'hi' })] }), NOW).ok).toBe(false));
  test('rejects negative numbers', () => expect(validatePayload(payload({ groups: [group({ tokens_in: -1 })] }), NOW).ok).toBe(false));
  test('rejects >50 groups', () => expect(validatePayload(payload({ groups: Array(51).fill(group()) }), NOW).ok).toBe(false));
  test('rejects the same model twice in one day', () =>
    expect(validatePayload(payload({ groups: [group(), group()] }), NOW).ok).toBe(false));
  test('rejects future and >31-day-old days', () => {
    expect(validatePayload(payload({ day: '2026-10-11' }), NOW).ok).toBe(false);
    expect(validatePayload(payload({ day: '2026-08-01' }), NOW).ok).toBe(false);
  });
  test('rejects a bad code', () => expect(validatePayload(payload({ code: 'xyz' }), NOW).ok).toBe(false));
});

test('wilson', () => {
  expect(wilson(0, 0)).toBeNull();
  const [lo, hi] = wilson(9, 10);
  expect(lo).toBeCloseTo(0.596, 2);
  expect(hi).toBeCloseTo(0.982, 2);
});

test('medianBucket', () => {
  expect(medianBucket([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  expect(medianBucket([1, 1, 5, 0, 0, 0, 0, 0])).toBe(2);
});

describe('aggregate', () => {
  const rows = (installs, tasksEach) => Array.from({ length: installs }, (_, i) => ({
    code: String(i).padStart(32, '0'), provider: 'openrouter.ai', model: 'm',
    data: JSON.stringify(group({ tasks_main: tasksEach, tasks_part: tasksEach, outcomes: { completed: tasksEach, stuck: 0, out_of_time: 0, ceiling: 0, stopped: 0, no_answer: 0, error: 0 } })),
  }));
  test('thresholds hide small models', () => {
    expect(aggregate(rows(19, 10), { minInstalls: 20, minTasks: 100 })).toMatchObject({ models: [], hidden: 1, installs: 19 });
    expect(aggregate(rows(20, 4), { minInstalls: 20, minTasks: 100 }).models).toHaveLength(0);
    const r = aggregate(rows(20, 5), { minInstalls: 20, minTasks: 100 });
    expect(r.models[0]).toMatchObject({ installs: 20, tasks: 100, completion_rate: 1 });
  });
});

// A fake D1 that runs the two statements worker.js uses against an array.
function fakeD1() {
  const rows = [];
  const prepare = (sql) => ({ bind: (...args) => ({ sql, args }) });
  const batch = async (stmts) => {
    for (const { sql, args } of stmts) {
      if (sql.startsWith('DELETE')) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].code === args[0] && rows[i].day === args[1]) rows.splice(i, 1);
      } else {
        const [code, day, month, app, os, provider, model, data] = args;
        rows.push({ code, day, month, app, os, provider, model, data });
      }
    }
  };
  return { rows, prepare, batch };
}

test('same code+day replaces, never adds', async () => {
  const { default: worker } = await import('./worker.js');
  const db = fakeD1();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const post = (p) => worker.fetch(new Request('https://w/usage', { method: 'POST', body: JSON.stringify(p) }), { USAGE: db });
  expect((await post(payload({ day: yesterday }))).status).toBe(204);
  expect((await post(payload({ day: yesterday, groups: [group({ tasks_main: 7 })] }))).status).toBe(204);
  expect(db.rows).toHaveLength(1);
  expect(JSON.parse(db.rows[0].data).tasks_main).toBe(7);
  expect((await post(payload({ day: yesterday, email: 'x' }))).status).toBe(400);
  expect(db.rows).toHaveLength(1);
});
