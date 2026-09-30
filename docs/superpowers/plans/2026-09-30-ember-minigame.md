# Campfire Mini-Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the agent works on a long task, offer an optional campfire game (Godot, web export) in a panel above the composer, fed by the agent's real tool calls.

**Architecture:** A Godot 4.7.2 project in `games/ember/` is exported at build time into `frontend-react/public/games/ember/` and loaded in an iframe only when the panel opens. The app and the game talk through `postMessage` with JSON strings (`emberBridge.ts` ↔ `bridge.gd`). The game exists only where its export does: the app asks once whether the export shipped and whether the machine has WebGL 2, and says why in Settings when it cannot run. The export ships inside the app like every other frontend file (Vite copies `public/` into `dist/`, which Tauri embeds); the installers compress it.

**Tech Stack:** Godot 4.7.2 (GDScript, GL Compatibility renderer, single-threaded web export), React 18 + zustand + vitest (frontend), Node scripts (build), Playwright (CI smoke only, isolated package), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-30-ember-minigame-design.md`

## Global Constraints

- Godot **4.7.2-stable**; web export with `variant/thread_support=false`; renderer `gl_compatibility`.
- The invite appears after **15 s** (`OFFER_AFTER_MS = 15_000`) of `streamStatus === 'streaming'`.
- Offered only when `emberGameEnabled && mascotEnabled` and the machine can run it. Default `emberGameEnabled = true`.
- **Every user gets it:** Windows (WebView2), macOS (WKWebView), Linux (WebKitGTK). Where WebGL 2 is missing or the build has no export, the invite never shows and Settings states the reason on screen.
- All UI and in-game text in **English** (the UI stays English until the next release).
- No new dependency in `frontend-react/`. Playwright lives only in `games/ember/tests/smoke/` (its own package).
- The export output is never committed (`frontend-react/public/games/ember/` is gitignored); a release must fail rather than ship without it.
- `postMessage` targets `window.location.origin` both ways, never `'*'`; each side checks the sender.
- Do not touch `useCallSession.ts`, `vad.ts`, the Rust audio pipeline, `mcp.json`. Never edit in `D:/cp-main` (Darius's running app). Work in `D:/cp-ember` on `feat/ember-minigame`.
- Commits: conventional messages ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  `Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa`,
  `Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>` (the DCO job in `ci.yml` checks the last one).
- This plan touches more than 3 files by design; Darius approved the file list by approving this plan (AGENTS.md "stop and ask").
- On Darius's machine Godot is `D:/tools/godot-4.7.2/Godot_v4.7.2-stable_win64_console.exe`. Every Godot command below assumes, in Git Bash:
  `export CINDERPAW_GODOT=/d/tools/godot-4.7.2/Godot_v4.7.2-stable_win64_console.exe`

## Review Focus

1. **The task ends while the panel is closed.** The round must end quietly: the game still reports its score (best updated), then the round is dropped; nothing is left mounted, and the next task starts a fresh round. Tested in Task 8 (hook) and Task 9 (panel cleanup).
2. **A flood of tool calls** (dozens in a second) must not flood the screen: live sparks are capped. Tested in Task 4 (`burst_size`) and Task 5 (world cap).
3. **The engine never starts** (no WebGL, a wasm error, a missing file): the panel must say so on screen within 15 s instead of spinning forever. Tested in Task 9.
4. **Switching chats mid-task** must not replay the old chat's tool calls as sparks or keep its round. Tested in Task 8 (session change) and Task 6 (`takeNewSparks` ignores calls before `since`).
5. **Keys while playing:** Space and arrows go to the game, not the composer; Esc closes from inside the game (focus in the iframe) and from outside it; focus returns to the composer. Tested in Task 5 (Esc sends `close`) and Task 9.

---

### Task 1: Godot project skeleton, the bridge, headless tests

**Files:**
- Create: `games/ember/project.godot`, `games/ember/main.tscn`, `games/ember/scripts/main.gd` (placeholder, replaced in Task 5), `games/ember/scripts/bridge.gd`, `games/ember/export_presets.cfg`, `games/ember/tests/run_tests.gd`, `games/ember/tests/test_bridge.gd`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `class_name Bridge` with signals `started(best: int)`, `spark(kind: String)`, `ended(ok: bool)`, `paused(on: bool)`; `static decode(text: String) -> Dictionary`, `static encode(msg: Dictionary) -> String`, `send(msg: Dictionary)` (also appends to `sent: Array[Dictionary]`, so headless tests can see what the game said), `receive(text: String)`. Test runner contract: a suite is a script `extends RefCounted` with `func run(t) -> void` calling `t.check(name: String, ok: bool)`; `t.root` is the SceneTree root.

- [ ] **Step 1: Create the project files**

`games/ember/project.godot`:
```ini
config_version=5

[application]
config/name="Cinderpaw Campfire"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")
boot_splash/show_image=false
boot_splash/bg_color=Color(0.141, 0.102, 0.086, 1)

[display]
window/size/viewport_width=800
window/size/viewport_height=240
window/stretch/mode="canvas_items"
window/stretch/aspect="expand"

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
```

`games/ember/main.tscn`:
```ini
[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]
[ext_resource type="Script" path="res://scripts/bridge.gd" id="2"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Bridge" type="Node" parent="."]
script = ExtResource("2")
```

`games/ember/export_presets.cfg` (the `head_include` hides Godot's loading logo and matches the game's night colour; ids checked against the 4.7.2 shell: `#status-splash`, `#canvas`):
```ini
[preset.0]

name="Web"
platform="Web"
runnable=true
export_filter="all_resources"
include_filter="*.json"
exclude_filter="tests/*"
export_path="../../frontend-react/public/games/ember/index.html"

[preset.0.options]

variant/extensions_support=false
variant/thread_support=false
html/export_icon=false
html/head_include="<style>body,#canvas{background:#241a16}#status-splash{display:none}</style>"
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
progressive_web_app/enabled=false
```

- [ ] **Step 2: Write the failing bridge tests**

`games/ember/tests/run_tests.gd`:
```gdscript
extends SceneTree
## Headless checks for the campfire game:
##   "$CINDERPAW_GODOT" --headless --path games/ember --import
##   "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd
## Prints PASS/FAIL per check; exits 1 when any check fails.

const SUITES := ["res://tests/test_bridge.gd"]
var failed := 0

func check(name: String, ok: bool) -> void:
	print(("PASS  " if ok else "FAIL  ") + name)
	if not ok:
		failed += 1

func _initialize() -> void:
	for path in SUITES:
		load(path).new().run(self)
	print("%d failed" % failed)
	quit(1 if failed > 0 else 0)
```

`games/ember/tests/test_bridge.gd`:
```gdscript
extends RefCounted

func run(t) -> void:
	t.check("bridge: a spark keeps a known kind", Bridge.decode('{"type":"spark","kind":"read"}') == {"type": "spark", "kind": "read"})
	t.check("bridge: a spark of an unknown kind becomes 'other'", Bridge.decode('{"type":"spark","kind":"laser"}')["kind"] == "other")
	t.check("bridge: start carries the best score", Bridge.decode('{"type":"start","best":42}')["best"] == 42)
	t.check("bridge: a negative or missing best is 0", Bridge.decode('{"type":"start","best":-5}')["best"] == 0 and Bridge.decode('{"type":"start"}')["best"] == 0)
	t.check("bridge: end is ok only when ok is true", Bridge.decode('{"type":"end","ok":true}')["ok"] == true and Bridge.decode('{"type":"end","ok":"yes"}')["ok"] == false)
	t.check("bridge: pause and resume pass through", Bridge.decode('{"type":"pause"}') == {"type": "pause"} and Bridge.decode('{"type":"resume"}') == {"type": "resume"})
	t.check("bridge: garbage decodes to nothing", Bridge.decode("not json") == {} and Bridge.decode('{"kind":"read"}') == {} and Bridge.decode("[1,2]") == {})
	t.check("bridge: encode is JSON the app can parse", JSON.parse_string(Bridge.encode({"type": "score", "value": 12})) == {"type": "score", "value": 12.0})
```

- [ ] **Step 3: Run the tests to see them fail**

Run:
```bash
cd /d/cp-ember && "$CINDERPAW_GODOT" --headless --path games/ember --import; "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd
```
Expected: errors that `res://scripts/main.gd` / `Bridge` do not exist; non-zero exit.

- [ ] **Step 4: Implement the bridge and the placeholder world**

`games/ember/scripts/bridge.gd`:
```gdscript
class_name Bridge
extends Node
## The only door between the game and the app: JSON strings over
## window.postMessage. `decode` and `encode` are pure so the headless tests
## hold them to the contract; the app's side is emberBridge.ts.

signal started(best: int)
signal spark(kind: String)
signal ended(ok: bool)
signal paused(on: bool)

const KINDS: Array[String] = ["search", "read", "build", "other"]

var _on_message_cb  # a JavaScriptObject; the browser drops a callback nobody holds
## Everything the game has said, in order: what the headless tests read.
var sent: Array[Dictionary] = []

static func decode(text: String) -> Dictionary:
	var msg = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY or typeof(msg.get("type")) != TYPE_STRING:
		return {}
	match msg["type"]:
		"start":
			var best = msg.get("best")
			return {"type": "start", "best": maxi(0, int(best)) if typeof(best) in [TYPE_INT, TYPE_FLOAT] else 0}
		"spark":
			var kind = msg.get("kind")
			return {"type": "spark", "kind": kind if kind in KINDS else "other"}
		"end":
			return {"type": "end", "ok": msg.get("ok") == true}
		"pause", "resume":
			return {"type": msg["type"]}
	return {}

static func encode(msg: Dictionary) -> String:
	return JSON.stringify(msg)

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_on_message_cb = JavaScriptBridge.create_callback(_on_message)
	JavaScriptBridge.get_interface("window").addEventListener("message", _on_message_cb)
	send({"type": "ready"})

func send(msg: Dictionary) -> void:
	sent.append(msg)
	if OS.has_feature("web"):
		# encode() gives JSON text; stringify it again to embed it as a JS string literal.
		JavaScriptBridge.eval("window.parent.postMessage(%s, window.location.origin)" % JSON.stringify(encode(msg)))

func _on_message(args: Array) -> void:
	var event = args[0]
	if str(event.origin) != str(JavaScriptBridge.eval("window.location.origin")):
		return
	receive(str(event.data))

func receive(text: String) -> void:
	var msg := decode(text)
	match msg.get("type", ""):
		"start":
			started.emit(msg["best"])
		"spark":
			spark.emit(msg["kind"])
		"end":
			ended.emit(msg["ok"])
		"pause":
			paused.emit(true)
		"resume":
			paused.emit(false)
```

`games/ember/scripts/main.gd` (placeholder so Task 3 can smoke-test the bridge; Task 5 replaces it):
```gdscript
extends Node2D
## Placeholder world: counts sparks and reports the count as the score.

var sparks := 0
@onready var bridge: Bridge = $Bridge

func _ready() -> void:
	bridge.spark.connect(func(_kind: String) -> void:
		sparks += 1
		queue_redraw())
	bridge.ended.connect(func(_ok: bool) -> void: bridge.send({"type": "score", "value": sparks}))

func _draw() -> void:
	draw_rect(Rect2(0, 0, 800, 240), Color("#241a16"))
	draw_circle(Vector2(70, 200), 12 + sparks * 2, Color("#F45B20"))
```

Append to `.gitignore`:
```gitignore
# Campfire mini-game: Godot's cache and the web export (built by src-tauri/scripts/build-game.mjs)
games/ember/.godot/
frontend-react/public/games/ember/
.tools/
```

- [ ] **Step 5: Run the tests to see them pass**

Run: same command as Step 3.
Expected: 8 `PASS` lines, `0 failed`, exit code 0.

- [ ] **Step 6: Commit**

```bash
cd /d/cp-ember && git add games/ember .gitignore && git commit -m "feat(ember): the campfire game's Godot project and its message bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The export script, wired into the Tauri build

**Files:**
- Create: `src-tauri/scripts/build-game.mjs`, `src-tauri/scripts/build-game.test.mjs`
- Modify: `src-tauri/tauri.conf.json:9-16` (`beforeDevCommand`, `beforeBuildCommand`)

**Interfaces:**
- Consumes: `games/ember/export_presets.cfg` preset `"Web"` (Task 1).
- Produces: exported files at `frontend-react/public/games/ember/index.html` (+ `.js`, `.wasm`, `.pck`, worklets). Exports `needsExport({srcMtime, outMtime, force})`, `findGodot(env, lookup)`, `newestMtime(dir)`, `GAME_DIR`, `OUT_DIR`.

- [ ] **Step 1: Write the failing tests**

`src-tauri/scripts/build-game.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsExport, findGodot, newestMtime } from './build-game.mjs';

