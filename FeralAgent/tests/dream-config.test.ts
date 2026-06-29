/**
 * Dream Cycle — scheduler config + cloud anti-burn gate tests.
 *
 * Two contracts pinned here:
 *   1. `resolveDreamConfig`:
 *      a. Empty env yields the exact defaults documented in
 *         `dream-config.ts`. The boot wiring assumes these values when
 *         no operator override is set, so they must be stable.
 *      b. Each FERAL_RSI_* knob honours a valid override and falls back
 *         to its default on anything that doesn't parse as a positive
 *         finite number (same `positive` discipline as
 *         `episode-options.ts`).
 *      c. `errorThreshold` is additionally floored and clamped to >= 1
 *         so a 0/negative override can't re-introduce "dream on every
 *         error" thrashing.
 *      d. `stopOnActivity` is strict: only "true" / "1" (case-insensitive,
 *         whitespace-trimmed) are truthy. "yes", "on", "" all return false.
 *   2. `dreamCloudGate`:
 *      a. Loopback → enabled, reason mentions "loopback" / "local".
 *      b. Cloud + FERAL_RSI_ALLOW_CLOUD="true" or "1" → enabled, reason
 *         mentions the knob name.
 *      c. Cloud + no opt-in (undefined / "false" / "0") → disabled,
 *         reason names the knob that would unlock it.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveDreamConfig,
  dreamCloudGate,
} from "../src/rsi/dream-config.ts";

describe("resolveDreamConfig — defaults", () => {
  test("empty env yields exactly the documented defaults", () => {
    const c = resolveDreamConfig({});
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorThreshold).toBe(3);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
    expect(c.stopOnActivity).toBe(false);
  });

  test("defaults match the contract types and are all finite numbers (except the boolean)", () => {
    const c = resolveDreamConfig({});
    expect(Number.isFinite(c.idleThresholdMs)).toBe(true);
    expect(Number.isFinite(c.cooldownMs)).toBe(true);
    expect(Number.isFinite(c.errorThreshold)).toBe(true);
    expect(Number.isFinite(c.errorWindowMs)).toBe(true);
    expect(Number.isFinite(c.pollMs)).toBe(true);
    expect(typeof c.stopOnActivity).toBe("boolean");
  });
});

describe("resolveDreamConfig — env overrides (each knob)", () => {
  test("FERAL_RSI_IDLE_MS overrides idleThresholdMs", () => {
    expect(resolveDreamConfig({ FERAL_RSI_IDLE_MS: "90000" }).idleThresholdMs).toBe(90_000);
    expect(resolveDreamConfig({ FERAL_RSI_IDLE_MS: "600000" }).idleThresholdMs).toBe(600_000);
  });

  test("FERAL_RSI_COOLDOWN_MS overrides cooldownMs", () => {
    expect(resolveDreamConfig({ FERAL_RSI_COOLDOWN_MS: "300000" }).cooldownMs).toBe(300_000);
    expect(resolveDreamConfig({ FERAL_RSI_COOLDOWN_MS: "1200000" }).cooldownMs).toBe(1_200_000);
  });

  test("FERAL_RSI_ERROR_WINDOW_MS overrides errorWindowMs", () => {
    expect(
      resolveDreamConfig({ FERAL_RSI_ERROR_WINDOW_MS: "60000" }).errorWindowMs,
    ).toBe(60_000);
    expect(
      resolveDreamConfig({ FERAL_RSI_ERROR_WINDOW_MS: "3600000" }).errorWindowMs,
    ).toBe(3_600_000);
  });

  test("FERAL_RSI_POLL_MS overrides pollMs", () => {
    expect(resolveDreamConfig({ FERAL_RSI_POLL_MS: "5000" }).pollMs).toBe(5_000);
    expect(resolveDreamConfig({ FERAL_RSI_POLL_MS: "60000" }).pollMs).toBe(60_000);
  });

  test("all numeric knobs can be set together and don't bleed into each other", () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "120000",
      FERAL_RSI_COOLDOWN_MS: "300000",
      FERAL_RSI_ERROR_THRESHOLD: "5",
      FERAL_RSI_ERROR_WINDOW_MS: "1800000",
      FERAL_RSI_POLL_MS: "15000",
      FERAL_RSI_STOP_ON_ACTIVITY: "true",
    });
    expect(c).toEqual({
      idleThresholdMs: 120_000,
      cooldownMs: 300_000,
      errorThreshold: 5,
      errorWindowMs: 1_800_000,
      pollMs: 15_000,
      stopOnActivity: true,
    });
  });
});

describe("resolveDreamConfig — invalid numeric values fall back to defaults", () => {
  test("non-numeric strings fall back to the default", () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "abc",
      FERAL_RSI_COOLDOWN_MS: "many",
      FERAL_RSI_ERROR_WINDOW_MS: "NaN",
      FERAL_RSI_POLL_MS: "soon",
    });
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
  });

  test("empty strings fall back to the default", () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "",
      FERAL_RSI_COOLDOWN_MS: "",
      FERAL_RSI_ERROR_WINDOW_MS: "",
      FERAL_RSI_POLL_MS: "",
    });
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
  });

  test('"0" values fall back to the default (positive parser refuses 0)', () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "0",
      FERAL_RSI_COOLDOWN_MS: "0",
      FERAL_RSI_ERROR_WINDOW_MS: "0",
      FERAL_RSI_POLL_MS: "0",
    });
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
  });

  test("negative values fall back to the default (positive parser refuses < 0)", () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "-1",
      FERAL_RSI_COOLDOWN_MS: "-60000",
      FERAL_RSI_ERROR_WINDOW_MS: "-1000",
      FERAL_RSI_POLL_MS: "-30",
    });
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
  });

  test("Infinity and NaN strings fall back to the default", () => {
    const c = resolveDreamConfig({
      FERAL_RSI_IDLE_MS: "Infinity",
      FERAL_RSI_COOLDOWN_MS: "-Infinity",
      FERAL_RSI_ERROR_WINDOW_MS: "NaN",
      FERAL_RSI_POLL_MS: "Infinity",
    });
    expect(c.idleThresholdMs).toBe(3 * 60_000);
    expect(c.cooldownMs).toBe(10 * 60_000);
    expect(c.errorWindowMs).toBe(15 * 60_000);
    expect(c.pollMs).toBe(30_000);
  });
});

describe("resolveDreamConfig — errorThreshold clamp (min 1, floored)", () => {
  test("empty env → 3 (the default)", () => {
    expect(resolveDreamConfig({}).errorThreshold).toBe(3);
  });

  test('"0" → 1 (clamped up to the min, not the default of 3)', () => {
    // The min-1 clamp fires before the default fallback — the operator
    // wrote "0" which is invalid, but we still salvage a meaningful
    // threshold rather than silently using 3.
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "0" }).errorThreshold).toBe(1);
  });

  test('"-2" → 1 (positive parser refuses negatives, then min-1 clamp)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "-2" }).errorThreshold).toBe(1);
  });

  test('"5" → 5 (valid override honoured exactly)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "5" }).errorThreshold).toBe(5);
  });

  test('"1" → 1 (boundary — exactly the min, not clamped)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "1" }).errorThreshold).toBe(1);
  });

  test('"2.9" → 2 (floored before clamping)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "2.9" }).errorThreshold).toBe(2);
  });

  test('"100" → 100 (large values are not clamped upward)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "100" }).errorThreshold).toBe(100);
  });

  test('"abc" / "" / "NaN" → 3 (the default; the positive parser fell back)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "abc" }).errorThreshold).toBe(3);
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "" }).errorThreshold).toBe(3);
    expect(resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: "NaN" }).errorThreshold).toBe(3);
  });
});

describe("resolveDreamConfig — errorThreshold table-driven (the salvage path)", () => {
  // Single source of truth for how every FERAL_RSI_ERROR_THRESHOLD string
  // maps to a numeric `errorThreshold`. The chain in dream-config.ts is:
  //   finite(env, 3) → accepts any finite number including 0/negatives
  //   Math.floor(...) → rounds toward −∞
  //   Math.max(1, ...) → clamps up to the min
  //
  // The two non-trivial branches:
  //   * 0 / 0.5 / negatives → round down to ≤0, then salvage to 1 (the
  //     explicit anti-thrashing clamp; this row is the audit pin)
  //   * non-finite / unparseable → fall back to the default 3
  //
  // Adding or removing a row is a contract change — a regression here means
  // a typo like `FERAL_RSI_ERROR_THRESHOLD=0` could re-introduce the
  // "dream on every error" thrashing this scheduler replaces.
  type Row = { env: string; expected: number; note: string };
  const TABLE: Row[] = [
    // ── Salvage path: parses, clamps up to 1 ──────────────────────────────
    { env: "0",         expected: 1,        note: "0 rounds to 0 then salvages to 1" },
    { env: "0.5",       expected: 1,        note: "0.5 floors to 0 then salvages to 1" },
    { env: "-0.5",      expected: 1,        note: "negative floors to -1 then salvages to 1" },
    { env: "-1",        expected: 1,        note: "-1 floors to -1 then salvages to 1" },
    { env: "-2.9",      expected: 1,        note: "-2.9 floors to -3 then salvages to 1" },
    // ── Exact boundary ─────────────────────────────────────────────────────
    { env: "1",         expected: 1,        note: "exact min, not over-clamped" },
    { env: "2.9",       expected: 2,        note: "floored before clamping" },
    // ── Large / scientific ────────────────────────────────────────────────
    { env: "100",       expected: 100,      note: "no upper clamp" },
    { env: "1000000",   expected: 1_000_000, note: "no upper clamp (millions)" },
    { env: "1e3",       expected: 1_000,    note: "scientific notation parses" },
    // ── Unparseable / non-finite → default fallback ────────────────────────
    { env: "",          expected: 3,        note: "empty string → default 3" },
    { env: "abc",       expected: 3,        note: "non-numeric → default 3" },
    { env: "NaN",       expected: 3,        note: "NaN literal → default 3" },
    { env: "Infinity",  expected: 3,        note: "Infinity is non-finite → default 3" },
    { env: "-Infinity", expected: 3,        note: "-Infinity is non-finite → default 3" },
    // ── Whitespace and sign quirks ────────────────────────────────────────
    { env: " 1 ",       expected: 1,        note: "Number(' 1 ') = 1 (whitespace tolerated)" },
    { env: " 0 ",       expected: 1,        note: "Number(' 0 ') = 0 → salvages to 1" },
    { env: "1.0",       expected: 1,        note: "1.0 floors to 1, not salvaged" },
    { env: "0.0",       expected: 1,        note: "0.0 floors to 0 → salvages to 1" },
  ];

  for (const row of TABLE) {
    test(`FERAL_RSI_ERROR_THRESHOLD="${row.env}" → ${row.expected}  (${row.note})`, () => {
      expect(
        resolveDreamConfig({ FERAL_RSI_ERROR_THRESHOLD: row.env }).errorThreshold,
      ).toBe(row.expected);
    });
  }

  test("every salvage-path row uses the min-1 clamp, not the default 3", () => {
    // The contract: when the env is unparseable, fall back to the default.
    // When the env IS parseable but the value is ≤ 0, salvage to 1 (do NOT
    // silently fall back to 3 — the operator wrote a number, respect that
    // they meant *something*).
    const salvageRows = TABLE.filter(
      (r) => r.env !== "" && Number.isFinite(Number(r.env)) && Number(r.env) <= 0,
    );
    expect(salvageRows.length).toBeGreaterThan(0);
    for (const row of salvageRows) {
      expect(row.expected).toBe(1);
    }
  });
});

describe("dreamCloudGate — ALLOW_CLOUD typo & non-allowlist truth table", () => {
  // The strict truthy parser (`truthy`) accepts ONLY the literal "true" /
  // "1" (case-insensitive, whitespace-trimmed). Every other input — even
  // ones that *look* truthy to a human — must keep the cloud gate closed.
  // The 0/negative/false branch is already covered above; this block adds
  // the human-typo matrix.
  type Row = { input: string | undefined; expectedEnabled: boolean; note: string };
  const TABLE: Row[] = [
    // ── Truthy — opens the gate ───────────────────────────────────────────
    { input: "true",   expectedEnabled: true,  note: "canonical truthy" },
    { input: "TRUE",   expectedEnabled: true,  note: "uppercase" },
    { input: "True",   expectedEnabled: true,  note: "title case" },
    { input: "1",      expectedEnabled: true,  note: "numeric 1" },
    { input: " 1 ",    expectedEnabled: true,  note: "whitespace around 1" },
    { input: " true ", expectedEnabled: true,  note: "whitespace around true" },
    // ── Falsy — keeps the gate closed ─────────────────────────────────────
    { input: "false",  expectedEnabled: false, note: "canonical false" },
    { input: "0",      expectedEnabled: false, note: "numeric 0" },
    { input: "",       expectedEnabled: false, note: "empty string" },
    { input: undefined, expectedEnabled: false, note: "unset env" },
    // ── Typos & look-alikes — must stay CLOSED ────────────────────────────
    { input: "yes",    expectedEnabled: false, note: "english yes — not in allow-list" },
    { input: "YES",    expectedEnabled: false, note: "uppercase yes" },
    { input: "y",      expectedEnabled: false, note: "single-char y" },
    { input: "Y",      expectedEnabled: false, note: "single-char Y" },
    { input: "on",     expectedEnabled: false, note: "on (legacy alias)" },
    { input: "ON",     expectedEnabled: false, note: "ON (uppercase)" },
    { input: "enabled", expectedEnabled: false, note: "enabled" },
    { input: "YeS",    expectedEnabled: false, note: "case-shuffled yes" },
    { input: "ttrue",  expectedEnabled: false, note: "double-t typo" },
    { input: "tru",    expectedEnabled: false, note: "truncated true" },
    { input: "ture",   expectedEnabled: false, note: "misspelled" },
    { input: "truee",  expectedEnabled: false, note: "trailing-e typo" },
    { input: "truw",   expectedEnabled: false, note: "transposed letters" },
    { input: "True ",  expectedEnabled: true,  note: "trailing space still parses (trimmed)" },
    { input: " true",  expectedEnabled: true,  note: "leading space still parses (trimmed)" },
    // ── Numeric look-alikes — must stay CLOSED ────────────────────────────
    { input: "0.1",    expectedEnabled: false, note: "0.1 ≠ 1, not 0" },
    { input: "1.0",    expectedEnabled: false, note: "1.0 ≠ literal '1'" },
    { input: "-1",     expectedEnabled: false, note: "negative 1" },
    { input: "2",      expectedEnabled: false, note: "numeric 2" },
    { input: "01",     expectedEnabled: false, note: "leading-zero 01 ≠ '1'" },
  ];

  for (const row of TABLE) {
    const label = row.input === undefined ? "(unset)" : `"${row.input}"`;
    test(`cloud + ALLOW_CLOUD=${label} → enabled=${row.expectedEnabled}  (${row.note})`, () => {
      const env: Record<string, string | undefined> =
        row.input === undefined ? {} : { FERAL_RSI_ALLOW_CLOUD: row.input };
      const d = dreamCloudGate(env, { isLoopback: false });
      expect(d.enabled).toBe(row.expectedEnabled);
    });
  }
});

describe("dreamCloudGate — full loopback × ALLOW_CLOUD matrix", () => {
  // 2×N truth table. Pin every cell so a future branch-order swap (e.g.
  // ALLOW_CLOUD accidentally checked BEFORE loopback) fails the test
  // instead of silently allowing cloud dreams.
  type Cell = {
    isLoopback: boolean;
    allowCloud: string | undefined;
    expectedEnabled: boolean;
    /** substring that the reason MUST contain (lowercase compare). */
    reasonMustInclude: string;
  };
  const MATRIX: Cell[] = [
    // ── Loopback: gate is open REGARDLESS of ALLOW_CLOUD ──────────────────
    { isLoopback: true,  allowCloud: undefined,  expectedEnabled: true,  reasonMustInclude: "loopback" },
    { isLoopback: true,  allowCloud: "false",    expectedEnabled: true,  reasonMustInclude: "loopback" },
    { isLoopback: true,  allowCloud: "0",        expectedEnabled: true,  reasonMustInclude: "loopback" },
    { isLoopback: true,  allowCloud: "yes",      expectedEnabled: true,  reasonMustInclude: "loopback" },
    { isLoopback: true,  allowCloud: "true",     expectedEnabled: true,  reasonMustInclude: "loopback" },
    // ── Cloud + opted-in ──────────────────────────────────────────────────
    { isLoopback: false, allowCloud: "true",     expectedEnabled: true,  reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "1",        expectedEnabled: true,  reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "  TRUE ",  expectedEnabled: true,  reasonMustInclude: "feral_rsi_allow_cloud" },
    // ── Cloud + not opted-in (refusal — the safety default) ──────────────
    { isLoopback: false, allowCloud: undefined,  expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "",         expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "false",    expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "0",        expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "yes",      expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
    { isLoopback: false, allowCloud: "on",       expectedEnabled: false, reasonMustInclude: "feral_rsi_allow_cloud" },
  ];

  for (const cell of MATRIX) {
    const envStr = cell.allowCloud === undefined ? "(unset)" : `"${cell.allowCloud}"`;
    test(
      `isLoopback=${cell.isLoopback}, ALLOW_CLOUD=${envStr} → enabled=${cell.expectedEnabled}, reason contains "${cell.reasonMustInclude}"`,
      () => {
        const env: Record<string, string | undefined> =
          cell.allowCloud === undefined ? {} : { FERAL_RSI_ALLOW_CLOUD: cell.allowCloud };
        const d = dreamCloudGate(env, { isLoopback: cell.isLoopback });
        expect(d.enabled).toBe(cell.expectedEnabled);
        expect(d.reason.toLowerCase()).toContain(cell.reasonMustInclude);
      },
    );
  }

  test("the loopback branch is checked BEFORE the ALLOW_CLOUD branch", () => {
    // A defensive pin: even with ALLOW_CLOUD explicitly FALSE, a loopback
    // endpoint must win. (This is the same contract as the existing test
    // above, but stated as a branch-order invariant so a future swap that
    // short-circuits on ALLOW_CLOUD first fails this assertion.)
    const d = dreamCloudGate({ FERAL_RSI_ALLOW_CLOUD: "false" }, { isLoopback: true });
    expect(d.enabled).toBe(true);
    expect(d.reason.toLowerCase()).not.toContain("feral_rsi_allow_cloud");
  });
});

