#!/usr/bin/env node
/**
 * Verify every Extensions-catalog entry in `src-tauri/src/mcp.rs` is real.
 *
 * Why this exists: the catalog shipped 29 entries pointing at npm packages
 * that had never existed. Nothing caught it, because nothing ever asked npm.
 * A catalog entry is a promise the product makes to someone who cannot
 * debug it — "exists on npm" is the floor, and even that floor was missing.
 *
 * Two levels of check:
 *   --resolve  (default) every pinned spec resolves on the npm registry.
 *   --spawn    additionally launch each server and complete a real MCP
 *              `initialize` handshake. Slower (cold npm downloads) and needs
 *              credentials for some servers, so it is opt-in — but it is the
 *              only check that catches a package which exists and still can't
 *              start (the Cloudflare entry was invoked with the wrong
 *              subcommand and would have failed for every user forever).
 *
 * Exit code is non-zero on any violation, so CI can gate on it.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src-tauri", "src", "mcp.rs");
const SPAWN = process.argv.includes("--spawn");
const HANDSHAKE_TIMEOUT_MS = 150_000;

/**
 * Pull (id, command, package spec) out of the Rust catalog definitions.
 *
 * Deliberately tolerant of comment lines between `command:` and `args:` —
 * several entries carry a note there explaining why their command line looks
 * the way it does. An earlier version of this regex required the two to be
 * adjacent, silently skipped every commented entry, and then paired the
 * remaining ids with the WRONG specs as the match ran on into the next entry.
 * A checker that reports on the wrong rows is worse than no checker, so the
 * count is asserted against the number of ids found.
 */
