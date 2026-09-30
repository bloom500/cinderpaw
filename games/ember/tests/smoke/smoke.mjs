// Loads the exported campfire game in a real browser engine and checks the
// bridge end to end: `ready` arrives, sparks go in, `end` brings a score out.
// usage: node smoke.mjs <export-dir> <chromium|webkit>
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const [dir, engine = 'chromium'] = process.argv.slice(2);
const root = resolve(dir);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png' };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="g" src="/game/index.html" width="800" height="240" style="border:0"></iframe>
<script>
  window.log = [];
  addEventListener('message', (e) => { if (e.origin === location.origin) window.log.push(JSON.parse(e.data)); });
  window.send = (m) => document.getElementById('g').contentWindow.postMessage(JSON.stringify(m), location.origin);
</script>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HOST); return; }
  try {
    const body = await readFile(join(root, path.replace(/^\/game\//, '')));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await ({ chromium, webkit })[engine].launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let code = 0;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.log.some((m) => m.type === 'ready'), null, { timeout: 45_000 });
  await page.evaluate(() => {
    send({ type: 'start', best: 0 });
    for (let i = 0; i < 3; i++) send({ type: 'spark', kind: 'search' });
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `smoke-${engine}.png` });
  await page.evaluate(() => send({ type: 'end', ok: true }));
  await page.waitForFunction(() => window.log.some((m) => m.type === 'score'), null, { timeout: 10_000 });
  const score = (await page.evaluate(() => window.log)).find((m) => m.type === 'score');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${engine}: ready, score ${score.value}`);
} catch (e) {
  console.error(`${engine}: FAILED\n${e}`);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