describe("resolveDreamConfig — stopOnActivity boolean (strict truthy)", () => {
  test('"true" → true', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "true" }).stopOnActivity).toBe(true);
  });

  test('"1" → true', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "1" }).stopOnActivity).toBe(true);
  });

  test('"TRUE" → true (case-insensitive)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "TRUE" }).stopOnActivity).toBe(true);
  });

  test('"True" → true (mixed case)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "True" }).stopOnActivity).toBe(true);
  });

  test('"  true  " → true (whitespace-trimmed)', () => {
    expect(
      resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "  true  " }).stopOnActivity,
    ).toBe(true);
  });

  test('" 1 " → true (whitespace-trimmed around "1")', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: " 1 " }).stopOnActivity).toBe(true);
  });

  test('"false" → false', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "false" }).stopOnActivity).toBe(false);
  });

  test('"0" → false', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "0" }).stopOnActivity).toBe(false);
  });

  test('"" → false (empty string)', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "" }).stopOnActivity).toBe(false);
  });

  test('"yes" → false (not in the strict allow-list)', () => {
    // Strict on purpose: a typo / legacy alias must not accidentally
    // enable aggressive cancellation.
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "yes" }).stopOnActivity).toBe(false);
  });

  test('"on" → false', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "on" }).stopOnActivity).toBe(false);
  });

  test('"enabled" → false', () => {
    expect(resolveDreamConfig({ FERAL_RSI_STOP_ON_ACTIVITY: "enabled" }).stopOnActivity).toBe(false);
  });

  test("undefined → false (default)", () => {
    expect(resolveDreamConfig({}).stopOnActivity).toBe(false);
  });

  test("an unrelated env key does not flip stopOnActivity", () => {
    expect(resolveDreamConfig({ FERAL_RSI_POLL_MS: "5000" }).stopOnActivity).toBe(false);
  });
});

