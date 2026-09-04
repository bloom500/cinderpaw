/**
 * Process identity + diagnostics — the two things a short-lived invocation
 * needs before it knows whether it is booting the agent at all.
 *
 * These lived in `boot.ts`, which meant `cinderpaw-agent version` (and the
 * `--custom-tool-runner` child process, and `cinderpaw-agent help`) had to
 * evaluate the entire agent module graph to read a version string. Several
 * tool modules resolve their executable allowlists against PATH at module
 * scope, so that cost ~1.5s on Windows against a ~120ms floor for a bare
 * compiled Bun binary — paid on every custom-tool call.
 *
 * Keep this module a leaf: anything imported here is paid for by every
 * invocation, including the ones that do no work.
 */

import { cfgPath } from "./config.ts";
/**
 * Static import so `bun --compile` bundles it — the previous
 * `readFileSync(new URL("../package.json", …))` silently fell back to
 * "0.0.0-dev" inside the compiled binary (caught live by the B7 smoke:
 * every module manifest failed its runtime floor). Env override kept.
 */
import pkgJson from "../package.json" with { type: "json" };

export const VERSION: string =
  cfgPath("CINDERPAW_VERSION") ??
  ((pkgJson as { version?: string }).version || "0.0.0-dev");

/** Diagnostics go to stderr; stdout is reserved for the transport protocol. */
export function log(message: string): void {
  process.stderr.write(`[cinderpaw] ${message}\n`);
}
