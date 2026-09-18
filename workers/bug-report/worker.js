// Receives bug reports from the Cinderpaw desktop app and forwards them to a
// private Discord channel. The webhook lives in a worker secret, never in the
// app binary (the repo is public).
//
// POST /          {description, version, os, log}  ->  204 | 400 | 413 | 429 | 502
// POST /install   {version, os}                    ->  204  (counts one install)
// GET  /install                                    ->  200 {total, byVersion, byOs, counting}

const MAX_BODY = 8 * 1024;
const PER_HOUR = 5;

/**
 * One install, counted once, carrying nothing that identifies anyone.
 *
 * The body is a version and an OS string. There is no id, no fingerprint and
 * no timestamp per install: the app promises it sends this once per machine
 * and then writes a marker so it never sends it again, so a count of requests
 * IS a count of installs. That means this endpoint needs no store of who has
 * pinged, which is the only design where "anonymous" is a property of the data
 * rather than a promise about how it is handled.
 *
 * Why it exists at all: the GitHub release page showed 519 downloads for
 * v2026.08.11, of which 449 were `latest.json` — the updater checking, over
 * and over, from installs we already had. Roughly 60 were real installers.
 * Quoting 519 would have been a lie we told ourselves first.
 *
 * ponytail: KV read-modify-write, so two installs landing in the same
 * millisecond can lose one. This is a vanity counter, not billing; a Durable
 * Object is the upgrade if the number ever has to be exact. Without the KV
 * binding the route still answers 204 and counts nothing, so a fork that
 * deploys this worker without a namespace is not broken, just not counting.
 */
async function countInstall(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 204 }); }
  const version = String(body.version ?? 'unknown').slice(0, 32);
  // Counted, not just received. The app tells the person it sends its version
  // AND its OS, so the OS has to be a number somebody reads: a value collected
  // and thrown away is the one that gets "put to use" later, quietly, by
  // whoever notices it is already arriving.
  const os = String(body.os ?? 'unknown').slice(0, 32);
  if (!env.INSTALLS) return new Response(null, { status: 204 });
  for (const key of ['total', `v:${version}`, `os:${os}`]) {
    const current = Number((await env.INSTALLS.get(key)) ?? 0);
    await env.INSTALLS.put(key, String(current + 1));
  }
  return new Response(null, { status: 204 });
}

async function readInstalls(env) {
  const json = (body) => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
  if (!env.INSTALLS) return json({ total: 0, byVersion: {}, byOs: {}, counting: false });

  const group = async (prefix) => {
    const out = {};
    const list = await env.INSTALLS.list({ prefix });
    for (const k of list.keys) {
      out[k.name.slice(prefix.length)] = Number((await env.INSTALLS.get(k.name)) ?? 0);
    }
    return out;
  };
  return json({
    total: Number((await env.INSTALLS.get('total')) ?? 0),
    byVersion: await group('v:'),
    byOs: await group('os:'),
    // Says out loud that the store is wired, so a zero can be told apart from
    // a worker deployed without its KV namespace.
    counting: true,
  });
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === '/install') {
      if (req.method === 'GET') return readInstalls(env);
      if (req.method === 'POST') return countInstall(req, env);
      return new Response('GET or POST', { status: 405 });
    }
    if (req.method !== 'POST') return new Response('POST only', { status: 405 });
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) return new Response('too large', { status: 413 });

    let body;
    try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
    const description = String(body.description ?? '').trim();
    if (!description) return new Response('empty', { status: 400 });

    // ponytail: rate limit via the Cache API keyed on IP, one counter per hour
    // bucket. Cache is per-colo so a mover gets a fresh 5; fine for abuse
    // control, upgrade to KV if it is ever gamed.
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = new Request(`https://rate.local/${ip}/${hour}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) : 0;
    if (count >= PER_HOUR) return new Response('rate limited', { status: 429 });
    await cache.put(key, new Response(String(count + 1), { headers: { 'cache-control': 'max-age=3600' } }));

    const content =
      `**Bug report** · v${body.version ?? '?'} · ${body.os ?? '?'}\n` +
      description.slice(0, 1800);
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content, allowed_mentions: { parse: [] } }));
    if (body.log) form.append('files[0]', new Blob([String(body.log)], { type: 'text/plain' }), 'cinderpaw.log');

    const r = await fetch(env.DISCORD_WEBHOOK, { method: 'POST', body: form });
    return new Response(null, { status: r.ok ? 204 : 502 });
  },
};