describe("dreamCloudGate — local (loopback) branch", () => {
  test("isLoopback=true with empty env → enabled, reason mentions loopback/local", () => {
    const d = dreamCloudGate({}, { isLoopback: true });
    expect(d.enabled).toBe(true);
    expect(d.reason).not.toBe("");
    // Reason should make the local case obvious to a human reading logs.
    expect(d.reason.toLowerCase()).toContain("loopback");
    expect(d.reason.toLowerCase()).toContain("local");
  });

  test("isLoopback=true beats a missing FERAL_RSI_ALLOW_CLOUD (no opt-in needed)", () => {
    // The whole point of the loopback branch: dreams are free and
    // local, so we don't gate on FERAL_RSI_ALLOW_CLOUD here.
    const d = dreamCloudGate({}, { isLoopback: true });
    expect(d.enabled).toBe(true);
  });

  test("isLoopback=true still wins even if FERAL_RSI_ALLOW_CLOUD is explicitly false", () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "false" },
      { isLoopback: true },
    );
    expect(d.enabled).toBe(true);
  });
});

describe("dreamCloudGate — cloud + opted-in branch", () => {
  test('cloud + FERAL_RSI_ALLOW_CLOUD="true" → enabled, reason mentions the knob', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "true" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(true);
    expect(d.reason).not.toBe("");
    expect(d.reason).toContain("FERAL_RSI_ALLOW_CLOUD");
    expect(d.reason.toLowerCase()).toContain("cloud");
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="1" → enabled (the second truthy value)', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "1" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(true);
    expect(d.reason).toContain("FERAL_RSI_ALLOW_CLOUD");
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="TRUE" → enabled (case-insensitive)', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "TRUE" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(true);
  });
});

