// Receives bug reports from the Cinderpaw desktop app and forwards them to a
// private Discord channel. The webhook lives in a worker secret, never in the
// app binary (the repo is public).
//
// POST /          {description, version, os, log}  ->  204 | 400 | 413 | 429 | 502
// POST /install   {version, os, heard?}            ->  204  (counts one install)
// GET  /install                                    ->  200 {total, byVersion, byOs, bySource, counting}
// POST /visit     {source, step}  (the site)       ->  204  (counts one visit or download click)
// POST /interest  {extra, price, answer} (the app) ->  204 | 400 | 413  (one answer to the paid-extra question)
// GET  /interest                                   ->  200 {rows: [{extra, price, answer, n}], counting}
// POST /usage {v,code,day,app,os,groups} -> 204 | 400 | 413 | 429  (opt-in daily usage summary)
// GET  /leaderboard?month=YYYY-MM -> 200 {month, minInstalls, minTasks, installs, hidden, models, counting}

import { admitCode, aggregate, validatePayload } from './usage.js';

// 64 KB, not 8: the app sends up to LOG_TAIL_BYTES (48 KB) of log plus the
// description, and at 8 KB every report that kept the log ticked came back
// 413 and was shown as "could not reach the server" (20 Sep).
const MAX_BODY = 64 * 1024;
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
  // Where they heard about Cinderpaw: one of the wizard's buttons, or nothing.
  // Anything else is dropped, so this key can never hold text someone typed.
  const heard = HEARD_FROM.includes(body.heard) ? [`src:${body.heard}`] : [];
  if (!env.INSTALLS) return new Response(null, { status: 204 });
  for (const key of ['total', `v:${version}`, `os:${os}`, ...heard]) {
    const current = Number((await env.INSTALLS.get(key)) ?? 0);
    await env.INSTALLS.put(key, String(current + 1));
  }
  return new Response(null, { status: 204 });
}

/** The wizard's "where did you hear about Cinderpaw?" buttons (src-tauri system.rs HEARD_FROM). */
export const HEARD_FROM = ['reddit', 'youtube', 'github', 'discord', 'instagram', 'tiktok', 'x', 'hackernews', 'friend', 'other'];
/** What the site can tell from a link or the page someone came from: the buttons' words plus `producthunt`, `linkedin`, `facebook`, `search` and `direct`. */
export const VISIT_SOURCES = ['reddit', 'youtube', 'github', 'discord', 'instagram', 'tiktok', 'x', 'hackernews', 'producthunt', 'linkedin', 'facebook', 'friend', 'search', 'direct', 'other'];

/** A visit from the site as a row to count, or null. Only known words pass: nothing typed, no page, no address. */
export function parseVisit(body) {
  const source = VISIT_SOURCES.includes(body?.source) ? body.source : null;
  const step = body?.step === 'view' || body?.step === 'download' ? body.step : null;
  return source && step ? { source, step } : null;
}

// A person opens a few pages and may press Download twice; far below this.
const VISITS_PER_HOUR = 30;
/**
 * One visit (or one Download click) on cinderpaw.dev, counted per source and
 * UTC day. Counts only: no address is stored (the rate limit keeps it an hour
 * in the colo's cache), no cookie, no page path. D1, not KV: a Reddit day can
 * bring thousands of visits and KV's daily writes would run out, taking the
 * install counter down with them.
 */
async function countVisit(req, env) {
  if (Number(req.headers.get('content-length') ?? 0) > 1024) return new Response('too large', { status: 413 });
  let body;
  try { body = JSON.parse(await req.text()); } catch { return new Response('bad json', { status: 400 }); }
  const row = parseVisit(body);
  if (!row) return new Response('unknown source or step', { status: 400 });
  if (await overLimit(req, 'visit', VISITS_PER_HOUR)) return new Response(null, { status: 204 });
  if (!env.USAGE) return new Response(null, { status: 204 });
  await env.USAGE.prepare('INSERT INTO visit_day (day, source, step, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, source, step) DO UPDATE SET n = n + 1')
    .bind(new Date().toISOString().slice(0, 10), row.source, row.step).run();
  return new Response(null, { status: 204 });
}

/** The in-app paid-extra question (frontend-react/src/lib/payIntent.ts). */
export const INTEREST_EXTRAS = ['apps', 'packs', 'always_on', 'ai_included', 'none'];
export const INTEREST_ANSWERS = ['yes', 'maybe', 'no', 'none'];

/** An answer as a row to count, or null. Known words and a short price tag only, so nothing typed can land here. */
export function parseInterest(body) {
  const extra = INTEREST_EXTRAS.includes(body?.extra) ? body.extra : null;
  const answer = INTEREST_ANSWERS.includes(body?.answer) ? body.answer : null;
  const price = typeof body?.price === 'string' && /^[0-9a-z]{1,8}$/.test(body.price) ? body.price : null;
  if (!extra || !answer || !price) return null;
  // "No thanks" is the only answer without a price question, and the only one.
  if ((extra === 'none') !== (answer === 'none')) return null;
  return { extra, price, answer };
}

