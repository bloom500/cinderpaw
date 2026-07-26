#!/usr/bin/env node
// Feral launcher — cross-platform. npm guarantees node (not bun), so this thin
// shim (node) locates the bundled Rust `feral` binary for the host platform and
// execs it; the Rust binary in turn spawns the TS sidecar sitting NEXT TO it in
// the same package. The user only ever types `feral ...`; Rust/Bun/sidecar/
// gateway are internal.
//
// Distribution model (esbuild/swc-style): the platform binaries do NOT ship in
// this package. They live in per-platform packages — `feral-agent-<os>-<arch>`
// — declared as optionalDependencies. npm installs only the one whose `os`/`cpu`
// matches the host and skips the rest, so a mac user never downloads the Windows
// binary. This shim resolves whichever one got installed.
//
// ESM (package.json has "type": "module").
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ext = process.platform === "win32" ? ".exe" : "";

// `feral update` is handled HERE and never reaches the Rust binary. Two reasons,
// both fatal if we delegated: on Windows npm cannot overwrite a running .exe, and
// a half-installed machine (platform package missing) has no Rust binary to run —
// which is exactly when you most want to re-install. This shim is the one file in
// the install that is never locked.
if (process.argv[2] === "update") {
  const win = process.platform === "win32";
  // Was a gateway serving before the update? If so it is running the OLD binary,
  // and a Discord/Slack connector keeps running it until something restarts it.
  // Checked BEFORE the install so we never start a daemon the user didn't have.
  const old = exeFor();
  const wasOnline =
    !!old && spawnSync(old, ["gateway", "status"], { stdio: "ignore" }).status === 0;

  const install = spawnSync(win ? "npm.cmd" : "npm", ["install", "-g", "feral-agent@latest"], {
    stdio: "inherit",
    shell: win, // npm.cmd is a batch file; Node needs a shell to exec it
  });
  if (install.error || install.status !== 0) {
    process.stderr.write(
      "feral: update failed. Install manually with: npm install -g feral-agent@latest\n",
    );
    process.exit(install.status ?? 1);
  }
  if (!wasOnline) {
    process.stdout.write("feral: updated. Start it with: feral gateway start\n");
    process.exit(0);
  }
  // Re-run THIS file — npm has just replaced it with the new version, so the
  // restart is driven by the new shim and starts the new binary.
  process.stdout.write("feral: updated — restarting the gateway…\n");
  const restart = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "gateway", "restart"],
    { stdio: "inherit" },
  );
  process.exit(restart.status ?? 1);
}

/** Resolve the platform binary, or null when this install has none. */
function exeFor() {
  const pkg = `@bloommedia/feral-agent-${process.platform}-${process.arch}`;
  try {
    const p = require.resolve(`${pkg}/feral-cli${ext}`);
    if (existsSync(p)) return p;
  } catch {
    /* fall through to the dev path */
  }
  const local = join(here, "..", "vendor", `feral-cli${ext}`);
  return existsSync(local) ? local : null;
}

const exe = exeFor();

if (!exe) {
  process.stderr.write(
    `Feral could not find its runtime for ${process.platform}-${process.arch}.\n` +
      `The matching package \`@bloommedia/feral-agent-${process.platform}-${process.arch}\` may have failed to install ` +
      "(a blocked optional dependency, an unsupported platform, or " +
      "`--ignore-optional`).\n" +
      "Reinstall with: npm install -g feral-agent\n" +
      "Report: https://github.com/bloom500/feral/issues\n",
  );
  process.exit(1);
}

// Report a single coherent version: the npm package version is the source of
// truth. The Rust `version` command prefers FERAL_VERSION when set.
let version = "";
try {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  version = pkg.version || "";
} catch {
  /* keep empty — Rust falls back to its compiled version */
}

const res = spawnSync(exe, process.argv.slice(2), {
  stdio: "inherit",
  env: version ? { ...process.env, FERAL_VERSION: version } : process.env,
});

if (res.error) {
  process.stderr.write(`Feral failed to launch: ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
