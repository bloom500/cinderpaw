import { expect, test } from 'bun:test';

// The Workers Cache API the rate limiter uses, as a Map. Bun has no `caches`.
const cacheStore = new Map();
globalThis.caches ??= { default: {
  match: async (req) => cacheStore.get(req.url)?.clone(),
  put: async (req, res) => { cacheStore.set(req.url, res); },
} };

// A KV namespace as a Map, with the three calls the install counter uses.
function fakeKV() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
}

test('an install counts where they heard about Cinderpaw, only from the buttons', async () => {
  const { default: worker } = await import('./worker.js');
  const kv = fakeKV();
  const post = (b) => worker.fetch(new Request('https://w/install', { method: 'POST', body: JSON.stringify(b) }), { INSTALLS: kv });
  await post({ version: '2026.10.16', os: 'windows x86_64', heard: 'reddit' });
  await post({ version: '2026.10.16', os: 'windows x86_64', heard: 'my friend Ana' });
  await post({ version: '2026.10.16', os: 'windows x86_64' });
  const got = await (await worker.fetch(new Request('https://w/install'), { INSTALLS: kv })).json();
  expect(got.total).toBe(3);
  expect(got.bySource).toEqual({ reddit: 1 });
});

test('a site visit is counted per source and day, and only known words get in', async () => {
  const { default: worker, parseVisit } = await import('./worker.js');
  expect(parseVisit({ source: 'youtube', step: 'download' })).toEqual({ source: 'youtube', step: 'download' });
  expect(parseVisit({ source: 'https://evil.example/?id=1', step: 'view' })).toBeNull();
  expect(parseVisit({ source: 'reddit', step: 'bought' })).toBeNull();
  for (const source of ['linkedin', 'facebook', 'friend']) expect(parseVisit({ source, step: 'view' })).toEqual({ source, step: 'view' });
  const runs = [];
  const db = { prepare: (sql) => ({ bind: (...args) => ({ run: async () => { runs.push({ sql, args }); } }) }) };
  // sendBeacon posts text/plain, so the body is read as text, not as a JSON request.
  const post = (b, ip = '7.7.7.7') => worker.fetch(new Request('https://w/visit', {
    method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'text/plain', 'cf-connecting-ip': ip } }), { USAGE: db });
  expect((await post({ source: 'reddit', step: 'view' })).status).toBe(204);
  expect(runs[0].args.slice(1)).toEqual(['reddit', 'view']);
  expect(runs[0].sql).toContain('n = n + 1');
  expect((await post({ source: 'nope', step: 'view' })).status).toBe(400);
  expect(runs).toHaveLength(1);
  for (let i = 0; i < 40; i++) await post({ source: 'x', step: 'view' }, '6.6.6.6');
  expect(runs.filter((r) => r.args[1] === 'x')).toHaveLength(30); // one address cannot flood a channel
});