test('exports when there is no export yet', () => assert.equal(needsExport({ srcMtime: 5, outMtime: 0 }), true));
test('exports when a source is newer than the export', () => assert.equal(needsExport({ srcMtime: 9, outMtime: 5 }), true));
test('skips an up-to-date export', () => assert.equal(needsExport({ srcMtime: 5, outMtime: 9 }), false));
test('force always exports', () => assert.equal(needsExport({ srcMtime: 1, outMtime: 9, force: true }), true));
test('CINDERPAW_GODOT wins over PATH, and a missing file is null', () => {
  assert.equal(findGodot({ CINDERPAW_GODOT: join(tmpdir(), 'no-such-godot.exe') }, () => '/usr/bin/godot'), null);
  assert.equal(findGodot({}, () => '/usr/bin/godot'), '/usr/bin/godot');
  assert.equal(findGodot({}, () => null), null);
});
test("newestMtime ignores Godot's cache and node_modules", () => {
  const d = mkdtempSync(join(tmpdir(), 'ember-'));
  writeFileSync(join(d, 'a.gd'), '');
  utimesSync(join(d, 'a.gd'), 100, 100);
  for (const skip of ['.godot', 'node_modules']) {
    mkdirSync(join(d, skip));
    writeFileSync(join(d, skip, 'f'), '');
    utimesSync(join(d, skip, 'f'), 999, 999);
  }
  assert.equal(newestMtime(d), 100_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /d/cp-ember && node --test src-tauri/scripts/build-game.test.mjs`
Expected: FAIL, `Cannot find module ... build-game.mjs`.

- [ ] **Step 3: Implement the script**

`src-tauri/scripts/build-game.mjs`:
```js
#!/usr/bin/env node
/**
 * build-game.mjs: export the campfire mini-game (games/ember, a Godot 4.7
 * project) to the web, into frontend-react/public/games/ember/, where Vite and
 * Tauri pick it up like any other static file.
 *
 * The game exists only where its export does. Without Godot this script says
 * so and exits 0: the app builds, finds no export, and never offers the game
 * (Settings says why). A Godot that is present but fails exits 1, because a
 * broken export must not ship quietly. Wired into tauri.conf.json's
 * beforeDevCommand / beforeBuildCommand next to build-sidecar.mjs.
 *
 * Godot: $CINDERPAW_GODOT, else `godot` on PATH. It needs the 4.7.2 web
 * templates; scripts/fetch-godot.py installs both.
 * Env: CINDERPAW_SKIP_GAME_BUILD=1 skips; CINDERPAW_FORCE_GAME_BUILD=1 always exports.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GAME_DIR = join(REPO_ROOT, 'games', 'ember');
export const OUT_DIR = join(REPO_ROOT, 'frontend-react', 'public', 'games', 'ember');

/** Newest modification time under `dir` in ms, skipping Godot's cache and node_modules. 0 when missing. */
export function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.godot' || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

export function needsExport({ srcMtime, outMtime, force }) {
  return Boolean(force) || outMtime === 0 || srcMtime > outMtime;
}

/** The Godot binary to use, or null. `lookup(name)` returns a path found on PATH, or null. */
export function findGodot(env, lookup) {
  if (env.CINDERPAW_GODOT) return existsSync(env.CINDERPAW_GODOT) ? env.CINDERPAW_GODOT : null;
  return lookup('godot');
}

function onPath(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

function godotRun(godot, args) {
  const r = spawnSync(godot, ['--headless', '--path', GAME_DIR, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[build-game] godot ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(1);
  }
}

function main() {
  if (process.env.CINDERPAW_SKIP_GAME_BUILD === '1') {
    console.log('[build-game] skipped (CINDERPAW_SKIP_GAME_BUILD=1).');
    return;
  }
  const index = join(OUT_DIR, 'index.html');
  const godot = findGodot(process.env, onPath);
  if (!godot) {
    if (process.env.CINDERPAW_GODOT) {
      console.error(`[build-game] CINDERPAW_GODOT points at ${process.env.CINDERPAW_GODOT}, which does not exist.`);
      process.exit(1);
    }
    console.log(existsSync(index)
      ? '[build-game] Godot not found; shipping the export already in frontend-react/public/games/ember.'
      : '[build-game] Godot not found (set CINDERPAW_GODOT or put godot on PATH): this build has no campfire game, and the app will not offer it.');
    return;
  }
  const outMtime = existsSync(index) ? statSync(index).mtimeMs : 0;
  const force = process.env.CINDERPAW_FORCE_GAME_BUILD === '1';
  if (!needsExport({ srcMtime: newestMtime(GAME_DIR), outMtime, force })) {
    console.log('[build-game] export is up to date.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  godotRun(godot, ['--import']);
  godotRun(godot, ['--export-release', 'Web', index]);
  console.log(`[build-game] exported to ${OUT_DIR}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

In `src-tauri/tauri.conf.json`, change the two scripts:
```json
    "beforeDevCommand": {
      "script": "node scripts/build-sidecar.mjs && node scripts/build-game.mjs && cd ../frontend-react && bun run dev",
      "cwd": "."
    },
    "beforeBuildCommand": {
      "script": "node scripts/build-sidecar.mjs && node scripts/build-game.mjs && cd ../frontend-react && npm run build",
      "cwd": "."
    }
```

- [ ] **Step 4: Run the tests, then the script both ways**

Run:
```bash
cd /d/cp-ember && node --test src-tauri/scripts/build-game.test.mjs
env -u CINDERPAW_GODOT PATH=/usr/bin:/bin node src-tauri/scripts/build-game.mjs
node src-tauri/scripts/build-game.mjs && ls -la frontend-react/public/games/ember
```
Expected: 6 tests pass; the second line prints `Godot not found (set CINDERPAW_GODOT ...)` and exits 0; the third exports `index.html`, `index.js`, `index.wasm` (~39.5 MB), `index.pck`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/scripts/build-game.mjs src-tauri/scripts/build-game.test.mjs src-tauri/tauri.conf.json && git commit -m "build(ember): export the campfire game with the app, and say so when Godot is missing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Smoke test in Chromium and WebKit (GATE)

This task decides whether "every user gets it" holds. If WebKit fails, **stop and report to Darius** before any further task.

**Files:**
- Create: `games/ember/tests/smoke/package.json`, `games/ember/tests/smoke/package-lock.json` (generated), `games/ember/tests/smoke/smoke.mjs`, `games/ember/tests/smoke/.gdignore` (empty: Godot must not import node_modules)

**Interfaces:**
- Consumes: an export directory (Task 2) and the bridge contract (Task 1).
- Produces: `node smoke.mjs <export-dir> <chromium|webkit>`: exit 0 and prints `<engine>: ready, score N`; writes `smoke-<engine>.png`.

- [ ] **Step 1: Create the package and install Playwright pinned**

```bash
cd /d/cp-ember/games/ember/tests/smoke && touch .gdignore && printf '%s\n' '{ "private": true, "type": "module" }' > package.json && npm install --save-dev --save-exact playwright@latest && npx playwright install chromium webkit
```
Expected: `package.json` gains an exact `playwright` version and a `package-lock.json` is written.

- [ ] **Step 2: Write the smoke script**

`games/ember/tests/smoke/smoke.mjs`:
```js
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
```

- [ ] **Step 3: Run it in both engines**

```bash
cd /d/cp-ember/games/ember/tests/smoke && node smoke.mjs ../../../../frontend-react/public/games/ember chromium && node smoke.mjs ../../../../frontend-react/public/games/ember webkit
```
Expected: `chromium: ready, score 3` and `webkit: ready, score 3`. Look at `smoke-webkit.png`: the night panel and a fire, not a blank frame.
If WebKit fails: stop here and report the error text and screenshot to Darius (the spec's promise of every user depends on it).

- [ ] **Step 4: Commit**

```bash
cd /d/cp-ember && printf 'smoke-*.png\nnode_modules/\n' > games/ember/tests/smoke/.gitignore && git add games/ember/tests/smoke && git commit -m "test(ember): the exported game answers in Chromium and in WebKit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The campfire's rules

**Files:**
- Create: `games/ember/scripts/rules.gd`, `games/ember/tests/test_rules.gd`
- Modify: `games/ember/tests/run_tests.gd` (`SUITES`)

**Interfaces:**
- Produces: `class_name Rules extends RefCounted`; consts `FIRE_START=10.0`, `FIRE_MIN=4.0`, `FIRE_MAX=100.0`, `SPARK_FEED=2.0`, `RAIN_DOUSE=3.0`, `STREAK_BONUS=8.0`, `STREAK_LEN=5`, `MAX_LIVE_SPARKS=40`, `BURST={"search":5,"read":4,"build":6,"other":3}`; vars `fire: float`, `streak: int`, `caught: int`; methods `burst_size(kind: String, live: int) -> int`, `catch_spark() -> bool` (true when it completed a streak), `miss_spark()`, `rain_on_fire()`, `score() -> int`.

- [ ] **Step 1: Write the failing tests**

`games/ember/tests/test_rules.gd`:
```gdscript
extends RefCounted

func run(t) -> void:
	var r := Rules.new()
	t.check("rules: a new fire starts at FIRE_START", r.score() == int(Rules.FIRE_START))
	r.catch_spark()
	t.check("rules: a catch feeds the fire", r.fire == Rules.FIRE_START + Rules.SPARK_FEED)
	r = Rules.new()
	var bonus := false
	for i in Rules.STREAK_LEN:
		bonus = r.catch_spark()
	t.check("rules: the fifth catch in a row is a bonus", bonus and r.fire == Rules.FIRE_START + Rules.STREAK_LEN * Rules.SPARK_FEED + Rules.STREAK_BONUS)
	r.catch_spark()
	r.miss_spark()
	t.check("rules: a missed spark breaks the streak", r.streak == 0)
	r = Rules.new()
	for i in 20:
		r.rain_on_fire()
	t.check("rules: rain never puts the fire out", r.fire == Rules.FIRE_MIN)
	for i in 200:
		r.catch_spark()
	t.check("rules: the fire has a ceiling", r.fire == Rules.FIRE_MAX)
	t.check("rules: bursts differ by kind", r.burst_size("build", 0) > r.burst_size("other", 0))
	t.check("rules: bursts never pass the live cap", r.burst_size("build", Rules.MAX_LIVE_SPARKS - 2) == 2 and r.burst_size("search", Rules.MAX_LIVE_SPARKS + 5) == 0)
	t.check("rules: an unknown kind still gets a small burst", r.burst_size("laser", 0) == 3)
```

In `games/ember/tests/run_tests.gd` set:
```gdscript
const SUITES := ["res://tests/test_bridge.gd", "res://tests/test_rules.gd"]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /d/cp-ember && "$CINDERPAW_GODOT" --headless --path games/ember --import; "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd`
Expected: parse error, `Rules` not declared.

- [ ] **Step 3: Implement the rules**

`games/ember/scripts/rules.gd`:
```gdscript
class_name Rules
extends RefCounted
## The campfire's arithmetic, with no nodes and no drawing, so a test can play
## a whole round in a loop. The fire is the score.

const FIRE_START := 10.0
const FIRE_MIN := 4.0
const FIRE_MAX := 100.0
const SPARK_FEED := 2.0
const RAIN_DOUSE := 3.0
const STREAK_BONUS := 8.0
const STREAK_LEN := 5
## A flood of tool calls must not flood the screen.
const MAX_LIVE_SPARKS := 40
const BURST := {"search": 5, "read": 4, "build": 6, "other": 3}

var fire := FIRE_START
var streak := 0
var caught := 0

func burst_size(kind: String, live: int) -> int:
	return clampi(BURST.get(kind, 3), 0, maxi(0, MAX_LIVE_SPARKS - live))

## Returns true when this catch completed a streak (the big flame).
func catch_spark() -> bool:
	caught += 1
	streak += 1
	fire = minf(FIRE_MAX, fire + SPARK_FEED)
	if streak % STREAK_LEN == 0:
		fire = minf(FIRE_MAX, fire + STREAK_BONUS)
		return true
	return false

func miss_spark() -> void:
	streak = 0

func rain_on_fire() -> void:
	fire = maxf(FIRE_MIN, fire - RAIN_DOUSE)

func score() -> int:
	return int(round(fire))
```

- [ ] **Step 4: Run the tests to see them pass**

Run: same as Step 2. Expected: all PASS, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add games/ember/scripts/rules.gd games/ember/tests && git commit -m "feat(ember): the campfire's rules: feed, streaks, rain, a cap on sparks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The world and Cinderpaw (flat drawing)

**Files:**
- Create: `games/ember/art/make_art.py`, `games/ember/art/cheer.png`, `games/ember/art/surprised.png` (+ the `.import` files Godot writes), `games/ember/scripts/cinderpaw.gd`, `games/ember/tests/test_world.gd`
- Modify: `games/ember/scripts/main.gd` (replace the placeholder), `games/ember/main.tscn`, `games/ember/tests/run_tests.gd` (`SUITES`)

**Interfaces:**
- Consumes: `Bridge` (Task 1), `Rules` (Task 4).
- Produces: `class_name Cinderpaw extends Node2D` with `const GROUND := 214.0`, `step(dt: float, input: Dictionary)`, `catches(p: Vector2) -> bool`, `flinch()`, vars `vel`, `stunned`, `squash`, `facing`; world (`main.gd`) with `start(best: int)`, `add_burst(kind: String)`, `end(ok: bool)`, `step(dt: float, input: Dictionary)`, `fire_radius() -> float`, vars `rules`, `rng`, `sparks: Array[Dictionary]` (`"p"`, `"v"`, `"kind"`), `drops: Array[Vector2]`, `running`, `ended`, `best`. Input dictionary keys: `left`, `right`, `jump` (bools), `mouse_x` (float, -1 when unused).

- [ ] **Step 1: Make the art**

`games/ember/art/make_art.py`:
```python
"""Cinderpaw's in-game drawings, cut from the character art Darius drew.

Crops each pose to its silhouette (plus a margin) and scales it to 192 px
high: art/cheer.png (arms out, the normal pose) and art/surprised.png (the
flinch in the rain).

usage: python games/ember/art/make_art.py
"""
import os
import numpy as np
from PIL import Image
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', '..', 'docs', 'design', 'moodboard', 'SVG')
POSES = {'cheer': 'e218d07c-9b9a-4a53-95ea-e28f32e5d7fb', 'surprised': '3fbfcb9f-c4c6-44eb-9b35-faaeaa59736f'}
HEIGHT = 192

for name, file in POSES.items():
    im = Image.open(os.path.join(SRC, file + '.png')).convert('RGBA')
    alpha = np.asarray(im)[..., 3] >= 128
    body = max(measure.regionprops(measure.label(alpha)), key=lambda p: p.area)  # the art has stray specks
    y0, x0, y1, x1 = body.bbox
    pad = 8 * (y1 - y0) // HEIGHT
    crop = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    crop.resize((round(crop.width * HEIGHT / crop.height), HEIGHT), Image.LANCZOS).save(os.path.join(HERE, name + '.png'))
    print(name, crop.size)
```
Run: `cd /d/cp-ember && python games/ember/art/make_art.py`
Expected: `cheer (995, 1211)` and a `surprised` line; `games/ember/art/cheer.png` is 158x192.

- [ ] **Step 2: Write the failing world tests**

`games/ember/tests/test_world.gd`:
```gdscript
extends RefCounted

func run(t) -> void:
	var main = load("res://main.tscn").instantiate()
	t.root.add_child(main)  # _ready runs; outside the web the Bridge stays quiet
	main.rng.seed = 7
	main.start(3)
	t.check("world: a started round is running", main.running and main.best == 3)
	main.add_burst("build")
	t.check("world: a build burst throws 6 sparks", main.sparks.size() == 6)
	var fire_before: float = main.rules.fire
	for i in 360:
		var chase: float = main.sparks[0]["p"].x if main.sparks.size() > 0 else -1.0
		main.step(1.0 / 60.0, {"mouse_x": chase})
	t.check("world: a spark reached by Cinderpaw feeds the fire", main.rules.caught >= 1 and main.rules.fire > fire_before)
	t.check("world: every spark is caught or has fallen", main.sparks.is_empty())
	main.end(true)
	t.check("world: the end stops the round and keeps the best", main.ended and not main.running and main.best >= 3)
	t.check("world: the end reports the score to the app", main.bridge.sent.back() == {"type": "score", "value": main.rules.score()})
	var esc := InputEventKey.new()
	esc.keycode = KEY_ESCAPE
	esc.pressed = true
	main._unhandled_input(esc)
	t.check("world: Esc inside the game asks the app to close it", main.bridge.sent.back() == {"type": "close"})
	main.add_burst("search")
	t.check("world: no sparks after the end", main.sparks.is_empty())
	main.start(0)
	for i in 50:
		main.add_burst("build")
	t.check("world: live sparks are capped", main.sparks.size() <= Rules.MAX_LIVE_SPARKS)
	main.cat.flinch()
	t.check("world: a flinch stuns Cinderpaw", main.cat.stunned > 0.0)
	main.queue_free()
```

In `games/ember/tests/run_tests.gd` set:
```gdscript
const SUITES := ["res://tests/test_bridge.gd", "res://tests/test_rules.gd", "res://tests/test_world.gd"]
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd /d/cp-ember && "$CINDERPAW_GODOT" --headless --path games/ember --import; "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd`
Expected: FAIL: the placeholder `main.gd` has no `rng`, `start`, `cat`.

- [ ] **Step 4: Implement Cinderpaw and the world**

`games/ember/scripts/cinderpaw.gd`:
```gdscript
class_name Cinderpaw
extends Node2D
## The player: hops while walking, jumps, catches with its paws out, flinches
## in the rain. Drawn from the character art (art/cheer.png); Task 10 swaps
## the flat drawing for a bone rig.

const GROUND := 214.0
const SPEED := 240.0
const HOP_V := -120.0
const JUMP_V := -320.0
const GRAVITY := 900.0
const MIN_X := 150.0
const MAX_X := 780.0
const CATCH_R := 30.0
const HEIGHT := 76.0

var vel := Vector2.ZERO
var stunned := 0.0
var squash := 1.0
var squash_v := 0.0
var facing := 1.0
var tex_normal: Texture2D = preload("res://art/cheer.png")
var tex_flinch: Texture2D = preload("res://art/surprised.png")

func step(dt: float, input: Dictionary) -> void:
	var dir := int(input.get("right", false)) - int(input.get("left", false))
	var mx: float = input.get("mouse_x", -1.0)
	if dir == 0 and mx >= 0.0 and absf(mx - position.x) > 8.0:
		dir = 1 if mx > position.x else -1
	if stunned > 0.0:
		stunned -= dt
		dir = 0
	if dir != 0:
		facing = float(dir)
	vel.x = dir * SPEED
	if position.y >= GROUND:
		if input.get("jump", false) and stunned <= 0.0:
			vel.y = JUMP_V
			squash = 0.8
		elif dir != 0:
			vel.y = HOP_V
	vel.y += GRAVITY * dt
	position += vel * dt
	if position.y > GROUND:
		squash = 0.75 if vel.y > 200.0 else minf(squash, 0.92)  # a hard landing squashes more
		position.y = GROUND
		vel.y = 0.0
	position.x = clampf(position.x, MIN_X, MAX_X)
	squash_v += (-(squash - 1.0) * 220.0 - squash_v * 14.0) * dt  # springs back with a little wobble
	squash += squash_v * dt
	queue_redraw()

func catches(p: Vector2) -> bool:
	return p.distance_to(position + Vector2(0, -HEIGHT * 0.7)) < CATCH_R

func flinch() -> void:
	stunned = 0.6
	squash = 1.2

func _draw() -> void:
	var tex := tex_flinch if stunned > 0.0 else tex_normal
	var w := HEIGHT * tex.get_width() / tex.get_height()
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(facing / sqrt(maxf(squash, 0.4)), squash))
	draw_texture_rect(tex, Rect2(-w / 2.0, -HEIGHT, w, HEIGHT), false)
```

`games/ember/scripts/main.gd` (replace the file):
```gdscript
extends Node2D
## One round of the campfire. Sparks come from the agent's tool calls through
## the Bridge, rain falls between bursts, Cinderpaw catches. Everything moves
## in `step(dt, input)`, so the headless tests play the world without a window.

const W := 800.0
const H := 240.0
const GROUND := Cinderpaw.GROUND
const FIRE_X := 70.0
const SPAWN_MIN_X := 150.0
const SPAWN_MAX_X := 780.0
const RAIN_GAP := Vector2(1.4, 3.0)
const RAIN_SPEED := 220.0
const COLORS := {"search": Color("#5E8BE0"), "read": Color("#F2B54A"), "build": Color("#F0506E"), "other": Color("#FF8A3D")}

var rules := Rules.new()
var rng := RandomNumberGenerator.new()
var sparks: Array[Dictionary] = []
var drops: Array[Vector2] = []
var rain_in := 2.0
var running := false
var ended := false
var ok := true
var best := 0
var flare := 0.0
var time := 0.0
var _mouse_x := -1.0
var _clicked := false

@onready var bridge: Bridge = $Bridge
@onready var cat: Cinderpaw = $Cinderpaw

func _ready() -> void:
	rng.randomize()
	bridge.started.connect(start)
	bridge.spark.connect(add_burst)
	bridge.ended.connect(end)
	bridge.paused.connect(func(on: bool) -> void: get_tree().paused = on)

func start(p_best: int) -> void:
	rules = Rules.new()
	sparks.clear()
	drops.clear()
	best = p_best
	running = true
	ended = false
	flare = 0.0

func add_burst(kind: String) -> void:
	if not running:
		return
	for i in rules.burst_size(kind, sparks.size()):
		sparks.append({
			"p": Vector2(rng.randf_range(SPAWN_MIN_X, SPAWN_MAX_X), -rng.randf_range(0.0, 80.0)),
			"v": Vector2(rng.randf_range(-25.0, 25.0), rng.randf_range(60.0, 110.0)),
			"kind": kind,
		})

func end(p_ok: bool) -> void:
	if ended:
		return
	running = false
	ended = true
	ok = p_ok
	sparks.clear()
	drops.clear()
	best = maxi(best, rules.score())
	bridge.send({"type": "score", "value": rules.score()})

func fire_radius() -> float:
	return 10.0 + rules.fire * 0.45

func step(dt: float, input: Dictionary) -> void:
	time += dt
	flare = maxf(0.0, flare - dt)
	cat.step(dt, input)
	for i in range(sparks.size() - 1, -1, -1):
		var s: Dictionary = sparks[i]
		s["p"] += s["v"] * dt
		if cat.catches(s["p"]):
			if rules.catch_spark():
				flare = 1.2
			sparks.remove_at(i)
		elif s["p"].y > GROUND:
			rules.miss_spark()
			sparks.remove_at(i)
	if running:
		rain_in -= dt
		if rain_in <= 0.0 and sparks.is_empty():  # rain falls between bursts, not during them
			rain_in = rng.randf_range(RAIN_GAP.x, RAIN_GAP.y)
			drops.append(Vector2(rng.randf_range(20.0, SPAWN_MAX_X), -10.0))
	for i in range(drops.size() - 1, -1, -1):
		drops[i].y += RAIN_SPEED * dt
		var d := drops[i]
		if absf(d.x - FIRE_X) < fire_radius() and d.y > GROUND - fire_radius() * 1.6:
			rules.rain_on_fire()
			drops.remove_at(i)
		elif cat.catches(d):
			cat.flinch()
			drops.remove_at(i)
		elif d.y > GROUND:
			drops.remove_at(i)

func _process(dt: float) -> void:
	step(dt, {
		"left": Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A),
		"right": Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D),
		"jump": _clicked or Input.is_key_pressed(KEY_SPACE) or Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W),
		"mouse_x": _mouse_x,
	})
	_clicked = false
	queue_redraw()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		_mouse_x = get_local_mouse_position().x
	elif event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_clicked = true
	elif event is InputEventKey and event.pressed:
		if event.keycode == KEY_ESCAPE:
			bridge.send({"type": "close"})  # focus is in the game, so the app cannot see this key
		elif event.keycode in [KEY_LEFT, KEY_RIGHT, KEY_A, KEY_D]:
			_mouse_x = -1.0  # the keys take over from the mouse

func _draw() -> void:
	draw_rect(Rect2(0, 0, W, H), Color("#241a16"))
	draw_rect(Rect2(0, GROUND, W, H - GROUND), Color("#3a2a22"))
	var r := fire_radius() * (1.0 + 0.06 * sin(time * 9.0)) + flare * 14.0
	if ended and not ok:
		r *= 0.6  # the agent stopped: the fire dims quietly, no losing screen
	draw_rect(Rect2(FIRE_X - 26, GROUND - 6, 52, 8), Color("#6B4A33"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.55), r, Color("#F45B20"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.45), r * 0.62, Color("#FFB347"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.35), r * 0.3, Color("#FFF1C1"))
	for s in sparks:
		draw_circle(s["p"], 4.0, COLORS[s["kind"]])
	for d in drops:
		draw_line(d, d + Vector2(0, 9), Color("#8FD0FF"), 2.0)
	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(W - 212, 26), "Fire %d   Best %d" % [rules.score(), maxi(best, rules.score())], HORIZONTAL_ALIGNMENT_RIGHT, 200, 16, Color("#F6EFE6"))
	if ended:
		var line := ("Your fire reached %d" if ok else "The agent stopped. Your fire: %d") % rules.score()
		draw_string(font, Vector2(0, 112), line, HORIZONTAL_ALIGNMENT_CENTER, W, 22, Color("#FFF1C1"))
		if ok:
			for i in 5:  # fireworks
				var k := fmod(time * 0.8 + i * 0.2, 1.0)
				var c := Vector2(FIRE_X + 90 + i * 130, 60 + (i % 2) * 30)
				var col: Color = COLORS.values()[i % 4]
				col.a = 1.0 - k
				draw_arc(c, 6 + k * 40, 0, TAU, 24, col, 2.0)
	elif not running:
		draw_string(font, Vector2(0, 120), "Waiting for the agent…", HORIZONTAL_ALIGNMENT_CENTER, W, 18, Color("#F6EFE6"))
```

`games/ember/main.tscn` (replace the file):
```ini
[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]
[ext_resource type="Script" path="res://scripts/bridge.gd" id="2"]
[ext_resource type="Script" path="res://scripts/cinderpaw.gd" id="3"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Bridge" type="Node" parent="."]
script = ExtResource("2")

[node name="Cinderpaw" type="Node2D" parent="."]
position = Vector2(420, 214)
script = ExtResource("3")
```

- [ ] **Step 5: Run the tests to see them pass**

Run: same as Step 3. Expected: all PASS, `0 failed`.

- [ ] **Step 6: Export and look at it**

```bash
cd /d/cp-ember && CINDERPAW_FORCE_GAME_BUILD=1 node src-tauri/scripts/build-game.mjs && cd games/ember/tests/smoke && node smoke.mjs ../../../../frontend-react/public/games/ember chromium
```
Expected: `chromium: ready, score N`. Open `smoke-chromium.png`: night sky, ground, fire at the left, Cinderpaw standing, three bursts of blue sparks falling.

- [ ] **Step 7: Commit**

```bash
cd /d/cp-ember && git add games/ember && git commit -m "feat(ember): Cinderpaw catches the agent's sparks and keeps the fire going

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The app's side of the contract

**Files:**
- Create: `frontend-react/src/components/chat/ember/emberBridge.ts`, `frontend-react/src/components/chat/ember/sparks.ts`, `frontend-react/src/components/chat/ember/__tests__/emberBridge.test.ts`, `frontend-react/src/components/chat/ember/__tests__/sparks.test.ts`

**Interfaces:**
- Consumes: `ToolCallEvent` from `@/stores/chat` (`kind: 'tool'` entries have `id`, `name`, `startedAt`).
- Produces: `type SparkKind = 'search' | 'read' | 'build' | 'other'`; `type ToGame`; `type FromGame = {type:'ready'} | {type:'score'; value:number} | {type:'close'}`; `sparkKindForTool(name: string): SparkKind`; `encode(m: ToGame): string`; `decode(data: unknown): FromGame | null`; `takeNewSparks(stream: readonly ToolCallEvent[], seen: Set<string>, since: number): SparkKind[]`.

- [ ] **Step 1: Install the worktree's frontend dependencies (first frontend task only)**

Run: `cd /d/cp-ember/frontend-react && bun install`
Expected: packages installed.

- [ ] **Step 2: Write the failing tests**

`frontend-react/src/components/chat/ember/__tests__/emberBridge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decode, encode, sparkKindForTool } from '../emberBridge';

describe('emberBridge', () => {
  it('sorts tools into spark kinds', () => {
    expect(sparkKindForTool('web_search')).toBe('search');
    expect(sparkKindForTool('read_url')).toBe('search');
    expect(sparkKindForTool('read_file')).toBe('read');
    expect(sparkKindForTool('grep')).toBe('read');
    expect(sparkKindForTool('shell_exec')).toBe('build');
    expect(sparkKindForTool('code-quality:run_tests')).toBe('build');
    expect(sparkKindForTool('calculator')).toBe('other');
    expect(sparkKindForTool('some_future_tool')).toBe('other');
  });

  it('decodes only what the game may say', () => {
    expect(decode('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(decode('{"type":"close"}')).toEqual({ type: 'close' });
    expect(decode('{"type":"score","value":12.6}')).toEqual({ type: 'score', value: 13 });
    expect(decode('{"type":"score","value":-4}')).toEqual({ type: 'score', value: 0 });
    expect(decode('{"type":"score","value":"lots"}')).toBeNull();
    expect(decode('{"type":"spark","kind":"read"}')).toBeNull();
    expect(decode('not json')).toBeNull();
    expect(decode({ type: 'ready' })).toBeNull();
  });

  it('encodes JSON text', () => {
    expect(JSON.parse(encode({ type: 'spark', kind: 'read' }))).toEqual({ type: 'spark', kind: 'read' });
  });
});
```

`frontend-react/src/components/chat/ember/__tests__/sparks.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { ToolCallEvent } from '@/stores/chat';
import { takeNewSparks } from '../sparks';

const tool = (id: string, name: string, startedAt: number): ToolCallEvent => ({
  id, kind: 'tool', name, emoji: '', mainArg: null, status: 'running', startedAt, endedAt: null,
});

describe('takeNewSparks', () => {
  it('throws one spark per new tool call, by kind', () => {
    expect(takeNewSparks([tool('a', 'web_search', 10), tool('b', 'read_file', 11)], new Set(), 0)).toEqual(['search', 'read']);
  });

  it('never throws the same call twice', () => {
    const seen = new Set<string>();
    const stream = [tool('a', 'web_search', 10)];
    takeNewSparks(stream, seen, 0);
    expect(takeNewSparks([...stream, tool('b', 'shell_exec', 12)], seen, 0)).toEqual(['build']);
  });

  it('ignores calls from before the panel opened', () => {
    expect(takeNewSparks([tool('old', 'web_search', 5), tool('new', 'grep', 20)], new Set(), 10)).toEqual(['read']);
  });

  it('ignores context entries', () => {
    const ctx = { id: 'c', kind: 'context', label: 'Compacting', startedAt: 20 } as ToolCallEvent;
    expect(takeNewSparks([ctx], new Set(), 0)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember`
Expected: FAIL, cannot resolve `../emberBridge` and `../sparks`.

- [ ] **Step 4: Implement**

`frontend-react/src/components/chat/ember/emberBridge.ts`:
```ts
/**
 * The app's side of the campfire game's message contract; the game's side is
 * games/ember/scripts/bridge.gd. Messages cross as JSON strings through
 * postMessage, addressed to this window's own origin.
 */
export type SparkKind = 'search' | 'read' | 'build' | 'other';

export type ToGame =
  | { type: 'start'; best: number }
  | { type: 'spark'; kind: SparkKind }
  | { type: 'end'; ok: boolean }
  | { type: 'pause' }
  | { type: 'resume' };

export type FromGame = { type: 'ready' } | { type: 'score'; value: number } | { type: 'close' };

// Grouped from the tools in mascot/emojiForTool.ts. A tool not listed is 'other':
// it still throws sparks, in the plain orange.
const SEARCH = new Set(['web_search', 'deep_research', 'read_url', 'read_webpage', 'fetch_url', 'http_request']);
const READ = new Set(['read_file', 'file_search', 'grep', 'read_skill', 'scan_workspace', 'git_status', 'git_diff', 'git_log']);
const BUILD = new Set(['edit_file', 'write_file', 'shell_exec', 'git_commit', 'git_branch']);

export function sparkKindForTool(name: string): SparkKind {
  if (SEARCH.has(name)) return 'search';
  if (READ.has(name)) return 'read';
  if (BUILD.has(name) || name.startsWith('code-quality:')) return 'build';
  return 'other';
}

export const encode = (m: ToGame): string => JSON.stringify(m);

export function decode(data: unknown): FromGame | null {
  if (typeof data !== 'string') return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const { type, value } = m as { type?: unknown; value?: unknown };
  if (type === 'ready' || type === 'close') return { type };
  if (type === 'score' && typeof value === 'number' && Number.isFinite(value)) {
    return { type: 'score', value: Math.max(0, Math.round(value)) };
  }
  return null;
}
```

`frontend-react/src/components/chat/ember/sparks.ts`:
```ts
import type { ToolCallEvent } from '@/stores/chat';
import { sparkKindForTool, type SparkKind } from './emberBridge';

/** The sparks owed for tool calls not thrown yet: tool entries only, each id
 *  once, and only calls that started after `since` (when the panel opened). */
export function takeNewSparks(stream: readonly ToolCallEvent[], seen: Set<string>, since: number): SparkKind[] {
  const out: SparkKind[] = [];
  for (const e of stream) {
    if (e.kind !== 'tool' || seen.has(e.id) || e.startedAt < since) continue;
    seen.add(e.id);
    out.push(sparkKindForTool(e.name));
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd /d/cp-ember && git add frontend-react/src/components/chat/ember && git commit -m "feat(ember): the app's side of the game's messages, and a spark per tool call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The setting, the best score, and "can this machine run it"

**Files:**
- Create: `frontend-react/src/components/chat/ember/emberAvailability.ts`, `frontend-react/src/components/chat/ember/__tests__/emberAvailability.test.ts`
- Modify: `frontend-react/src/stores/ui.ts` (interface next to `mascotEnabled` ~line 101; defaults next to `setMascotEnabled` ~line 228; `partialize` next to `mascotEnabled` ~line 268), `frontend-react/src/stores/__tests__/ui.test.ts`, `frontend-react/src/components/settings/AppearanceTab.tsx` (after the Mascot switch ~line 214), `frontend-react/src/components/settings/__tests__/AppearanceTab.test.tsx`

**Interfaces:**
- Produces: `useUI` fields `emberGameEnabled: boolean` (default `true`), `setEmberGameEnabled(v: boolean)`, `emberBest: number` (default `0`), `recordEmberScore(score: number)` (keeps the max); both persisted. `GAME_URL = '/games/ember/index.html'`; `type EmberAvailability = {ok:true} | {ok:false; reason:string}`; `hasWebGL2(doc?: Document): boolean`; `emberAvailability(): Promise<EmberAvailability>` (asked once per launch); `resetEmberAvailability()` (tests).

- [ ] **Step 1: Write the failing tests**

`frontend-react/src/components/chat/ember/__tests__/emberAvailability.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emberAvailability, hasWebGL2, resetEmberAvailability } from '../emberAvailability';

const fakeGl = { getExtension: () => ({ loseContext: () => {} }) };

describe('emberAvailability', () => {
  beforeEach(() => resetEmberAvailability());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('reads WebGL 2 from a canvas', () => {
    const doc = (gl: unknown) => ({ createElement: () => ({ getContext: () => gl }) }) as unknown as Document;
    expect(hasWebGL2(doc(fakeGl))).toBe(true);
    expect(hasWebGL2(doc(null))).toBe(false);
  });

  it('is off, with a reason on screen, without WebGL 2', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(await emberAvailability()).toEqual({ ok: false, reason: expect.stringMatching(/WebGL 2/) });
  });

  it('is off, with a reason on screen, when this build has no game', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGl as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await emberAvailability()).toEqual({ ok: false, reason: expect.stringMatching(/without the game/) });
  });

  it('is on with WebGL 2 and the export present, and asks only once', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeGl as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    expect(await emberAvailability()).toEqual({ ok: true });
    await emberAvailability();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

Append to the end of `frontend-react/src/stores/__tests__/ui.test.ts` (it already imports `describe`, `it`, `expect` and `useUI`):
```ts
describe('useUI: the campfire game', () => {
  it('is offered by default, and its best score only goes up', () => {
    expect(useUI.getState().emberGameEnabled).toBe(true);
    useUI.getState().recordEmberScore(30);
    useUI.getState().recordEmberScore(12);
    expect(useUI.getState().emberBest).toBe(30);
  });

  it('keeps its setting and best score across launches', () => {
    const saved = useUI.persist.getOptions().partialize!(useUI.getState()) as Record<string, unknown>;
    expect(saved).toHaveProperty('emberGameEnabled');
    expect(saved).toHaveProperty('emberBest');
  });
});
```

In `frontend-react/src/components/settings/__tests__/AppearanceTab.test.tsx` (it already imports `vi`, `render`, `screen`, `waitFor`, `userEvent`, `useUI`, and mocks `@/lib/tauri` with `get = tauri.settings.get`), add after the existing `vi.mock('@/lib/tauri', ...)` block:
```tsx
vi.mock('@/components/chat/ember/emberAvailability', () => ({
  emberAvailability: vi.fn(() => Promise.resolve({ ok: true })),
}));
import { emberAvailability } from '@/components/chat/ember/emberAvailability';
```
and at the end of the file:
```tsx
describe('AppearanceTab: campfire game', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({});
  });

  test('turns the switch off and says why on a machine that cannot run the game', async () => {
    vi.mocked(emberAvailability).mockResolvedValueOnce({ ok: false, reason: "This computer's graphics don't support WebGL 2, which the game needs." });
    render(<AppearanceTab />);
    const sw = await screen.findByRole('switch', { name: /campfire game/i });
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.getByText(/WebGL 2/)).toBeInTheDocument();
  });

  test('the switch turns the game on and off', async () => {
    render(<AppearanceTab />);
    const sw = await screen.findByRole('switch', { name: /campfire game/i });
    const before = useUI.getState().emberGameEnabled;
    await userEvent.click(sw);
    expect(useUI.getState().emberGameEnabled).toBe(!before);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember src/stores/__tests__/ui.test.ts src/components/settings/__tests__/AppearanceTab.test.tsx`
Expected: FAIL: missing module and missing store fields.

- [ ] **Step 3: Implement**

`frontend-react/src/components/chat/ember/emberAvailability.ts`:
```ts
/**
 * Whether this machine can run the campfire game, asked once per launch: the
 * game's export shipped with this build, and the graphics speak WebGL 2. When
 * it cannot, `reason` is what Settings shows, so nobody has to wonder where
 * the game went.
 */
export type EmberAvailability = { ok: true } | { ok: false; reason: string };

export const GAME_URL = '/games/ember/index.html';

export function hasWebGL2(doc: Document = document): boolean {
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    (gl as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

let cached: Promise<EmberAvailability> | null = null;

export function emberAvailability(): Promise<EmberAvailability> {
  cached ??= (async (): Promise<EmberAvailability> => {
    if (!hasWebGL2()) return { ok: false, reason: "This computer's graphics don't support WebGL 2, which the game needs." };
    try {
      const res = await fetch(GAME_URL);
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      return { ok: false, reason: 'This build of Cinderpaw was made without the game.' };
    }
    return { ok: true };
  })();
  return cached;
}

/** Tests only: forget the answer so the next call asks again. */
export function resetEmberAvailability(): void {
  cached = null;
}
```

In `frontend-react/src/stores/ui.ts`, after the `setMascotEnabled: (v: boolean) => void;` line of the interface:
```ts
  /** The campfire mini-game's icon during long tasks. On by default: it is
   *  only an icon, and nothing opens unless it is clicked. */
  emberGameEnabled: boolean;
  setEmberGameEnabled: (v: boolean) => void;
  /** The biggest fire this person has kept going. */
  emberBest: number;
  recordEmberScore: (score: number) => void;
```
after `setMascotEnabled: (mascotEnabled) => set({ mascotEnabled }),` in the defaults:
```ts
      emberGameEnabled: true,
      setEmberGameEnabled: (emberGameEnabled) => set({ emberGameEnabled }),
      emberBest: 0,
      recordEmberScore: (score) => set((s) => (score > s.emberBest ? { emberBest: score } : {})),
```
and after `mascotEnabled: s.mascotEnabled,` in `partialize`:
```ts
        emberGameEnabled: s.emberGameEnabled,
        emberBest: s.emberBest,
```

In `frontend-react/src/components/settings/AppearanceTab.tsx` (it already imports `useEffect` and `useState` from React), add the import:
```tsx
import { emberAvailability } from '@/components/chat/ember/emberAvailability';
```
next to the mascot selectors:
```tsx
  const emberGameEnabled    = useUI((s) => s.emberGameEnabled);
  const setEmberGameEnabled = useUI((s) => s.setEmberGameEnabled);
  const [emberBlocked, setEmberBlocked] = useState<string | null>(null);
  useEffect(() => {
    void emberAvailability().then((a) => setEmberBlocked(a.ok ? null : a.reason));
  }, []);
```
and right after the Mascot switch's closing `</div>`:
```tsx
      <div className="flex max-w-[616px] items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">Campfire game</p>
          <p className="text-xs text-text-muted mt-0.5">
            {emberBlocked ?? 'A small game Cinderpaw offers while the agent works on a long task'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={emberGameEnabled && !emberBlocked}
          aria-label="Toggle campfire game"
          disabled={!!emberBlocked}
          onClick={() => setEmberGameEnabled(!emberGameEnabled)}
          className={cn(
            'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            emberGameEnabled && !emberBlocked ? 'bg-brand hover:bg-brand-hover' : 'bg-border-default hover:bg-bg-hover',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
              emberGameEnabled && !emberBlocked ? 'translate-x-[18px]' : 'translate-x-[2px]',
            )}
          />
        </button>
      </div>
```

- [ ] **Step 4: Run the tests to see them pass**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /d/cp-ember && git add frontend-react/src && git commit -m "feat(ember): a Settings switch for the campfire game, and why it is off when it must be

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: When to offer the game, and the life of a round

**Files:**
- Create: `frontend-react/src/components/chat/ember/useEmberRun.ts`, `frontend-react/src/components/chat/ember/__tests__/useEmberRun.test.ts`

**Interfaces:**
- Consumes: `useChat` (`streamStatus`, `sessionId`), `useUI` (`emberGameEnabled`, `mascotEnabled`), `emberAvailability()` (Task 7).
- Produces: `OFFER_AFTER_MS = 15_000`; `interface EmberRound { since: number; ended: { ok: boolean } | null }`; `interface EmberRun { offered: boolean; open: boolean; round: EmberRound | null; openPanel(): void; closePanel(): void }`; `useEmberRun(): EmberRun`.

- [ ] **Step 1: Write the failing tests**

`frontend-react/src/components/chat/ember/__tests__/useEmberRun.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../emberAvailability', () => ({ emberAvailability: vi.fn(() => Promise.resolve({ ok: true })) }));

import { useEmberRun, OFFER_AFTER_MS } from '../useEmberRun';
import { emberAvailability } from '../emberAvailability';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';

async function mount() {
  const hook = renderHook(() => useEmberRun());
  await act(async () => {});  // the availability answer arrives
  return hook;
}

function runFor(ms: number) {
  act(() => useChat.setState({ streamStatus: 'streaming' }));
  act(() => { vi.advanceTimersByTime(ms); });
}

describe('useEmberRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChat.setState({ streamStatus: 'idle', sessionId: 's1' });
    useUI.setState({ emberGameEnabled: true, mascotEnabled: true });
  });
  afterEach(() => vi.useRealTimers());

  it('offers the game only once a task has run for 15 s', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS - 1);
    expect(result.current.offered).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.offered).toBe(true);
  });

  it('never offers it when the setting or the mascot is off', async () => {
    useUI.setState({ emberGameEnabled: false });
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    expect(result.current.offered).toBe(false);
    act(() => useUI.setState({ emberGameEnabled: true, mascotEnabled: false }));
    expect(result.current.offered).toBe(false);
  });

  it('never offers it on a machine that cannot run it', async () => {
    vi.mocked(emberAvailability).mockResolvedValueOnce({ ok: false, reason: 'no WebGL 2' });
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    expect(result.current.offered).toBe(false);
  });

  it('stops offering when the task ends', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => useChat.setState({ streamStatus: 'done' }));
    expect(result.current.offered).toBe(false);
  });

  it('keeps a round through closing the panel, and ends it with the task', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    const since = result.current.round?.since;
    act(() => result.current.closePanel());
    expect(result.current.round).toEqual({ since, ended: null });
    expect(result.current.offered).toBe(true);
    act(() => result.current.openPanel());
    expect(result.current.round?.since).toBe(since);
    act(() => useChat.setState({ streamStatus: 'done' }));
    expect(result.current.round?.ended).toEqual({ ok: true });
  });

  it('ends a round as not ok on an error, and drops it when closed after the end', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    act(() => useChat.setState({ streamStatus: 'error' }));
    expect(result.current.round?.ended).toEqual({ ok: false });
    act(() => result.current.closePanel());
    expect(result.current.round).toBeNull();
  });

  it('abandons the round when the person switches chats', async () => {
    const { result } = await mount();
    runFor(OFFER_AFTER_MS);
    act(() => result.current.openPanel());
    act(() => useChat.setState({ sessionId: 's2' }));
    expect(result.current.round).toBeNull();
    expect(result.current.open).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember/__tests__/useEmberRun.test.ts`
Expected: FAIL, cannot resolve `../useEmberRun`.

- [ ] **Step 3: Implement**

`frontend-react/src/components/chat/ember/useEmberRun.ts`:
```ts
import { useEffect, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { emberAvailability } from './emberAvailability';

/** How long a task must have been running before the campfire is offered. */
export const OFFER_AFTER_MS = 15_000;

export interface EmberRound {
  /** When the panel first opened: only tool calls from then on throw sparks. */
  since: number;
  /** Set once the task finishes; `ok` is false for an error or a stop. */
  ended: { ok: boolean } | null;
}

export interface EmberRun {
  /** Show the campfire icon. */
  offered: boolean;
  /** The panel is on screen. */
  open: boolean;
  /** The game is loaded (visible or paused behind a closed panel). */
  round: EmberRound | null;
  openPanel: () => void;
  closePanel: () => void;
}

export function useEmberRun(): EmberRun {
  const status = useChat((s) => s.streamStatus);
  const sessionId = useChat((s) => s.sessionId);
  const enabled = useUI((s) => s.emberGameEnabled && s.mascotEnabled);
  const [available, setAvailable] = useState(false);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [due, setDue] = useState(false);
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState<EmberRound | null>(null);

  useEffect(() => {
    let live = true;
    void emberAvailability().then((a) => { if (live) setAvailable(a.ok); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (status === 'streaming') {
      setRunStart((t) => t ?? Date.now());
      return;
    }
    setRunStart(null);
    setRound((r) => (r && !r.ended ? { ...r, ended: { ok: status === 'done' } } : r));
  }, [status]);

  useEffect(() => {
    setDue(false);
    if (runStart === null) return;
    const id = setTimeout(() => setDue(true), Math.max(0, runStart + OFFER_AFTER_MS - Date.now()));
    return () => clearTimeout(id);
  }, [runStart]);

  // Another chat is another task: its round is not this one.
  useEffect(() => {
    setOpen(false);
    setRound(null);
  }, [sessionId]);

  return {
    offered: due && enabled && available && !open,
    open,
    round,
    openPanel: () => {
      setRound((r) => r ?? { since: Date.now(), ended: null });
      setOpen(true);
    },
    closePanel: () => {
      setOpen(false);
      setRound((r) => (r?.ended ? null : r));
    },
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: same as Step 2. Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /d/cp-ember && git add frontend-react/src/components/chat/ember && git commit -m "feat(ember): offer the game 15 s into a task, and keep one round per task

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The campfire icon, the panel, and their place in the composer

**Files:**
- Create: `frontend-react/src/components/chat/ember/EmberInvite.tsx`, `frontend-react/src/components/chat/ember/EmberPanel.tsx`, `frontend-react/src/components/chat/ember/ember.css`, `frontend-react/src/components/chat/ember/__tests__/EmberInvite.test.tsx`, `frontend-react/src/components/chat/ember/__tests__/EmberPanel.test.tsx`
- Modify: `frontend-react/src/components/chat/ChatInput.tsx` (imports; `useEmberRun()` beside `useMascotState` ~line 452; the panel inside the root `<div>` before the pill ~line 651; the invite right after `<MascotPerch baseState={mascotState} />` ~line 678)

**Interfaces:**
- Consumes: `EmberRun` (Task 8), `encode`/`decode`/`ToGame` (Task 6), `takeNewSparks` (Task 6), `GAME_URL` (Task 7), `useUI` `emberBest`/`recordEmberScore` (Task 7), `useChat` `toolCallStream`.
- Produces: `<EmberInvite run={EmberRun} />`, `<EmberPanel run={EmberRun} onClosed?={() => void} />`, `READY_TIMEOUT_MS = 15_000`.

- [ ] **Step 1: Check the icon library and jest-dom are available**

Run: `cd /d/cp-ember/frontend-react && grep -n '"lucide-react"' package.json && grep -rn "jest-dom" vitest.config.* src/test* 2>/dev/null | head -3`
Expected: `lucide-react` is a dependency and jest-dom matchers are set up. If `lucide-react` is missing, draw the close button's X as an inline SVG instead of importing `X`.

- [ ] **Step 2: Write the failing tests**

`frontend-react/src/components/chat/ember/__tests__/EmberInvite.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmberInvite } from '../EmberInvite';
import type { EmberRun } from '../useEmberRun';

const runOf = (over: Partial<EmberRun> = {}): EmberRun => ({
  offered: false, open: false, round: null, openPanel: vi.fn(), closePanel: vi.fn(), ...over,
});

describe('EmberInvite', () => {
  it('is absent until the game is offered', () => {
    const { container } = render(<EmberInvite run={runOf()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the panel when clicked', () => {
    const run = runOf({ offered: true });
    render(<EmberInvite run={run} />);
    fireEvent.click(screen.getByRole('button', { name: /campfire game/i }));
    expect(run.openPanel).toHaveBeenCalledTimes(1);
  });
});
```

`frontend-react/src/components/chat/ember/__tests__/EmberPanel.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EmberPanel, READY_TIMEOUT_MS } from '../EmberPanel';
import type { EmberRun } from '../useEmberRun';
import { useChat, type ToolCallEvent } from '@/stores/chat';
import { useUI } from '@/stores/ui';

const runOf = (over: Partial<EmberRun> = {}): EmberRun => ({
  offered: false, open: true, round: { since: 0, ended: null }, openPanel: vi.fn(), closePanel: vi.fn(), ...over,
});
const frame = () => screen.getByTitle("Cinderpaw's campfire") as HTMLIFrameElement;
function fromGame(msg: object, source: MessageEventSource | null = frame().contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg), source, origin: window.location.origin }));
  });
}
const tool = (id: string, name: string): ToolCallEvent => ({
  id, kind: 'tool', name, emoji: '', mainArg: null, status: 'running', startedAt: 10, endedAt: null,
});

describe('EmberPanel', () => {
  beforeEach(() => {
    useChat.setState({ toolCallStream: [] });
    useUI.setState({ emberBest: 17 });
  });
  afterEach(() => vi.useRealTimers());

  it('shows nothing without a round', () => {
    const { container } = render(<EmberPanel run={runOf({ round: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads the game and starts it with the best score once it is ready', () => {
    render(<EmberPanel run={runOf()} />);
    expect(frame().getAttribute('src')).toBe('/games/ember/index.html');
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    fromGame({ type: 'ready' });
    expect(post).toHaveBeenCalledWith(JSON.stringify({ type: 'start', best: 17 }), window.location.origin);
  });

  it('throws a spark for each new tool call', () => {
    render(<EmberPanel run={runOf()} />);
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    fromGame({ type: 'ready' });
    act(() => useChat.setState({ toolCallStream: [tool('a', 'web_search')] }));
    expect(post).toHaveBeenCalledWith(JSON.stringify({ type: 'spark', kind: 'search' }), window.location.origin);
  });

  it('says so on screen when the engine never starts', () => {
    vi.useFakeTimers();
    render(<EmberPanel run={runOf()} />);
    act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS); });
    expect(screen.getByRole('alert')).toHaveTextContent("didn't start");
  });

  it('closes on Escape outside the game and on the game\'s own close', () => {
    const run = runOf();
    const onClosed = vi.fn();
    render(<EmberPanel run={run} onClosed={onClosed} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /close the game/i }), { key: 'Escape' });
    expect(run.closePanel).toHaveBeenCalledTimes(1);
    fromGame({ type: 'close' });
    expect(run.closePanel).toHaveBeenCalledTimes(2);
    expect(onClosed).toHaveBeenCalledTimes(2);
  });

  it('records the final score', () => {
    render(<EmberPanel run={runOf({ round: { since: 0, ended: { ok: true } } })} />);
    fromGame({ type: 'ready' });
    fromGame({ type: 'score', value: 40 });
    expect(useUI.getState().emberBest).toBe(40);
  });

  it('ignores messages that do not come from its own game', () => {
    const run = runOf();
    render(<EmberPanel run={run} />);
    fromGame({ type: 'close' }, window);
    expect(run.closePanel).not.toHaveBeenCalled();
  });

  it('lets a finished round go when its panel is closed', () => {
    const run = runOf({ open: false, round: { since: 0, ended: { ok: true } } });
    render(<EmberPanel run={run} />);
    expect(run.closePanel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember`
Expected: FAIL, cannot resolve `../EmberInvite` and `../EmberPanel`.

- [ ] **Step 4: Implement**

`frontend-react/src/components/chat/ember/ember.css`:
```css
/* The campfire icon flickers; someone who asked for less motion gets a still fire. */
.ember-flame {
  transform-box: view-box;
  transform-origin: 14px 21px;
}
@media (prefers-reduced-motion: no-preference) {
  .ember-flame { animation: ember-flicker 1.3s ease-in-out infinite; }
}
@keyframes ember-flicker {
  0%, 100% { transform: scale(1, 1) skewX(0deg); }
  30% { transform: scale(0.94, 1.06) skewX(-3deg); }
  60% { transform: scale(1.04, 0.96) skewX(2deg); }
}
```

`frontend-react/src/components/chat/ember/EmberInvite.tsx`:
```tsx
import './ember.css';
import type { EmberRun } from './useEmberRun';

/** A small campfire on the composer's edge, only while a long task runs. No
 *  text and no popup: whoever does not want the game never has to notice it. */
export function EmberInvite({ run }: { run: EmberRun }) {
  if (!run.offered) return null;
  return (
    <button
      type="button"
      onClick={run.openPanel}
      aria-label="Play the campfire game while Cinderpaw works"
      title="Play while Cinderpaw works"
      className="absolute -top-7 right-5 z-10 grid h-7 w-7 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-brand"
    >
      <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
        <path d="M5 23 L23 19 M5 19 L23 23" stroke="#6B4A33" strokeWidth="3" strokeLinecap="round" />
        <g className="ember-flame">
          <path d="M14 3 C18 8 21 11 21 15 C21 19 18 21 14 21 C10 21 7 19 7 15 C7 12 9 10 11 8 C11 11 12 12 13 12 C13 9 13 6 14 3 Z" fill="#F45B20" />
          <path d="M14 10 C16 13 17 14 17 16 C17 18 15.6 19 14 19 C12.4 19 11 18 11 16 C11 14.5 12 13.5 13 12.5 C13.2 13.6 13.6 14 14 14 C14 12.5 13.8 11.5 14 10 Z" fill="#FFC53D" />
        </g>
      </svg>
    </button>
  );
}
```

`frontend-react/src/components/chat/ember/EmberPanel.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { decode, encode, type ToGame } from './emberBridge';
import { GAME_URL } from './emberAvailability';
import { takeNewSparks } from './sparks';
import type { EmberRun } from './useEmberRun';

/** How long the engine gets to say `ready` before the panel says it failed. */
export const READY_TIMEOUT_MS = 15_000;

/** The game above the composer. It stays loaded while its panel is closed
 *  (paused), so reopening during the same task resumes the same round. */
export function EmberPanel({ run, onClosed }: { run: EmberRun; onClosed?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const seen = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const stream = useChat((s) => s.toolCallStream);
  const recordScore = useUI((s) => s.recordEmberScore);
  const round = run.round;

  const post = (m: ToGame) => frame.current?.contentWindow?.postMessage(encode(m), window.location.origin);
  const close = () => {
    run.closePanel();
    onClosed?.();
  };

  // A new round starts clean.
  useEffect(() => {
    seen.current = new Set();
    setReady(false);
    setFailed(false);
    setScore(null);
  }, [round?.since]);

  useEffect(() => {
    if (!round) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const m = decode(e.data);
      if (m?.type === 'ready') {
        setReady(true);
        post({ type: 'start', best: useUI.getState().emberBest });
      } else if (m?.type === 'score') {
        setScore(m.value);
        recordScore(m.value);
      } else if (m?.type === 'close') {
        close();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [round?.since]);

  useEffect(() => {
    if (!round || ready) return;
    const id = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [round?.since, ready]);

  useEffect(() => {
    if (!ready || !round || round.ended) return;
    for (const kind of takeNewSparks(stream, seen.current, round.since)) post({ type: 'spark', kind });
  }, [stream, ready, round]);

  useEffect(() => {
    if (ready && round?.ended) post({ type: 'end', ok: round.ended.ok });
  }, [ready, round?.ended]);

  useEffect(() => {
    if (!ready) return;
    post({ type: run.open ? 'resume' : 'pause' });
    if (run.open) frame.current?.focus();
  }, [run.open, ready]);

  // A round that ended behind a closed panel has nobody watching: keep its
  // score if the game answers, then let it go.
  useEffect(() => {
    if (!round?.ended || run.open) return;
    if (score !== null || !ready) {
      run.closePanel();
      return;
    }
    const id = setTimeout(run.closePanel, 3000);
    return () => clearTimeout(id);
  }, [round?.ended, run.open, score, ready]);

  if (!round) return null;
  return (
    <div
      hidden={!run.open}
      className="relative mb-2 overflow-hidden rounded-2xl border border-border-default bg-[#241a16]"
      style={{ height: 'clamp(160px, 25vh, 260px)' }}
      onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
    >
      <iframe ref={frame} src={GAME_URL} title="Cinderpaw's campfire" className="block h-full w-full border-0" />
      {!ready && !failed && (
        <p className="absolute inset-0 grid place-items-center text-sm text-[#F6EFE6]/80">Lighting the campfire…</p>
      )}
      {failed && (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-[#241a16] p-4 text-center text-sm text-[#F6EFE6]">
          The game didn't start on this computer. The chat works as usual.
        </div>
      )}
      {round.ended && (
        <div className="absolute inset-x-0 bottom-0 flex justify-end p-3">
          <button type="button" onClick={close} className="rounded-full bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
            Back to the answer
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label="Close the game"
        onClick={close}
        className="absolute right-2 top-2 rounded-full p-1 text-[#F6EFE6]/80 hover:bg-white/10"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
```

In `frontend-react/src/components/chat/ChatInput.tsx`:
- imports, next to `import { useMascotState } from './mascot/useMascotState';`:
```tsx
import { useEmberRun } from './ember/useEmberRun';
import { EmberInvite } from './ember/EmberInvite';
import { EmberPanel } from './ember/EmberPanel';
```
- right after the `const mascotState = useMascotState({ ... });` statement:
```tsx
  const ember = useEmberRun();
```
- first child of the root `<div className={cn('px-4 py-3 mx-auto w-full', ...)}>`, before the pill `<div`:
```tsx
        <EmberPanel run={ember} onClosed={() => taRef.current?.focus()} />
```
- right after `<MascotPerch baseState={mascotState} />`:
```tsx
          <EmberInvite run={ember} />
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd /d/cp-ember/frontend-react && bunx vitest run src/components/chat/ember src/components/chat/__tests__ && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /d/cp-ember && git add frontend-react/src && git commit -m "feat(ember): the campfire icon on the composer and the game panel above it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Cinderpaw's bone rig in the game

**Files:**
- Create: `games/ember/rig/build_rig.py`, `games/ember/rig/rig.json` (generated, committed), `games/ember/scripts/rig.gd`, `games/ember/tests/test_rig.gd`
- Modify: `games/ember/scripts/cinderpaw.gd`, `games/ember/tests/run_tests.gd` (`SUITES`)

**Interfaces:**
- Consumes: `art/cheer.png` (158x192, Task 5), `Cinderpaw` (Task 5).
- Produces: `rig.json` `{size:[w,h], points:[[x,y]...], internal:int, triangles:[[i,j,k]...], bones:[{name,parent,head:[x,y],tail:[x,y],weights:[...]}]}`; `class_name Rig extends Node2D` with `bones: Dictionary`, `build(data: Dictionary, texture: Texture2D, height: float)`, `bend(bone: String, degrees: float)`.

- [ ] **Step 1: Confirm Godot 4.7.2 has the skinning API (AGENTS.md: never guess an API)**

```bash
cd /d/cp-ember && printf 'extends SceneTree\nfunc _initialize():\n\tfor m in [["Polygon2D","add_bone"],["Polygon2D","get_bone_count"],["Polygon2D","set_skeleton"],["Polygon2D","set_internal_vertex_count"],["Polygon2D","set_polygons"],["Bone2D","set_rest"],["Bone2D","set_length"],["Bone2D","set_bone_angle"],["Bone2D","set_autocalculate_length_and_angle"]]:\n\t\tprint(m, " ", ClassDB.class_has_method(m[0], m[1]))\n\tquit()\n' > /tmp/api.gd && "$CINDERPAW_GODOT" --headless -s /tmp/api.gd
```
Expected: every line ends in `true`. If any is `false`, stop and report to Darius.

- [ ] **Step 2: Write the rig builder and generate `rig.json`**

`games/ember/rig/build_rig.py`:
```python
"""Cinderpaw's in-game bone rig, from art/cheer.png (158x192).

Writes rig/rig.json: a mesh over the drawing (its outline plus a grid of
interior points, Delaunay-triangulated and kept inside the silhouette), the
bones measured on the drawing, and each vertex's weight per bone (inverse
distance to the bone to the 4th power, top two bones, normalised). The game
builds a Skeleton2D and a Polygon2D from it at runtime (scripts/rig.gd).

usage: python games/ember/rig/build_rig.py
"""
import json
import os

import numpy as np
from PIL import Image
from scipy.spatial import Delaunay
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, '..', 'art', 'cheer.png')
# name, parent, head (x, y), tail (x, y), in pixels of art/cheer.png.
BONES = [
    ('hips',   None,   (76, 166),  (76, 126)),
    ('body',   'hips', (76, 126),  (76, 112)),
    ('head',   'body', (76, 112),  (78, 40)),
    ('horn_l', 'head', (38, 46),   (22, 20)),
    ('horn_r', 'head', (119, 42),  (111, 10)),
    ('arm_l',  'body', (44, 116),  (14, 112)),
    ('arm_r',  'body', (112, 112), (146, 100)),
    ('tail',   'hips', (40, 152),  (18, 140)),
]
GRID = 12


def seg_dist(p, a, b):
    a, b = np.array(a, float), np.array(b, float)
    t = np.clip(((p - a) @ (b - a)) / max(1e-9, (b - a) @ (b - a)), 0, 1)
    return np.linalg.norm(p - (a + np.outer(t, b - a)), axis=1)


def main():
    alpha = np.asarray(Image.open(ART).convert('RGBA'))[..., 3] >= 128
    contour = max(measure.find_contours(alpha.astype(float), 0.5), key=len)
    outline = measure.approximate_polygon(contour, tolerance=1.2)[:-1][:, ::-1]  # (x, y), open ring
    h, w = alpha.shape
    gx, gy = np.meshgrid(np.arange(GRID / 2, w, GRID), np.arange(GRID / 2, h, GRID))
    grid = np.c_[gx.ravel(), gy.ravel()]
    inside = grid[alpha[grid[:, 1].astype(int), grid[:, 0].astype(int)]]
    far = np.min(np.linalg.norm(inside[:, None] - outline[None], axis=2), axis=1) > GRID * 0.5
    interior = inside[far]
    pts = np.vstack([outline, interior])  # Polygon2D wants the internal vertices last
    tris = [t for t in Delaunay(pts).simplices if alpha[int(pts[t, 1].mean()), int(pts[t, 0].mean())]]
    d = np.stack([seg_dist(pts, head, tail) for _, _, head, tail in BONES], axis=1)
    wts = 1.0 / (d + 2.0) ** 4
    top2 = np.argsort(-wts, axis=1)[:, :2]
    mask = np.zeros_like(wts, bool)
    np.put_along_axis(mask, top2, True, axis=1)
    wts = np.where(mask, wts, 0.0)
    wts /= wts.sum(axis=1, keepdims=True)
    rig = {
        'size': [w, h],
        'points': np.round(pts, 2).tolist(),
        'internal': int(len(interior)),
        'triangles': [[int(i) for i in t] for t in tris],
        'bones': [{'name': n, 'parent': p, 'head': list(a), 'tail': list(b), 'weights': np.round(wts[:, i], 4).tolist()}
                  for i, (n, p, a, b) in enumerate(BONES)],
    }
    with open(os.path.join(HERE, 'rig.json'), 'w') as f:
        json.dump(rig, f)
    print(f"rig.json: {len(pts)} points ({len(interior)} internal), {len(tris)} triangles, {len(BONES)} bones")


if __name__ == '__main__':
    main()
```
Run: `cd /d/cp-ember && python games/ember/rig/build_rig.py`
Expected: one line like `rig.json: 2xx points (1xx internal), 3xx triangles, 8 bones`.

- [ ] **Step 3: Write the failing rig tests**

`games/ember/tests/test_rig.gd`:
```gdscript
extends RefCounted

func run(t) -> void:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://rig/rig.json"))
	t.check("rig: rig.json loads", typeof(data) == TYPE_DICTIONARY)
	var n: int = data["points"].size()
	var sums_ok := true
	for i in n:
		var s := 0.0
		for b in data["bones"]:
			s += b["weights"][i]
		sums_ok = sums_ok and absf(s - 1.0) < 0.01
	t.check("rig: every vertex's weights sum to 1", sums_ok)
	var tip := Vector2(data["bones"][7]["tail"][0], data["bones"][7]["tail"][1])  # the tail's tip
	var nearest := 0
	for i in n:
		if Vector2(data["points"][i][0], data["points"][i][1]).distance_to(tip) < Vector2(data["points"][nearest][0], data["points"][nearest][1]).distance_to(tip):
			nearest = i
	t.check("rig: the tail's tip hangs on the tail bone, not the head", data["bones"][7]["weights"][nearest] > data["bones"][2]["weights"][nearest])
	var rig := Rig.new()
	rig.build(data, preload("res://art/cheer.png"), 76.0)
	t.check("rig: builds every bone", rig.bones.size() == data["bones"].size())
	var poly: Polygon2D = rig.get_node("Mesh")
	t.check("rig: the mesh carries a weight table per bone", poly.get_bone_count() == data["bones"].size())
	rig.bend("tail", 20.0)
	t.check("rig: bend turns the bone", is_equal_approx(rig.bones["tail"].rotation, deg_to_rad(20.0)))
	rig.free()
```
In `games/ember/tests/run_tests.gd` set:
```gdscript
const SUITES := ["res://tests/test_bridge.gd", "res://tests/test_rules.gd", "res://tests/test_world.gd", "res://tests/test_rig.gd"]
```
Run: `cd /d/cp-ember && "$CINDERPAW_GODOT" --headless --path games/ember --import; "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd`
Expected: FAIL, `Rig` not declared.

- [ ] **Step 4: Implement the rig and pose it from Cinderpaw's motion**

`games/ember/scripts/rig.gd`:
```gdscript
class_name Rig
extends Node2D
## Cinderpaw as a skinned mesh. rig/rig.json (from rig/build_rig.py) holds the
## mesh over art/cheer.png, the bones and every vertex's weights; `build` turns
## it into a Skeleton2D and a Polygon2D, `bend` turns one bone from its rest.
## The node's origin is the middle of the feet.

var bones := {}

func build(data: Dictionary, texture: Texture2D, height: float) -> void:
	var k := height / float(data["size"][1])
	var origin := Vector2(data["size"][0] * 0.5, data["size"][1])
	var skel := Skeleton2D.new()
	skel.name = "Skeleton"
	add_child(skel)
	var heads := {}
	var paths := {}  # bone name -> its path under the Skeleton2D, e.g. "hips/body/head"
	for b in data["bones"]:  # parents come before their children in rig.json
		var head: Vector2 = (Vector2(b["head"][0], b["head"][1]) - origin) * k
		var tail: Vector2 = (Vector2(b["tail"][0], b["tail"][1]) - origin) * k
		heads[b["name"]] = head
		paths[b["name"]] = b["name"] if b["parent"] == null else paths[b["parent"]] + "/" + b["name"]
		var bone := Bone2D.new()
		bone.name = b["name"]
		bone.set_autocalculate_length_and_angle(false)
		bone.set_length((tail - head).length())
		bone.set_bone_angle((tail - head).angle())
		bone.position = head if b["parent"] == null else head - heads[b["parent"]]
		(skel if b["parent"] == null else bones[b["parent"]]).add_child(bone)
		bone.rest = bone.transform
		bones[b["name"]] = bone
	var poly := Polygon2D.new()
	poly.name = "Mesh"
	poly.texture = texture
	var pts := PackedVector2Array()
	var uv := PackedVector2Array()
	for p in data["points"]:
		uv.append(Vector2(p[0], p[1]))
		pts.append((Vector2(p[0], p[1]) - origin) * k)
	poly.polygon = pts
	poly.uv = uv
	poly.internal_vertex_count = data["internal"]
	var tris := []
	for tri in data["triangles"]:
		tris.append(PackedInt32Array(tri))
	poly.polygons = tris
	add_child(poly)
	# Paths are written out rather than asked of get_path_to(), which needs the
	# nodes inside a scene tree; the headless test builds the rig outside one.
	poly.skeleton = NodePath("../Skeleton")
	for b in data["bones"]:
		poly.add_bone(NodePath(paths[b["name"]]), PackedFloat32Array(b["weights"]))

func bend(bone: String, degrees: float) -> void:
	bones[bone].rotation = deg_to_rad(degrees)
```

In `games/ember/scripts/cinderpaw.gd`: add these members under `var tex_flinch ...`:
```gdscript
var rig: Rig
var _t := 0.0
var _horn := 0.0
var _horn_v := 0.0

func _ready() -> void:
	rig = Rig.new()
	rig.build(JSON.parse_string(FileAccess.get_file_as_string("res://rig/rig.json")), tex_normal, HEIGHT)
	add_child(rig)
```
append at the end of `step()` (after `squash += squash_v * dt`, before `queue_redraw()`):
```gdscript
	# The rig follows the body a beat late: horns and arms flop on the hops, the tail swings.
	_t += dt
	_horn_v += (-(_horn - clampf(-vel.y * 0.03, -12.0, 12.0)) * 90.0 - _horn_v * 8.0) * dt
	_horn += _horn_v * dt
	rig.visible = stunned <= 0.0
	rig.scale = Vector2(facing / sqrt(maxf(squash, 0.4)), squash)
	rig.bend("head", clampf(vel.x * 0.02, -6.0, 6.0))
	rig.bend("horn_l", -_horn)
	rig.bend("horn_r", _horn)
	rig.bend("arm_l", -_horn * 0.8 + sin(_t * 6.0) * 4.0)
	rig.bend("arm_r", _horn * 0.8 - sin(_t * 6.0) * 4.0)
	rig.bend("tail", sin(_t * 5.0) * 10.0 - vel.x * 0.03)
```
and replace `_draw()` so the flat drawing shows only for the flinch:
```gdscript
func _draw() -> void:
	if stunned <= 0.0:
		return  # the rig draws Cinderpaw
	var w := HEIGHT * tex_flinch.get_width() / tex_flinch.get_height()
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(facing / sqrt(maxf(squash, 0.4)), squash))
	draw_texture_rect(tex_flinch, Rect2(-w / 2.0, -HEIGHT, w, HEIGHT), false)
```

- [ ] **Step 5: Run the tests, then look at the rig bending**

```bash
cd /d/cp-ember && "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd && CINDERPAW_FORCE_GAME_BUILD=1 node src-tauri/scripts/build-game.mjs && cd games/ember/tests/smoke && node smoke.mjs ../../../../frontend-react/public/games/ember chromium
```
Expected: all PASS; `smoke-chromium.png` shows Cinderpaw drawn by the mesh, whole, with no torn triangles. To see bending, temporarily run `rig.bend("tail", 30)` in `_ready` and re-export: the tail must curl while the head stays put. If the mesh ignores the bones, the bone paths are relative to the wrong node: change `NodePath(paths[b["name"]])` to `NodePath("../Skeleton/" + paths[b["name"]])` (relative to the Polygon2D instead of the Skeleton2D), re-run, and note in the commit message which base Godot 4.7.2 expects. Remove the temporary bend before committing.

- [ ] **Step 6: Commit**

```bash
cd /d/cp-ember && git add games/ember && git commit -m "feat(ember): Cinderpaw moves on bones in the game: horns flop, tail swings, arms bob

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CI: export once, test on every engine, release only with the game

**Files:**
- Create: `scripts/fetch-godot.py`
- Modify: `.github/workflows/ci.yml` (new jobs `ember`, `ember-macos`), `.github/workflows/release.yml` (new job `ember`; `release` job gets `needs: ember` and a download step)

**Interfaces:**
- Produces: `python scripts/fetch-godot.py [dir]` prints `CINDERPAW_GODOT=<path>`; CI artifact `ember-web` = the export directory.

- [ ] **Step 1: Write the fetcher**

`scripts/fetch-godot.py`:
```python
#!/usr/bin/env python3
"""Install Godot 4.7.2 (portable) and ONLY its web export templates.

The official template archive is 1.28 GB for every platform; the web
templates the campfire game needs are a small part of it, read out of the
remote zip with HTTP range requests. Prints `CINDERPAW_GODOT=<path>` so CI can
append it to $GITHUB_ENV.

usage: python scripts/fetch-godot.py [install-dir]    (default: .tools/godot)
"""
import io
import os
import platform
import stat
import sys
import urllib.request
import zipfile

VERSION = '4.7.2'
BASE = f'https://github.com/godotengine/godot/releases/download/{VERSION}-stable/'
EDITOR = {
    'Linux': (f'Godot_v{VERSION}-stable_linux.x86_64.zip', f'Godot_v{VERSION}-stable_linux.x86_64'),
    'Windows': (f'Godot_v{VERSION}-stable_win64.exe.zip', f'Godot_v{VERSION}-stable_win64_console.exe'),
}
TEMPLATES = f'Godot_v{VERSION}-stable_export_templates.tpz'


class RemoteFile(io.RawIOBase):
    """A seekable read-only view of a URL, one HTTP range request per read."""

    def __init__(self, url):
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD')) as r:
            self.url, self.size = r.url, int(r.headers['Content-Length'])
        self.pos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size or len(buf) == 0:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        with urllib.request.urlopen(urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}'})) as r:
            data = r.read()
        buf[:len(data)] = data
        self.pos += len(data)
        return len(data)


def main():
    dest = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join('.tools', 'godot'))
    system = platform.system()
    if system not in EDITOR:
        sys.exit(f'fetch-godot: no editor download is wired for {system}; install Godot {VERSION} and set CINDERPAW_GODOT.')
    os.makedirs(dest, exist_ok=True)
    archive, binary = EDITOR[system]
    exe = os.path.join(dest, binary)
    if not os.path.exists(exe):
        with urllib.request.urlopen(BASE + archive) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(dest)
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)
    open(os.path.join(dest, '._sc_'), 'a').close()  # self-contained: templates live beside the editor
    tdir = os.path.join(dest, 'editor_data', 'export_templates', f'{VERSION}.stable')
    if not os.path.exists(os.path.join(tdir, 'web_nothreads_release.zip')):
        os.makedirs(tdir, exist_ok=True)
        z = zipfile.ZipFile(io.BufferedReader(RemoteFile(BASE + TEMPLATES), buffer_size=1 << 20))
        for name in z.namelist():
            if 'web_nothreads' in name or name.endswith('version.txt'):
                with z.open(name) as src, open(os.path.join(tdir, os.path.basename(name)), 'wb') as out:
                    out.write(src.read())
    print(f'CINDERPAW_GODOT={exe}')


if __name__ == '__main__':
    main()
```
Run: `cd /d/cp-ember && python scripts/fetch-godot.py .tools/godot`
Expected: prints `CINDERPAW_GODOT=D:\cp-ember\.tools\godot\Godot_v4.7.2-stable_win64_console.exe`; `.tools/godot/editor_data/export_templates/4.7.2.stable/` holds `web_nothreads_debug.zip`, `web_nothreads_release.zip`, `version.txt`.

- [ ] **Step 2: Add the CI jobs**

Append to `.github/workflows/ci.yml` under `jobs:` (use the same `node-version` as the file's existing `Setup Node` steps):
```yaml
  ember:
    name: campfire game (tests, export, Chromium + WebKit on Linux)
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Fetch Godot 4.7.2 and its web templates
        run: python3 scripts/fetch-godot.py >> "$GITHUB_ENV"
      - name: Game tests
        run: |
          "$CINDERPAW_GODOT" --headless --path games/ember --import
          "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd
      - name: Export
        env:
          CINDERPAW_FORCE_GAME_BUILD: "1"
        run: node src-tauri/scripts/build-game.mjs
      - name: Smoke in Chromium and WebKit
        working-directory: games/ember/tests/smoke
        run: |
          npm ci
          npx playwright install --with-deps chromium webkit
          node smoke.mjs ../../../../frontend-react/public/games/ember chromium
          xvfb-run -a node smoke.mjs ../../../../frontend-react/public/games/ember webkit
      - uses: actions/upload-artifact@v4
        with:
          name: ember-web
          path: frontend-react/public/games/ember
          if-no-files-found: error

  ember-macos:
    name: campfire game (WebKit on macOS)
    needs: ember
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/download-artifact@v4
        with:
          name: ember-web
          path: frontend-react/public/games/ember
      - name: Smoke in WebKit
        working-directory: games/ember/tests/smoke
        run: |
          npm ci
          npx playwright install webkit
          node smoke.mjs ../../../../frontend-react/public/games/ember webkit
```

- [ ] **Step 3: Make the release wait for the game**

In `.github/workflows/release.yml`, add a job above `release:` (same `node-version` as the file's `Setup Node` step):
```yaml
  ember:
    name: Export the campfire game
    if: github.event_name == 'push'
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Fetch Godot 4.7.2 and its web templates
        run: python3 scripts/fetch-godot.py >> "$GITHUB_ENV"
      - name: Game tests
        run: |
          "$CINDERPAW_GODOT" --headless --path games/ember --import
          "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd
      - name: Export
        env:
          CINDERPAW_FORCE_GAME_BUILD: "1"
        run: node src-tauri/scripts/build-game.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: ember-web
          path: frontend-react/public/games/ember
          if-no-files-found: error
```
In the `release:` job add `needs: ember` (next to `if:`), and right after its `Checkout Cinderpaw` step:
```yaml
      - name: Download the campfire game
        uses: actions/download-artifact@v4
        with:
          name: ember-web
          path: frontend-react/public/games/ember
```
(On the runners `build-game.mjs` finds no Godot and ships the downloaded export, printing so.)

- [ ] **Step 4: Validate the YAML**

Run: `cd /d/cp-ember && python -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ('.github/workflows/ci.yml','.github/workflows/release.yml')]; print('yaml ok')"`
Expected: `yaml ok`. (If PyYAML is missing: `pip install pyyaml` first.)

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-godot.py .github/workflows/ci.yml .github/workflows/release.yml && git commit -m "ci(ember): test and export the game once, smoke it in WebKit on Linux and macOS, never release without it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Licence notice, the verify gate, and the proof on real builds

**Files:**
- Modify: `THIRD-PARTY-NOTICES.md`, `scripts/verify.sh`

- [ ] **Step 1: Add Godot's notice**

Fetch the exact texts for the pinned tag:
```bash
cd /d/cp-ember && curl -sL https://raw.githubusercontent.com/godotengine/godot/4.7.2-stable/LICENSE.txt -o /tmp/godot-LICENSE.txt && curl -sL https://raw.githubusercontent.com/godotengine/godot/4.7.2-stable/COPYRIGHT.txt -o /tmp/godot-COPYRIGHT.txt && head -5 /tmp/godot-LICENSE.txt
```
Append to `THIRD-PARTY-NOTICES.md`, in the file's existing section format: a "Godot Engine 4.7.2 (the campfire game's web runtime)" entry, MIT, with the full text of `/tmp/godot-LICENSE.txt`, and a note that the web export also bundles the third-party components listed in Godot's `COPYRIGHT.txt` for tag `4.7.2-stable` (https://github.com/godotengine/godot/blob/4.7.2-stable/COPYRIGHT.txt), each under the licence given there.

- [ ] **Step 2: Add the game to the verify gate**

In `scripts/verify.sh`, after the `Sidecar build` line:
```bash
run "Game export script tests" bash -c "cd \"$ROOT\" && node --test src-tauri/scripts/build-game.test.mjs"
GODOT="${CINDERPAW_GODOT:-$(command -v godot || true)}"
if [ -n "$GODOT" ]; then
  run "Campfire game tests" bash -c "\"$GODOT\" --headless --path \"$ROOT/games/ember\" --import >/dev/null && \"$GODOT\" --headless --path \"$ROOT/games/ember\" -s res://tests/run_tests.gd"
else
  echo "== Campfire game tests: skipped, Godot is not installed (python scripts/fetch-godot.py, then set CINDERPAW_GODOT)"
fi
```

- [ ] **Step 3: Run the whole gate (ask Darius to close his app first: a full run starves it)**

Run: `cd /d/cp-ember && ./scripts/verify.sh`
Expected: every section PASS, including `Game export script tests` and `Campfire game tests`.

- [ ] **Step 4: Prove it in the real app, dev and production**

1. Dev: start the app from `D:/cp-ember` with `CINDERPAW_GODOT` set (copy `D:/cp-main/run-app-ui-gpu.bat` into `D:/cp-ember` and add `set "CINDERPAW_GODOT=D:\tools\godot-4.7.2\Godot_v4.7.2-stable_win64_console.exe"`), only after Darius has closed the app he is testing. Give the agent a task that runs past 15 s (for example: "search the web for three campfire recipes and compare them"). Expected: the campfire icon appears on the composer's edge at ~15 s; clicking it opens the panel within ~2 s; sparks fall when the agent calls tools; Esc closes; reopening resumes; the answer arriving ends the round with fireworks and "Back to the answer".
2. Production (Tauri serves the files from inside the binary, a different path from Vite): `cargo tauri build` with the same environment, install, repeat step 1. Expected: identical. If the panel says "The game didn't start", check the `.wasm` response's content type in the WebView devtools before anything else.
3. macOS and Linux: the `ember` and `ember-macos` CI jobs on the PR must be green (WebKit on both).

- [ ] **Step 5: Commit**

```bash
cd /d/cp-ember && git add THIRD-PARTY-NOTICES.md scripts/verify.sh && git commit -m "chore(ember): Godot's licence notice, and the game in the verify gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015ju5sWejtS3VjEqgVEdvTa
Signed-off-by: Claude Opus 5.5 <noreply@anthropic.com>"
```
