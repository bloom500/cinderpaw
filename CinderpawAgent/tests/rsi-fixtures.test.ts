/**
 * S3 fixtures: deterministic, free, and honest. Each planted failure must be
 * caught by the checker, fixed by exactly one repair, and the same seed must
 * produce the same repository twice, or the campaign is not paired.
 */
import { describe, expect, test } from "bun:test";
import {
  REPAIRS,
  TEMPLATE_NAMES,
  checkRepo,
  makeFixture,
  partitionedFixtures,
  type Template,
} from "../src/rsi/infra/fixtures.ts";

describe("fixtures", () => {
  test("the same seed is the same repository, byte for byte", () => {
    for (const t of TEMPLATE_NAMES) {
      expect(makeFixture(t, 42).repo).toEqual(makeFixture(t, 42).repo);
      expect(makeFixture(t, 42).repo).not.toEqual(makeFixture(t, 43).repo);
    }
  });

  test("every planted failure is caught, and the checker names it", () => {
    for (const t of TEMPLATE_NAMES) {
      for (let seed = 1; seed <= 8; seed++) {
        const f = makeFixture(t, seed);
        const r = checkRepo(f.repo);
        expect(r.ok).toBe(false);
        expect(r.problems.length).toBeGreaterThan(0);
        expect(f.verify(f.repo)).toBe(false);
      }
    }
  });

  test("exactly one repair fixes each template; the others leave it broken", () => {
    const expected: Record<Template, string> = {
      "missing-dep": "add-missing-dep",
      "bad-env-name": "declare-env-keys",
      "broken-import": "fix-import-paths",
      "stale-engine": "bump-engine",
    };
    for (const t of TEMPLATE_NAMES) {
      for (let seed = 1; seed <= 8; seed++) {
        const f = makeFixture(t, seed);
        const fixers = REPAIRS.filter((r) => f.verify(r.apply(f.repo))).map((r) => r.id);
        expect(fixers).toEqual([expected[t]]);
      }
    }
  });

  test("a repair never breaks a healthy repository", () => {
    for (const t of TEMPLATE_NAMES) {
      const f = makeFixture(t, 5);
      const fixed = REPAIRS.find((r) => f.verify(r.apply(f.repo)))!.apply(f.repo);
      for (const r of REPAIRS) expect(checkRepo(r.apply(fixed)).ok).toBe(true);
    }
  });

  test("partitions hold out whole templates", () => {
    const parts = partitionedFixtures(
      {
        development: ["missing-dep", "bad-env-name"],
        promotion: ["broken-import"],
        final: ["stale-engine"],
        transfer: [],
      },
      3,
    );
    expect(parts.development.map((f) => f.family)).toEqual(["missing-dep", "missing-dep", "missing-dep", "bad-env-name", "bad-env-name", "bad-env-name"]);
    expect(new Set(parts.promotion.map((f) => f.family))).toEqual(new Set(["broken-import"]));
    const ids = Object.values(parts).flat().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