describe("dreamCloudGate — cloud + not opted-in branch (the refusal)", () => {
  test("cloud + no FERAL_RSI_ALLOW_CLOUD → disabled, reason names the knob", () => {
    const d = dreamCloudGate({}, { isLoopback: false });
    expect(d.enabled).toBe(false);
    expect(d.reason).not.toBe("");
    // The reason must tell the operator exactly which knob to set —
    // otherwise the next debugging session becomes a grep exercise.
    expect(d.reason).toContain("FERAL_RSI_ALLOW_CLOUD");
    expect(d.reason.toLowerCase()).toContain("cloud");
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="false" → disabled (not a truthy opt-in)', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "false" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain("FERAL_RSI_ALLOW_CLOUD");
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="0" → disabled', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "0" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(false);
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="" → disabled (empty string is not an opt-in)', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(false);
  });

  test('cloud + FERAL_RSI_ALLOW_CLOUD="yes" → disabled (not in the strict allow-list)', () => {
    const d = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "yes" },
      { isLoopback: false },
    );
    expect(d.enabled).toBe(false);
  });

  test("the refusal reason is distinct from the opt-in reason", () => {
    // Operators who read the log should be able to tell "refused" from
    // "allowed via opt-in" without checking the boolean field.
    const refused = dreamCloudGate({}, { isLoopback: false });
    const optedIn = dreamCloudGate(
      { FERAL_RSI_ALLOW_CLOUD: "true" },
      { isLoopback: false },
    );
    expect(refused.reason).not.toBe(optedIn.reason);
  });
});
