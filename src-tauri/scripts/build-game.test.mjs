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
