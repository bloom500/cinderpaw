/**
 * L5 — Governance freeze / fail-closed (B5 e2e smoke, assembled version).
 *
 * Env-gated: CINDERPAW_E2E=1 bun test tests/l5-governance-fail-closed.e2e.test.ts
 *
 * Drives the governance loader through every failure mode and asserts
 * the fail-closed contract from §B5.2 of the hardening spec:
 *   1. Missing `policy.json` → strictest built-in, every layer frozen,
 *      `governanceCheck` returns `{allowed:false, reason:"frozen by
 *      governance (...)"}` for any governed action.
 *   2. Unparseable JSON → file quarantined as
 *      `policy.json.quarantine-<ts>`, runtime boots fail-closed.
 *   3. G0-violating values (out-of-wall budgets / gates) → quarantined
 *      (this is a hand-edit or corruption, not schema drift).
 *   4. Valid genesis-shaped policy → loads as `source: "file"`.
 *
 * The granular tests live in `rsi-governance.test.ts` and
 * `rsi-governance-integration.test.ts`. This file is the assembled
 * end-to-end view a reviewer can read in 60 seconds, with on-disk
 * policy files written into a temp dir. `loadPolicy(dir)` and
 * `governanceCheck(...{dir})` both accept an explicit `dir` arg so
 * the test does NOT touch `~/.cinderpaw/`; the production code path that
 * pins via `defaultGovernanceDir()` is exercised on every install.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builtinFailClosedPolicy,
  defaultGenesisPolicy,
  governanceCheck,
  layerFrozen,
  loadPolicy,
} from "../src/rsi/l5-gov/governance.ts";

const ENABLED = process.env.CINDERPAW_E2E === "1";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe("L5 — governance freeze / fail-closed (CINDERPAW_E2E)", () => {
  it.skipIf(!ENABLED)(
    "missing policy.json → builtin fail-closed, every governanceCheck refused",
    () => {
      const dir = freshDir("cinderpaw-e2e-l5-missing-");
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe("builtin");
      if (loaded.source !== "builtin") throw new Error("unreachable");
      expect(loaded.reason).toMatch(/missing/);
      // The fail-closed builtin must freeze every layer.
      const floor = builtinFailClosedPolicy();
      for (const layer of ["l1", "l2", "l3", "l4", "l6"] as const) {
        expect(floor.frozen[layer]).toBe(true);
      }
      // governanceCheck must refuse every action whose layer is frozen.
      expect(governanceCheck("l3_code_patch_apply", { dir }).allowed).toBe(false);
      expect(governanceCheck("l2_lora_promote", { dir }).allowed).toBe(false);
      expect(governanceCheck("l4_module_promote", { dir }).allowed).toBe(false);
      expect(governanceCheck("l6_evolve", { dir }).allowed).toBe(false);
      expect(governanceCheck("l6_rollback", { dir }).allowed).toBe(false);
      // layerFrozen reflects the same posture.
      expect(layerFrozen("l4", dir).frozen).toBe(true);
      expect(layerFrozen("l1", dir).frozen).toBe(true);
    },
  );

  it.skipIf(!ENABLED)(
    "unparseable policy.json → file quarantined + fail-closed builtin",
    () => {
      const dir = freshDir("cinderpaw-e2e-l5-corrupt-");
      writeFileSync(join(dir, "policy.json"), "{ this is not valid json", "utf8");
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe("builtin");
      if (loaded.source !== "builtin") throw new Error("unreachable");
      // Original file is gone, quarantined copy is at policy.json.quarantine-<ts>.
      expect(existsSync(join(dir, "policy.json"))).toBe(false);
      expect(loaded.quarantinedTo).not.toBeNull();
      const filesLeft = readdirSync(dir);
      const quarantined = filesLeft.filter((f) => f.startsWith("policy.json.quarantine-"));
      expect(quarantined.length).toBe(1);
      // governanceCheck refuses every action (fail-closed builtin has l* all frozen).
      expect(governanceCheck("l4_module_promote", { dir }).allowed).toBe(false);
    },
  );

  it.skipIf(!ENABLED)(
    "G0-violating policy.json (budgets 10× the ceiling) → quarantined + fail-closed",
    () => {
      const dir = freshDir("cinderpaw-e2e-l5-g0-");
      // Take a known-good document, blow one G0 wall (budget 1B tokens;
      // ceiling is 20M).
      const doc = defaultGenesisPolicy();
      const broken = {
        ...doc,
        policyId: "gp-g0-violation",
        budgets: {
          ...doc.budgets,
          episodeMaxTokens: 1_000_000_000,
        },
      };
      writeFileSync(join(dir, "policy.json"), JSON.stringify(broken), "utf8");
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe("builtin");
      if (loaded.source !== "builtin") throw new Error("unreachable");
      expect(loaded.reason).toMatch(/G0 violation/);
      // File quarantined for forensics.
      expect(existsSync(join(dir, "policy.json"))).toBe(false);
      expect(
        readFileSync(loaded.quarantinedTo ?? join(dir, "never"), "utf8"),
      ).toContain("1000000000");
    },
  );

  it.skipIf(!ENABLED)(
    "valid policy.json → loads as source: file; governanceCheck follows its flags",
    () => {
      const dir = freshDir("cinderpaw-e2e-l5-valid-");
      const doc = defaultGenesisPolicy();
      writeFileSync(join(dir, "policy.json"), JSON.stringify(doc), "utf8");
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe("file");
      if (loaded.source !== "file") throw new Error("unreachable");
      expect(loaded.policy.policyId).toBe("gp-1");
      // Genesis is not frozen → l6_evolve is allowed without human approval.
      expect(governanceCheck("l6_evolve", { dir }).allowed).toBe(true);
      // l3 needs human approval even under the genesis policy.
      expect(governanceCheck("l3_code_patch_apply", { dir }).allowed).toBe(false);
      expect(
        governanceCheck("l3_code_patch_apply", { dir, approvalPresent: true }).allowed,
      ).toBe(true);
    },
  );
});

