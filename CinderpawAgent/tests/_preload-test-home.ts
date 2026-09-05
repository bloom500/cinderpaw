/**
 * Give the test suite its own profile directory. Loaded by bunfig.toml's
 * `[test] preload`, so it runs before any test file imports config.ts.
 *
 * Why this exists: `bun test` was writing into the developer's LIVE profile
 * dir. Running the suite on 2026-08-26 rewrote ~/.cinderpaw/connectors.json
 * with a fixture — the real Discord allowlist in it was replaced by an empty
 * one, and the only reason it was noticed is that two profile directories
 * were being compared by hand at the time. A test run must not be able to
 * change a person's settings, and "the tests are careful" is not a mechanism.
 *
 * CINDERPAW_HOME is the one variable every profile path derives from
 * (config.ts::cinderpawHome → paths(), the DB, the journal, the skill sink, the
 * connector store), so pointing it at a fresh temp dir moves all of them at
 * once. A test that genuinely needs a specific home still sets its own — this
 * only supplies the default that used to be "the user's real data".
 *
 * mkdtemp, not a fixed name: two runs in parallel must not share state, and a
 * leftover directory from a previous run must not decide whether this one
 * passes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An explicit home from the developer's environment still wins — both the
// modern name and the legacy one `readEnv` still honours (config.ts::legacyName).
//
// The condition used to name two different variables. The rename made both of
// them CINDERPAW_HOME, so it read `!x && !x` and the comment above it described
// a precedence that no longer existed.
if (!process.env.CINDERPAW_HOME && !process.env.FERAL_HOME) {
  process.env.CINDERPAW_HOME = mkdtempSync(join(tmpdir(), "cinderpaw-test-home-"));
}

// Now make it undeletable.
//
// A single `delete process.env.CINDERPAW_HOME` in a test's `finally` — which is
// what tests/permission-mode.test.ts did — removes this override for every test
// that runs after it in the same process. Those tests then resolve paths
// against the developer's REAL ~/.cinderpaw and write there: on 2026-09-05 that
// put 26,046 rows of test output into a live Evolution Journal, where they read
// as a year of evolution that never happened.
//
// Assignment still works, so a test that wants its own home keeps full control.
// Only removal is refused, and it throws rather than failing quietly — the
// point is that the next test to try this finds out immediately instead of
// corrupting someone's profile silently. This file already says "the tests are
// careful" is not a mechanism; this is the mechanism.
Object.defineProperty(process.env, "CINDERPAW_HOME", {
  value: process.env.CINDERPAW_HOME,
  writable: true,
  enumerable: true,
  configurable: false,
});
