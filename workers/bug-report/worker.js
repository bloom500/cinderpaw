// Receives bug reports from the Cinderpaw desktop app and forwards them to a
// private Discord channel. The webhook lives in a worker secret, never in the
// app binary (the repo is public).
//
// POST / {description, version, os, log}  ->  204 | 400 | 413 | 429 | 502

const MAX_BODY = 8 * 1024;
const PER_HOUR = 5;

export default {
  async fetch(req, env) {
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
