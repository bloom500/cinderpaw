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

import { afterEach } from "bun:test";
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

// Now stop it being lost.
//
// A single `delete process.env.CINDERPAW_HOME` in a test's `finally` — which is
// what tests/permission-mode.test.ts did — removes this override for every test
// that runs after it in the same process. Those tests then resolve paths
// against the developer's REAL ~/.cinderpaw and write there: on 2026-09-05 that
// put 26,046 rows of test output into a live Evolution Journal, where they read
// as a year of evolution that never happened.
//
// Assignment still works, so a test that wants its own home keeps full control.
// Only REMOVAL is caught, and it fails the test that did it rather than failing
// quietly — the point is that whoever wrote it finds out immediately instead of
// corrupting someone's profile silently.
//
// WHY NOT `Object.defineProperty(process.env, …, { configurable: false })`,
// which is what this was until it broke every test on two platforms: Node
// specifies `process.env` to accept only configurable, writable, enumerable
// data descriptors, and refuses anything else with
// ERR_INVALID_OBJECT_DEFINE_PROPERTY. Bun 1.3.14 happened to allow it; the
// `latest` Bun on the CI runners implements the Node rule. The guard therefore
// threw inside the preload, which meant every one of the 325 test FILES failed
// to load — 0 pass, 325 fail, in 34 ms, on ubuntu-latest and macos-latest, the
// only two platforms the agent suite runs on in CI. A protection that depends
// on a permission the runtime is entitled to refuse is not a protection.
//
// An `afterEach` needs no such permission and blames correctly: it runs
// immediately after the offending test, so that test is the one that fails.
// Restoration happens BEFORE the throw, so everything downstream is safe even
// though something upstream is now red.
const TEST_HOME = process.env.CINDERPAW_HOME;

afterEach(() => {
  if (process.env.CINDERPAW_HOME === undefined && TEST_HOME !== undefined) {
    process.env.CINDERPAW_HOME = TEST_HOME;
    throw new Error(
      "this test deleted process.env.CINDERPAW_HOME. Every test after it would " +
        "have resolved paths against the developer's REAL ~/.cinderpaw and " +
        `written there. It has been restored to ${TEST_HOME}. If the test needs ` +
        "a different home, ASSIGN one (that is allowed) instead of deleting it.",
    );
  }
});
