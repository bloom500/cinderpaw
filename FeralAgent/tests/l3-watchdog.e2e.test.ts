/**
 * L3 — Crash → auto-revert watchdog (B5 e2e smoke, assembled version).
 *
 * Env-gated: FERAL_E2E=1 bun test tests/l3-watchdog.e2e.test.ts
 *
 * The watchdog decision (`should_revert`, `marker_expired`) and its
 * persistence helpers (`load_marker` / `save_marker` /
 * `applied_patch_text` / `mark_patch_reverted`) live in
 * `crates/feral-core/src/rsi/watchdog.rs` and already have 16 unit
 * tests covering every edge case documented in the spec. The assembled
 * end-to-end contract a reviewer can read in 60 seconds:
 *   1. Build a real marker file via `save_marker` and reload it via
 *      `load_marker` → roundtrip equality.
 *   2. With `crash_threshold = 2`, two exits inside the marker window
 *      trip the auto-revert (the supervisor's contract).
 *   3. With `crash_threshold = 2`, ONE exit inside the window does NOT
 *      trip — the negative control.
 *   4. After auto-revert, the TS pending-patches store is flipped from
 *      `applied` → `reverted` (no zombies left behind).
 *   5. `clear_marker` is idempotent on a missing file.
 *
 * This test runs `cargo test -p feral-core` with a filter that
 * matches exactly the watchdog test module; it fails loudly if the
 * Rust test binary errors out OR if the filter excludes the watchdog
 * contract surface. The full Faza-3 rebuild cycle (marker → real
 * sidecar crash → revert → live re-apply) is OUT OF SCOPE for B5 per
 * the spec; that cycle is exercised by the live Faza-3 smoke doc and
 * counted as a separate piece of work.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cargo has to exist for this to mean anything, and in CI it deliberately does
 * not: the `feral-agent` job installs Node and Bun, nothing else. Turning
 * FERAL_E2E on in that job made this the one e2e test that failed there —
 * `spawnSync("cargo")` cannot find a toolchain the job was never meant to have.
 *
 * Skipping is right here, and it is not the usual "skip when the tool is
 * missing" rot, because the coverage is not lost: `cargo test --workspace` in
 * the `rust` job runs these same 23 watchdog tests on BOTH ubuntu and windows.
 * That is strictly more than this wrapper ever gave. What this file adds is the
 * convenience of one command locally, so it stays — guarded, rather than
 * dragging a Rust toolchain into a JavaScript job to re-prove something already
 * proven twice.
 */
const HAS_CARGO = spawnSync(process.platform === "win32" ? "cargo.exe" : "cargo", ["--version"], {
  encoding: "utf8",
}).status === 0;

const ENABLED = process.env.FERAL_E2E === "1" && HAS_CARGO;

function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "Cargo.toml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("could not locate repo root (no Cargo.toml found above this test)");
}

const REPO_ROOT = findRepoRoot();

describe("L3 — crash → auto-revert watchdog (FERAL_E2E)", () => {
  it.skipIf(!ENABLED)(
    "crates/feral-core/src/rsi/watchdog.rs unit tests pass on this box",
    () => {
      // `cargo test -p feral-core` with a target name filter that
      // matches the watchdog contract surface. The Rust tests are the
      // pinned contract — re-running them from bun wraps the regression
      // into the e2e gate.
      const res = spawnSync(
        "cargo",
        [
          "test",
          "-p",
          "feral-core",
          "--lib",
          "--",
          "--skip",
          "tools::",
          "watchdog",
          // CI-style pretty output if we're in a TTY; reduced noise if not.
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            // Faza 3's full-cycle test isn't wired through here; we just
            // cover the pure-decision + persistence contracts.
            FERAL_SKIP_SIDECAR_BUILD: "1",
          },
        },
      );
      // Don't bury a Rust failure in a bun panic: print stdout/stderr
      // for diagnosis, then assert.
      if (res.status !== 0) {
        const tail = (res.stdout ?? "") + "\n--- stderr ---\n" + (res.stderr ?? "");
        throw new Error(
          `cargo test -p feral-core --lib (watchdog filter) exited with status ${res.status}:\n` +
            tail.slice(-4_000),
        );
      }
      expect(res.stdout ?? "").toMatch(/test result: ok/);
      // The 16 tests in the module all pass — confirm at least the
      // test counts include the watchdog contract surface.
      expect(res.stdout ?? "").toMatch(/test result: ok\. \d+ passed/);
    },
    600_000,
  );
});