function parseCatalog(rust) {
  // Chunk per entry rather than one sprawling regex: an entry's fields, args
  // and env keys all have to belong to the SAME entry, and a single pattern
  // spanning the whole file quietly pairs them across neighbours when one
  // stops matching.
  const chunks = rust.split(/\n        CatalogDef \{/).slice(1);
  const entries = chunks.map((chunk) => {
    const pick = (re) => chunk.match(re)?.[1];
    const list = (raw) => (raw ? [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]) : []);
    const args = list(pick(/args:\s*&\[([\s\S]*?)\]/));
    return {
      id: pick(/id:\s*"([^"]+)"\.into\(\)/),
      command: pick(/command:\s*"([^"]+)"/),
      args,
      // The package spec is the launchable thing: not a flag, not a `{FIELD}`
      // placeholder, and not the URL a bridge entry points at.
      spec: args.find((a) => !a.startsWith("-") && !a.includes("{") && !/^https?:\/\//.test(a)),
      fieldKeys: [...chunk.matchAll(/f\("([A-Z0-9_]+)"/g)].map((m) => m[1]),
      envKeys: list(pick(/env_keys:\s*&\[([\s\S]*?)\]/)),
      staticEnv: [...chunk.matchAll(/\("([A-Z0-9_]+)",\s*"([^"]*)"\)/g)].map((m) => [m[1], m[2]]),
    };
  });
  const declared = [...rust.matchAll(/id:\s*"[^"]+"\.into\(\)/g)].length;
  if (entries.length !== declared || entries.some((e) => !e.id || !e.command)) {
    console.error(
      `Parsed ${entries.length} entries but the catalog declares ${declared}. ` +
        `The Rust formatting changed — fix parseCatalog before trusting this run.`,
    );
    process.exit(2);
  }
  return entries;
}

/**
 * Stand-in answers for an entry's config fields.
 *
 * The point of `--spawn` is to prove the COMMAND LINE is right — the flags,
 * the subcommand, the env var names. A server that refuses to start because
 * no key was supplied has told us nothing about any of that, so supply
 * throwaway values the way the install flow would. Servers that validate the
 * key against their API will still reject it, which is itself a pass: they
 * got far enough to read the variable we set.
 */
function dummyValues(entry) {
  const args = entry.args.map((a) =>
    a.replace(/\{([A-Z0-9_]+)\}/g, (_, key) =>
      /FOLDER|DIR|PATH/.test(key) ? tmpdir() : `cinderpaw-check-${key.toLowerCase()}`,
    ),
  );
  const env = { ...Object.fromEntries(entry.staticEnv) };
  for (const key of new Set([...entry.envKeys, ...entry.fieldKeys])) {
    env[key] ??= /URL$/.test(key)
      ? "postgresql://user:pass@localhost:5432/db"
      : `cinderpaw-check-${key.toLowerCase()}`;
  }
  return { args, env };
}

/** Split `@scope/name@1.2.3` into its name and pinned version. */
function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at > 0 && /^\d/.test(spec.slice(at + 1))) {
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  return { name: spec, version: null };
}

async function resolves({ name, version }) {
  const url = "https://registry.npmjs.org/" + name.replace("/", "%2f");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return `not on npm (HTTP ${res.status})`;
  const doc = await res.json();
  if (version && !doc.versions?.[version]) return `version ${version} does not exist`;
  const resolved = version ?? doc["dist-tags"]?.latest;
  if (!doc.versions?.[resolved]?.bin) return `no executable — this is a library, not a server`;
  return null;
}

function handshakes(entry) {
  const { args, env } = dummyValues(entry);
  return new Promise((resolve) => {
    const argv = process.platform === "win32"
      ? ["/c", "npx", "-y", ...args]
      : ["-y", ...args];
    const child = spawn(process.platform === "win32" ? "cmd" : "npx", argv, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(
      () => finish(`no MCP handshake in ${HANDSHAKE_TIMEOUT_MS / 1000}s — ${stderr.trim().slice(-160)}`),
      HANDSHAKE_TIMEOUT_MS,
    );
    child.stdout.on("data", (d) => {
      stdout += d;
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result?.serverInfo) return finish(null);
          if (msg.id === 1 && msg.error) return finish(`initialize rejected: ${msg.error.message}`);
        } catch { /* partial line */ }
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(`could not spawn: ${e.message}`));
    child.on("exit", (code) => finish(`exited (code ${code}) — ${stderr.trim().slice(-160)}`));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "cinderpaw-catalog-check", version: "1.0.0" },
      },
    }) + "\n");
  });
}

const catalog = parseCatalog(readFileSync(SOURCE, "utf8"));
if (catalog.length === 0) {
  console.error(`No catalog entries parsed from ${SOURCE} — did the format change?`);
  process.exit(2);
}

const failures = [];
for (const entry of catalog) {
  if (entry.command !== "npx" || !entry.spec) continue;
  const parts = splitSpec(entry.spec);
  let problem = parts.version ? null : "not pinned to an exact version";
  problem ??= await resolves(parts);
  // Only spawn what already resolves; a 404 has nothing to launch.
  //
  // Bridged remote servers are skipped: connecting means opening a browser and
  // waiting for a human to sign in, so an automated run would either hang or
  // pop windows at whoever ran the check. Their endpoints have to be confirmed
  // by hand, once, when the entry is added.
  const bridged = entry.args.some((a) => a.startsWith("mcp-remote@"));
  if (!problem && SPAWN && bridged) {
    console.log(`skip  ${entry.id.padEnd(22)} ${entry.spec} → needs a human to sign in`);
    continue;
  }
  if (!problem && SPAWN) problem = await handshakes(entry);
  console.log(`${problem ? "FAIL" : "ok  "}  ${entry.id.padEnd(22)} ${entry.spec}${problem ? `\n        ${problem}` : ""}`);
  if (problem) failures.push(`${entry.id} (${entry.spec}): ${problem}`);
}

console.log(`\n${catalog.length - failures.length}/${catalog.length} catalog entries healthy.`);
if (failures.length) {
  console.error(`\n${failures.length} broken:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
