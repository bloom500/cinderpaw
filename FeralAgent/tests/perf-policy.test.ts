/**
 * PerfPolicy resolver tests.
 *
 * These tests assert real return values from `resolvePerfPolicy` —
 * no stubbing, no mocks. The resolver is a pure function (modulo the
 * env read) so the tests only need to inject `env` to cover every
 * branch. If the resolver were deleted, every assertion here would
 * fail loudly with "is not a function", which is exactly the
 * "no-green-stub" bar from the MiniMax prompt's guardrail #2.
 */

import { describe, expect, test } from "bun:test";
import {
  deadlineMessage,
  resolvePerfPolicy,
  __TEST_DEFAULTS,
  type PerfPolicy,
} from "../src/egress/perf-policy.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("resolvePerfPolicy — defaults", () => {
  test("local target returns the local defaults", () => {
    const p = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.local.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.local.stallMs);
    expect(p.softWarnMs).toBe(__TEST_DEFAULTS.softWarnMs);
    expect(p.heartbeatMs).toBe(__TEST_DEFAULTS.heartbeatMs);
  });

  test("cloud target returns the cloud defaults", () => {
    const p = resolvePerfPolicy({ isCloud: true, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.cloud.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.cloud.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.cloud.stallMs);
  });

  test("deadlines diverge per use case after the 2026-08/09 cloud bumps", () => {
    // Historically asserted `cloud < local` on every dimension, matching the
    // pre-2026-08-22 defaults where cloud TTFT was 30s and cloud total 120s.
    // After the cloud TTFT bump (30s → 300s, reasoning models on OpenRouter
    // killed mid-thought) and the cloud total bump (120s → 600s, audit fix:
    // total must be >= scaled TTFT or the TTFT bump is dead configuration —
    // the total timer aborts first and the user always sees total_timeout),
    // BOTH cloud ceilings are now LARGER than local. Cloud keeps the tight
    // stall window: network silence means a dead connection, not slow-but-
    // working prefill. Same explanation as the paired Rust test
    // `cloud_and_local_deadlines_diverge_per_use_case` in
    // crates/feral-core/src/perf_policy.rs.
    const local = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    const cloud = resolvePerfPolicy({ isCloud: true, env: EMPTY_ENV });
    expect(cloud.ttftDeadlineMs).toBeGreaterThan(local.ttftDeadlineMs);
    expect(cloud.totalDeadlineMs).toBeGreaterThan(local.totalDeadlineMs);
    expect(cloud.stallMs).toBeLessThanOrEqual(local.stallMs);
    // Invariant that makes the deadlines coherent at all: the total ceiling
    // is never below the base TTFT (otherwise the TTFT timer can never fire).
    expect(cloud.totalDeadlineMs).toBeGreaterThanOrEqual(cloud.ttftDeadlineMs);
    expect(local.totalDeadlineMs).toBeGreaterThanOrEqual(local.ttftDeadlineMs);
  });
});

