#!/usr/bin/env node
// Assemble one per-platform npm package: `feral-agent-<os>-<arch>`, containing
// just that platform's two binaries (the Rust CLI + the Bun sidecar) plus a
// package.json with `os`/`cpu` set so npm installs it only on a matching host.
//
//   node npm/assemble.mjs --os linux --arch x64 \
//     --cli target/release/feral-cli --agent dist/feral-agent
//
// Output: FeralAgent/npm/dist/feral-agent-<os>-<arch>/  (ready to `npm publish`)
//
// The main `feral-agent` package declares all of these as optionalDependencies;
// see bin/feral.js for how the shim resolves the installed one at runtime.

import { existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const npmDir = resolve(dirname(fileURLToPath(import.meta.url)));
const pkgDir = resolve(npmDir, "..");          // FeralAgent/

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const os = args.os;      // win32 | darwin | linux  (node's process.platform names)
const arch = args.arch;  // x64 | arm64             (node's process.arch names)
if (!os || !arch || !args.cli || !args.agent) {
  console.error("usage: assemble.mjs --os <win32|darwin|linux> --arch <x64|arm64> --cli <path> --agent <path>");
  process.exit(1);
}

const ext = os === "win32" ? ".exe" : "";
// Binary paths are resolved relative to the current working directory (where the
// caller invokes assemble), NOT the repo root — the CI workflow runs this from
// FeralAgent/ and passes e.g. `../target/release/feral-cli` and `dist/feral-agent`.
const cliSrc = resolve(args.cli);
const agentSrc = resolve(args.agent);
for (const [label, p] of [["cli", cliSrc], ["agent", agentSrc]]) {
  if (!existsSync(p)) {
    console.error(`${label} binary not found: ${p}`);
    process.exit(1);
  }
}

const version = JSON.parse(
  // reuse the main package's version — single source of truth
  await import("node:fs/promises").then((fs) => fs.readFile(join(pkgDir, "package.json"), "utf8")),
).version;

const name = `feral-agent-${os}-${arch}`;
const outDir = join(npmDir, "dist", name);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Binaries must sit in the SAME directory: the Rust CLI's find_binary() looks
// for the `feral-agent` sidecar next to its own executable.
copyFileSync(cliSrc, join(outDir, `feral-cli${ext}`));
copyFileSync(agentSrc, join(outDir, `feral-agent${ext}`));
if (os !== "win32") {
  chmodSync(join(outDir, `feral-cli${ext}`), 0o755);
  chmodSync(join(outDir, `feral-agent${ext}`), 0o755);
}

const pkgJson = {
  name,
  version,
  description: `Feral CLI runtime for ${os}-${arch}. Installed automatically by \`feral-agent\`.`,
  license: "BUSL-1.1",
  homepage: "https://github.com/bloom500/feral#readme",
  repository: { type: "git", url: "git+https://github.com/bloom500/feral.git", directory: "FeralAgent" },
  os: [os],
  cpu: [arch],
  files: [`feral-cli${ext}`, `feral-agent${ext}`],
  publishConfig: { access: "public" },
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

console.log(`✓ assembled ${name}@${version} → ${outDir}`);
