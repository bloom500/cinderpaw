#!/usr/bin/env node
/**
 * set-release-version.mjs — set Cinderpaw's release version across every manifest.
 *
 * Cinderpaw uses calendar versioning: a release is the padded date `YYYY.MM.DD`
 * (e.g. 2026.06.17). Internally the manifests must hold valid semver, which
 * forbids leading zeros, so they store the UNPADDED `YYYY.M.D` (2026.6.17).
 * This script does that conversion in one place so a manual edit can never
 * smuggle a leading zero into a version field (which would break the build and
 * the updater).
 *
 * Usage:
 *   node scripts/set-release-version.mjs            # uses today's date
 *   node scripts/set-release-version.mjs 2026.06.17 # explicit padded date
 *   node scripts/set-release-version.mjs 2026.6.17  # unpadded also accepted
 *
 * It prints the git tag to push (`vYYYY.MM.DD`) and the CHANGELOG header to add.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArg(arg) {
  if (!arg) {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = arg.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) {
    console.error(`Invalid version "${arg}". Expected YYYY.MM.DD (e.g. 2026.06.17).`);
    process.exit(1);
  }
  return { year: +m[1], month: +m[2], day: +m[3] };
}

const { year, month, day } = parseArg(process.argv[2]);
const pad = (n) => String(n).padStart(2, '0');
const semver = `${year}.${month}.${day}`;        // unpadded — for manifests
const display = `${year}.${pad(month)}.${pad(day)}`; // padded — for tag/changelog

/** Replace a regex match's first capture group with `semver`, preserving the rest. */
function patch(relPath, regex, label) {
  const file = join(root, relPath);
  const before = readFileSync(file, 'utf8');
  if (!regex.test(before)) {
    console.error(`✗ ${label}: no version field matched in ${relPath}`);
    process.exit(1);
  }
  const after = before.replace(regex, (full, g1) => full.replace(g1, semver));
  writeFileSync(file, after);
  console.log(`✓ ${label} → ${semver}`);
}

patch('src-tauri/tauri.conf.json', /"version":\s*"([^"]+)"/, 'tauri.conf.json');
patch('src-tauri/Cargo.toml', /^version = "([^"]+)"/m, 'src-tauri/Cargo.toml');
// [workspace.package] version, inherited by crates/cinderpaw-cli and crates/cinderpaw-core
// via `version.workspace = true`. Left out until 2026.07.26, so every npm CLI
// ever published answered `cinderpaw --version` with the workspace default (0.2.0)
// while its package said something else entirely.
patch('Cargo.toml', /^version = "([^"]+)"/m, 'Cargo.toml [workspace.package]');
patch('CinderpawAgent/package.json', /"version":\s*"([^"]+)"/, 'CinderpawAgent/package.json');
patch('frontend-react/package.json', /"version":\s*"([^"]+)"/, 'frontend-react/package.json');

console.log('');
console.log(`Release version set. Internal semver: ${semver}  ·  shown to users: ${display}`);
console.log('Next steps:');
console.log(`  1. Add a CHANGELOG.md section:  ## ${display}`);
console.log(`  2. Commit, then tag & push:     git tag v${display} && git push origin v${display}`);
