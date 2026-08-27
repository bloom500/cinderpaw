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
 * (config.ts::feralHome → paths(), the DB, the journal, the skill sink, the
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

// CINDERPAW_HOME only, deliberately. `readEnv` resolves the modern CINDERPAW_*
// name FIRST and falls back to the legacy one, so setting CINDERPAW_HOME here
// would outrank every test that points CINDERPAW_HOME at its own mkdtemp — and
// those tests would then silently assert against this directory instead of
// theirs. Setting the lower-priority name leaves them in control.
//
// An explicit home from the developer's environment still wins over both.
if (!process.env.CINDERPAW_HOME && !process.env.CINDERPAW_HOME) {
  process.env.CINDERPAW_HOME = mkdtempSync(join(tmpdir(), "cinderpaw-test-home-"));
}
