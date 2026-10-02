// RC smoke, Windows: the installed app, driven through WebView2's DevTools port.
//
// Checks only what an installed build can get wrong and dev cannot show:
//   1. the window opens and the first run draws something (screenshot),
//   2. the window's CSP is really on (a srcdoc frame's script must NOT run),
//   3. an artifact chart runs from the cinderpaw-frame scheme, ECharts included,
//   4. the campfire game's WebAssembly is allowed,
//   5. the sidecar is running.
// Everything it sees lands in smoke-out/ (screenshots, console, report.json).
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
// Installed next to this file by the workflow (npm install --prefix scripts/rc-smoke).
import { chromium } from 'playwright-core';

const OUT = 'smoke-out';
mkdirSync(OUT, { recursive: true });
const report = { checks: {}, console: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  report.checks[name] = { ok, detail };
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

const app = spawn(process.env.APP_EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  detached: true,
  stdio: 'ignore',
});
app.unref();

// The DevTools port answers once the webview is up.
let cdp = null;
for (let i = 0; i < 90 && !cdp; i++) {
  try { cdp = await (await fetch('http://127.0.0.1:9222/json/version')).json(); } catch { await sleep(1000); }
}
if (!cdp) {
  check('window opens', false, 'no WebView2 DevTools port after 90 s');
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  process.exit(1);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|tauri:\/\//.test(p.url())) ?? null;
  if (!page) await sleep(1000);
}
check('window opens', !!page, page?.url() ?? 'no tauri.localhost page');
if (!page) process.exit(1);

page.on('console', (m) => report.console.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => report.console.push(`[pageerror] ${e.message}`));
await sleep(20000); // the first run settles: onboarding, sidecar boot
await page.screenshot({ path: `${OUT}/01-first-run.png` });

// 2. The CSP is on: an inline script in a sandboxed srcdoc frame must not run.
await page.evaluate(() => {
  const f = document.createElement('iframe');
  f.id = 'smoke-srcdoc';
  f.setAttribute('sandbox', 'allow-scripts');
  f.srcdoc = '<body><script>document.body.dataset.ran = "yes"</script></body>';
  document.body.append(f);
});
await sleep(2000);
const srcdocFrame = page.frames().find((f) => f.url() === 'about:srcdoc');
const srcdocRan = srcdocFrame ? await srcdocFrame.evaluate(() => document.body.dataset.ran ?? 'no').catch(() => 'unknown') : 'no frame';
check('window CSP is enforced (srcdoc script blocked)', srcdocRan === 'no', `srcdoc script ran: ${srcdocRan}`);

// 3. An artifact chart, through the same path the app uses (artifact_frame_put + cinderpaw-frame).
const CHART = `<!doctype html><html><head><script src="cinderpaw:echarts"></script></head>
<body style="margin:0;background:#fff"><div id="c" style="width:440px;height:280px"></div>
<script>
document.body.dataset.echarts = typeof echarts;
var ch = echarts.init(document.getElementById('c'));
ch.setOption({ animation: false, xAxis: { data: ['Mon','Tue','Wed'] }, yAxis: {}, series: [{ type: 'bar', data: [3, 7, 5] }] });
document.body.dataset.ok = 'drawn';
</script></body></html>`;
let frameUrl = '';
try {
  frameUrl = await page.evaluate(async (html) => {
    const t = await window.__TAURI_INTERNALS__.invoke('artifact_frame_put', { html });
    const url = window.__TAURI_INTERNALS__.convertFileSrc(t, 'cinderpaw-frame');
    const f = document.createElement('iframe');
    f.id = 'smoke-chart';
    f.setAttribute('sandbox', 'allow-scripts');
    f.src = url;
    f.style.cssText = 'position:fixed;right:12px;bottom:12px;width:460px;height:300px;z-index:2147483647;background:#fff;border:3px solid #c2562b';
    document.body.append(f);
    return url;
  }, CHART);
} catch (e) {
  check('artifact chart runs', false, `could not hand the page to the host: ${e.message}`);
}
if (frameUrl) {
  await sleep(4000);
  const chart = page.frames().find((f) => f.url().startsWith(frameUrl));
  const state = chart ? await chart.evaluate(() => ({ echarts: document.body.dataset.echarts, ok: document.body.dataset.ok })).catch((e) => ({ error: e.message })) : { error: 'frame not found' };
  check('artifact chart runs', state.ok === 'drawn' && state.echarts === 'object', JSON.stringify({ url: frameUrl, ...state }));
  await page.screenshot({ path: `${OUT}/02-chart-frame.png` });
}

// 4. The campfire game: its WebAssembly must be allowed by the CSP.
const gameShipped = await page.evaluate(async () => (await fetch('/games/ember/index.html', { method: 'HEAD' })).ok).catch(() => false);
if (!gameShipped) {
  check('campfire game shipped', false, '/games/ember/index.html is not in the bundle');
} else {
  const before = report.console.length;
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'smoke-game';
    f.src = '/games/ember/index.html';
    f.style.cssText = 'position:fixed;left:12px;bottom:12px;width:420px;height:260px;z-index:2147483647;border:3px solid #6a9e5a';
    document.body.append(f);
  });
  // A same-origin frame's console arrives on the page's console listener.
  await sleep(15000);
  const wasmBlocked = report.console.slice(before).some((l) => /WebAssembly|wasm-unsafe-eval|CompileError/.test(l));
  check('campfire game WebAssembly allowed', !wasmBlocked, wasmBlocked ? 'a WebAssembly CSP error was logged' : 'no WebAssembly CSP error');
  await page.screenshot({ path: `${OUT}/03-game.png` });
}

// 5. The sidecar runs.
const tasks = execSync('tasklist /FO CSV /NH').toString();
check('sidecar running', /cinderpaw-agent/i.test(tasks), (tasks.match(/"cinderpaw[^"]*"/gi) ?? []).join(' '));

report.csp = report.console.filter((l) => /Content Security Policy|Refused to/i.test(l));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/console.txt`, report.console.join('\n'));
console.log(`CSP lines in the main window's console: ${report.csp.length}`);
for (const l of report.csp.slice(0, 20)) console.log(`  ${l}`);

await browser.close().catch(() => {});
try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
const failed = Object.entries(report.checks).filter(([, v]) => !v.ok).map(([k]) => k);
if (failed.length) {
  console.log(`\nFailed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
