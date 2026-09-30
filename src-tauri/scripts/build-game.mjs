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