describe("resolvePerfPolicy — env overrides", () => {
  test("FERAL_TTFT_DEADLINE_MS overrides both targets", () => {
    const local = resolvePerfPolicy({
      isCloud: false,
      env: { FERAL_TTFT_DEADLINE_MS: "12345" },
    });
    const cloud = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_TTFT_DEADLINE_MS: "12345" },
    });
    expect(local.ttftDeadlineMs).toBe(12345);
    expect(cloud.ttftDeadlineMs).toBe(12345);
  });

  test("FERAL_TOTAL_DEADLINE_MS overrides both targets", () => {
    const p = resolvePerfPolicy({
      isCloud: false,
      env: { FERAL_TOTAL_DEADLINE_MS: "600000" },
    });
    expect(p.totalDeadlineMs).toBe(600_000);
  });

  test("FERAL_STALL_MS overrides both targets", () => {
    const p = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_STALL_MS: "9999" },
    });
    expect(p.stallMs).toBe(9999);
  });

  test("FERAL_CLOUD_IDLE_TIMEOUT_MS still overrides cloud stallMs (back-compat)", () => {
    const p = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_CLOUD_IDLE_TIMEOUT_MS: "7777" },
    });
    expect(p.stallMs).toBe(7777);
  });

  test("FERAL_STALL_MS wins over FERAL_CLOUD_IDLE_TIMEOUT_MS when both are set", () => {
    const p = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_CLOUD_IDLE_TIMEOUT_MS: "7777", FERAL_STALL_MS: "8888" },
    });
    expect(p.stallMs).toBe(8888);
  });

  test("invalid env values fall back to defaults (no crash)", () => {
    const p = resolvePerfPolicy({
      isCloud: false,
      env: {
        FERAL_TTFT_DEADLINE_MS: "not-a-number",
        FERAL_TOTAL_DEADLINE_MS: "-100",
        FERAL_STALL_MS: "0",
      },
    });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.local.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.local.stallMs);
  });

  test("empty string env values fall back to defaults", () => {
    const p = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_TTFT_DEADLINE_MS: "" },
    });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.cloud.ttftDeadlineMs);
  });
});

describe("resolvePerfPolicy — TTFT scaling with prompt size", () => {
  test("no promptTokens → unscaled base TTFT", () => {
    const p = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
  });

  test("zero promptTokens → unscaled base TTFT", () => {
    const p = resolvePerfPolicy({
      isCloud: false,
      promptTokens: 0,
      env: EMPTY_ENV,
    });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
  });

  test("large prompt → TTFT scales by 4ms/token on top of the base", () => {
    const base = __TEST_DEFAULTS.local.ttftDeadlineMs;
    const p = resolvePerfPolicy({
      isCloud: false,
      promptTokens: 1000,
      env: EMPTY_ENV,
    });
    // 90_000 base + 1000 * 4 = 4_000 extra → 94_000 total.
    expect(p.ttftDeadlineMs).toBe(base + 1000 * __TEST_DEFAULTS.perTokenPrefillMs);
  });

  test("huge prompt → scaled TTFT is capped at totalDeadlineMs", () => {
    const p = resolvePerfPolicy({
      isCloud: false,
      promptTokens: 1_000_000, // would otherwise scale to 4.09M ms
      env: EMPTY_ENV,
    });
    expect(p.ttftDeadlineMs).toBe(p.totalDeadlineMs);
  });

  test("scalling applies to cloud too", () => {
    const base = __TEST_DEFAULTS.cloud.ttftDeadlineMs;
    const p = resolvePerfPolicy({
      isCloud: true,
      promptTokens: 500,
      env: EMPTY_ENV,
    });
    expect(p.ttftDeadlineMs).toBe(base + 500 * __TEST_DEFAULTS.perTokenPrefillMs);
  });
});

describe("deadlineMessage", () => {
  const policy: PerfPolicy = {
    ttftDeadlineMs: 90_000,
    totalDeadlineMs: 300_000,
    stallMs: 45_000,
    softWarnMs: 20_000,
    heartbeatMs: 750,
  };

  test("ttft_timeout line starts with the bracketed machine token", () => {
    const m = deadlineMessage("ttft_timeout", policy);
    expect(m.startsWith("[ttft_timeout]")).toBe(true);
    expect(m).toContain("90s");
  });

  test("total_timeout mentions the total deadline", () => {
    const m = deadlineMessage("total_timeout", policy);
    expect(m.startsWith("[total_timeout]")).toBe(true);
    expect(m).toContain("300s");
  });

  test("stall_timeout mentions the stall window", () => {
    const m = deadlineMessage("stall_timeout", policy);
    expect(m.startsWith("[stall_timeout]")).toBe(true);
    expect(m).toContain("45s");
  });

  test("engine_unready has its own copy (no deadline to quote)", () => {
    const m = deadlineMessage("engine_unready", policy);
    expect(m.startsWith("[engine_unready]")).toBe(true);
    expect(m).toContain("Reload");
  });
});