// One machine answers once; a few retries or a shared office router still fit.
const INTEREST_PER_HOUR = 10;
/** One answer, counted per UTC day. Like a visit: no address stored, no id, no text. */
async function countInterest(req, env) {
  if (Number(req.headers.get('content-length') ?? 0) > 1024) return new Response('too large', { status: 413 });
  let body;
  try { body = JSON.parse(await req.text()); } catch { return new Response('bad json', { status: 400 }); }
  const row = parseInterest(body);
  if (!row) return new Response('unknown extra, price or answer', { status: 400 });
  if (await overLimit(req, 'interest', INTEREST_PER_HOUR)) return new Response(null, { status: 204 });
  if (!env.USAGE) return new Response(null, { status: 204 });
  await env.USAGE.prepare('INSERT INTO interest_day (day, extra, price, answer, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, extra, price, answer) DO UPDATE SET n = n + 1')
    .bind(new Date().toISOString().slice(0, 10), row.extra, row.price, row.answer).run();
  return new Response(null, { status: 204 });
}

/** The totals, for Darius to read in a browser: answers per extra and price, all days. */
async function readInterest(env) {
  const rows = env.USAGE
    ? (await env.USAGE.prepare('SELECT extra, price, answer, SUM(n) AS n FROM interest_day GROUP BY extra, price, answer ORDER BY extra, price, answer').all()).results
    : [];
  return new Response(JSON.stringify({ rows, counting: Boolean(env.USAGE) }), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
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
    bySource: await group('src:'),
    // Says out loud that the store is wired, so a zero can be told apart from
    // a worker deployed without its KV namespace.
    counting: true,
  });
}

// A model is public only once this many installations used it for this many
// tasks in the month: below that, one person's habits would be the number.
const MIN_INSTALLS = 20;
const MIN_TASKS = 100;
async function leaderboard(req, env) {
  const url = new URL(req.url);
  const asked = url.searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : new Date().toISOString().slice(0, 7);
  const cacheKey = new Request(`https://leaderboard.local/${month}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;
  let body = { month, minInstalls: MIN_INSTALLS, minTasks: MIN_TASKS, installs: 0, hidden: 0, models: [], counting: false };
  if (env.USAGE) {
    const { results } = await env.USAGE.prepare('SELECT code, provider, model, data FROM usage_day WHERE month = ?').bind(month).all();
    body = { month, minInstalls: MIN_INSTALLS, minTasks: MIN_TASKS, counting: true, ...aggregate(results, { minInstalls: MIN_INSTALLS, minTasks: MIN_TASKS }) };
  }
  const res = new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'max-age=3600' },
  });
  await caches.default.put(cacheKey, res.clone());
  return res;
}

// ponytail: rate limit via the Cache API keyed on IP, one counter per hour
// bucket. Cache is per-colo so a mover gets a fresh count; fine for abuse
// control, upgrade to KV if it is ever gamed.
async function overLimit(req, scope, perHour) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = new Request(`https://rate.local/${scope}/${ip}/${hour}`);
  const hit = await caches.default.match(key);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= perHour) return true;
  await caches.default.put(key, new Response(String(count + 1), { headers: { 'cache-control': 'max-age=3600' } }));
  return false;
}

// ponytail: per-colo Cache API like overLimit, so a speed bump (20 made-up
// installs now take days or many addresses), not a wall. A KV or D1 table of
// hashed addresses is the upgrade if the table is ever gamed anyway.
async function admitted(req, code) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const key = new Request(`https://codes.local/${ip}/${new Date().toISOString().slice(0, 10)}`);
  const hit = await caches.default.match(key);
  const seen = hit ? JSON.parse(await hit.text()) : [];
  const r = admitCode(seen, code);
  if (r.seen !== seen) await caches.default.put(key, new Response(JSON.stringify(r.seen), { headers: { 'cache-control': 'max-age=86400' } }));
  return r.ok;
}

// The app sends at most 30 days in one catch-up; two machines behind one router still fit.
const USAGE_PER_HOUR = 60;
async function storeUsage(req, env) {
  if (await overLimit(req, 'usage', USAGE_PER_HOUR)) return new Response('rate limited', { status: 429 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return new Response('too large', { status: 413 });
  let body;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const v = validatePayload(body);
  if (!v.ok) return new Response(v.error, { status: 400 });
  if (!(await admitted(req, body.code))) return new Response('too many installs from one address today', { status: 429 });
  if (!env.USAGE) return new Response(null, { status: 204 });
  // Replace, never add: one machine's day counts once however often it arrives.
  const stmts = [env.USAGE.prepare('DELETE FROM usage_day WHERE code = ? AND day = ?').bind(body.code, body.day)];
  for (const g of body.groups) {
    stmts.push(env.USAGE.prepare('INSERT INTO usage_day (code, day, month, app, os, provider, model, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(body.code, body.day, body.day.slice(0, 7), body.app, body.os, g.provider, g.model, JSON.stringify(g)));
  }
  await env.USAGE.batch(stmts);
  return new Response(null, { status: 204 });
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === '/usage' && req.method === 'POST') return storeUsage(req, env);
    if (path === '/visit' && req.method === 'POST') return countVisit(req, env);
    if (path === '/interest' && req.method === 'POST') return countInterest(req, env);
    if (path === '/interest' && req.method === 'GET') return readInterest(env);
    if (path === '/leaderboard' && req.method === 'GET') return leaderboard(req, env);
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

    if (await overLimit(req, 'bug', PER_HOUR)) return new Response('rate limited', { status: 429 });

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
