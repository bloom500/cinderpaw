import { describe, it, expect } from 'vitest';
import {
  resolvePerfPolicy,
  deadlineMessage,
  __TEST_DEFAULTS,
  type PerfPolicy,
} from '@/lib/perfPolicy';

const EMPTY_ENV: Record<string, string | undefined> = {};

describe('resolvePerfPolicy — defaults', () => {
  it('local target returns the local defaults', () => {
    const p = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.local.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.local.stallMs);
  });

  it('cloud target returns the cloud defaults', () => {
    const p = resolvePerfPolicy({ isCloud: true, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.cloud.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.cloud.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.cloud.stallMs);
  });

  it('cloud deadlines diverge from local per use-case', () => {
    // Historically asserted `cloud < local` on every dimension, matching the
    // pre-2026-08-22 defaults where cloud TTFT was 30s (typical chat
    // completion) and local TTFT was 90s (slow prefill on consumer hardware).
    // After the TTFT bump (user report: reasoning models on OpenRouter get
    // killed mid-thought), cloud TTFT is now LARGER than local — reasoning
    // models can take minutes to produce the first token via cloud even
    // when local models would already have started streaming. Other
    // dimensions still follow the original relationship. See the paired Rust
    // test `cloud_and_local_deadlines_diverge_per_use_case` in
    // `crates/feral-core/src/perf_policy.rs` for the same explanation.
    const local = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    const cloud = resolvePerfPolicy({ isCloud: true, env: EMPTY_ENV });
    expect(cloud.totalDeadlineMs).toBeLessThan(local.totalDeadlineMs);
    expect(cloud.stallMs).toBeLessThanOrEqual(local.stallMs);
  });

  it('softWarnMs and heartbeatMs are stable across targets', () => {
    const local = resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV });
    const cloud = resolvePerfPolicy({ isCloud: true, env: EMPTY_ENV });
    expect(local.softWarnMs).toBe(cloud.softWarnMs);
    expect(local.heartbeatMs).toBe(cloud.heartbeatMs);
    expect(local.heartbeatMs).toBe(__TEST_DEFAULTS.heartbeatMs);
  });
});

describe('resolvePerfPolicy — env overrides', () => {
  it('FERAL_TTFT_DEADLINE_MS overrides both targets', () => {
    expect(resolvePerfPolicy({ isCloud: false, env: { FERAL_TTFT_DEADLINE_MS: '12345' } }).ttftDeadlineMs).toBe(12345);
    expect(resolvePerfPolicy({ isCloud: true,  env: { FERAL_TTFT_DEADLINE_MS: '12345' } }).ttftDeadlineMs).toBe(12345);
  });

  it('FERAL_TOTAL_DEADLINE_MS overrides both targets', () => {
    const p = resolvePerfPolicy({ isCloud: false, env: { FERAL_TOTAL_DEADLINE_MS: '600000' } });
    expect(p.totalDeadlineMs).toBe(600_000);
  });

  it('FERAL_STALL_MS overrides both targets', () => {
    expect(resolvePerfPolicy({ isCloud: true, env: { FERAL_STALL_MS: '9999' } }).stallMs).toBe(9999);
  });

  it('FERAL_CLOUD_IDLE_TIMEOUT_MS is honored when FERAL_STALL_MS is unset', () => {
    expect(resolvePerfPolicy({ isCloud: true, env: { FERAL_CLOUD_IDLE_TIMEOUT_MS: '7777' } }).stallMs).toBe(7777);
  });

  it('FERAL_STALL_MS wins over FERAL_CLOUD_IDLE_TIMEOUT_MS when both are set', () => {
    const p = resolvePerfPolicy({
      isCloud: true,
      env: { FERAL_CLOUD_IDLE_TIMEOUT_MS: '7777', FERAL_STALL_MS: '8888' },
    });
    expect(p.stallMs).toBe(8888);
  });

  it('invalid env values fall back to defaults', () => {
    const p = resolvePerfPolicy({
      isCloud: false,
      env: {
        FERAL_TTFT_DEADLINE_MS: 'not-a-number',
        FERAL_TOTAL_DEADLINE_MS: '-100',
        FERAL_STALL_MS: '0',
      },
    });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
    expect(p.totalDeadlineMs).toBe(__TEST_DEFAULTS.local.totalDeadlineMs);
    expect(p.stallMs).toBe(__TEST_DEFAULTS.local.stallMs);
  });
});

describe('resolvePerfPolicy — TTFT scaling with prompt size', () => {
  it('no promptTokens → unscaled base TTFT', () => {
    expect(resolvePerfPolicy({ isCloud: false, env: EMPTY_ENV }).ttftDeadlineMs)
      .toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
  });

  it('zero promptTokens → unscaled base TTFT', () => {
    expect(resolvePerfPolicy({ isCloud: false, promptTokens: 0, env: EMPTY_ENV }).ttftDeadlineMs)
      .toBe(__TEST_DEFAULTS.local.ttftDeadlineMs);
  });

  it('1000-token prompt adds 4s to local TTFT', () => {
    const p = resolvePerfPolicy({ isCloud: false, promptTokens: 1000, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.local.ttftDeadlineMs + 1000 * 4);
  });

  it('massive prompt is capped at totalDeadlineMs', () => {
    const p = resolvePerfPolicy({ isCloud: false, promptTokens: 1_000_000, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(p.totalDeadlineMs);
  });

  it('scaling applies to cloud too', () => {
    const p = resolvePerfPolicy({ isCloud: true, promptTokens: 500, env: EMPTY_ENV });
    expect(p.ttftDeadlineMs).toBe(__TEST_DEFAULTS.cloud.ttftDeadlineMs + 500 * 4);
  });
});

describe('deadlineMessage', () => {
  const policy: PerfPolicy = {
    ttftDeadlineMs: 90_000,
    totalDeadlineMs: 300_000,
    stallMs: 45_000,
    softWarnMs: 20_000,
    heartbeatMs: 750,
  };

  it('ttft_timeout starts with the bracketed machine token and quotes the deadline', () => {
    const m = deadlineMessage('ttft_timeout', policy);
    expect(m.startsWith('[ttft_timeout]')).toBe(true);
    expect(m).toContain('90s');
  });

  it('total_timeout mentions the total deadline', () => {
    const m = deadlineMessage('total_timeout', policy);
    expect(m.startsWith('[total_timeout]')).toBe(true);
    expect(m).toContain('300s');
  });

  it('stall_timeout mentions the stall window', () => {
    const m = deadlineMessage('stall_timeout', policy);
    expect(m.startsWith('[stall_timeout]')).toBe(true);
    expect(m).toContain('45s');
  });

  it('engine_unready has its own copy (no deadline to quote)', () => {
    const m = deadlineMessage('engine_unready', policy);
    expect(m.startsWith('[engine_unready]')).toBe(true);
    expect(m).toContain('Reload');
  });
});