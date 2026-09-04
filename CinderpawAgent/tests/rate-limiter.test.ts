/**
 * Sliding-window request gate for rate-limited inference endpoints.
 *
 * Time is injected, so these assert the arithmetic (when do we wait, and for
 * exactly how long) without any test actually sleeping.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RPM_BY_HOST,
  RequestRateLimiter,
  backoffMs,
  effectiveLimit,
  parseRetryAfter,
} from "../src/egress/rate-limiter.ts";

const NIM = "https://integrate.api.nvidia.com/v1";
const LOCAL = "http://127.0.0.1:11435";

/** A limiter on a clock the test drives, recording every wait it asks for. */
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  const waits: number[] = [];
  const limiter = new RequestRateLimiter(0, {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms; // the wait "happens"
    },
  });
  return { limiter, waits, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("effectiveLimit", () => {
  test("keeps headroom under the published cap", () => {
    // NIM's 40 must not be spent as 40 — our minute and theirs are not aligned.
    expect(effectiveLimit(40)).toBe(36);
    expect(effectiveLimit(40)).toBeLessThan(DEFAULT_RPM_BY_HOST["integrate.api.nvidia.com"]!);
  });

  test("never falls to zero on a tiny cap", () => {
    expect(effectiveLimit(1)).toBe(1);
  });
});

describe("RequestRateLimiter", () => {
  test("an endpoint with no published cap is never throttled", async () => {
    const { limiter, waits } = fakeClock();
    // The local engine has no limit; throttling it would be pure harm.
    expect(limiter.limitFor(LOCAL)).toBe(0);
    for (let i = 0; i < 500; i++) await limiter.acquire(LOCAL);
    expect(waits).toEqual([]);
  });

  test("NIM is recognised from the published table", () => {
    const { limiter } = fakeClock();
    expect(limiter.limitFor(NIM)).toBe(40);
  });

  test("requests up to the headroomed cap pass without waiting", async () => {
    const { limiter, waits } = fakeClock();
    for (let i = 0; i < 36; i++) await limiter.acquire(NIM);
    expect(waits).toEqual([]);
    expect(limiter.countInWindow(NIM)).toBe(36);
  });

  test("the request that would exceed the cap waits for the oldest to age out", async () => {
    const { limiter, waits, advance } = fakeClock();

    // 36 requests, one per second — the window now holds all of them.
    for (let i = 0; i < 36; i++) {
      await limiter.acquire(NIM);
      advance(1_000);
    }

    // 36s have passed since the first. It ages out of the 60s window 24s from
    // now, so that — not a flat minute — is exactly how long we should wait.
    await limiter.acquire(NIM);

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBe(24_001);
  });

  test("a burst does not stall for a full minute", async () => {
    // The naive design ("we're near the limit, sleep 60s") would cost a minute
    // here. Ageing out one slot costs barely more than the window itself.
    const { limiter, waits } = fakeClock();
    for (let i = 0; i < 36; i++) await limiter.acquire(NIM); // same instant
    await limiter.acquire(NIM);

    expect(waits[0]).toBe(60_001);
    // ...and the NEXT one rides through, because 36 slots freed at once.
    await limiter.acquire(NIM);
    expect(waits).toHaveLength(1);
  });

  test("counts are per endpoint, not global", async () => {
    const { limiter, waits } = fakeClock();
    for (let i = 0; i < 36; i++) await limiter.acquire(NIM);
    // A different endpoint must not inherit NIM's exhausted window.
    for (let i = 0; i < 50; i++) await limiter.acquire(LOCAL);
    expect(waits).toEqual([]);
  });

  test("a stop during the throttle wait aborts instead of hanging", async () => {
    const ac = new AbortController();
    const limiter = new RequestRateLimiter(0, {
      now: () => 1_000_000,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    for (let i = 0; i < 36; i++) await limiter.acquire(NIM, ac.signal);

    const pending = limiter.acquire(NIM, ac.signal);
    ac.abort("user stop");

    // The user pressed stop. Waiting out the rate limit first would be absurd.
    expect(pending).rejects.toBe("user stop");
  });

  test("an explicit override applies to every endpoint", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const limiter = new RequestRateLimiter(10, {
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });

    expect(limiter.limitFor(LOCAL)).toBe(10);
    for (let i = 0; i < 9; i++) await limiter.acquire(LOCAL); // effective = 9
    expect(waits).toEqual([]);
    await limiter.acquire(LOCAL);
    expect(waits).toHaveLength(1);
  });

  test("note() counts a request that skipped the gate", () => {
    const { limiter } = fakeClock();
    // A 429'd attempt still spent one of the provider's slots.
    limiter.note(NIM);
    limiter.note(NIM);
    expect(limiter.countInWindow(NIM)).toBe(2);
    // Unlimited endpoints stay uncounted.
    limiter.note(LOCAL);
    expect(limiter.countInWindow(LOCAL)).toBe(0);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-07-13T10:00:00Z");

  test("reads delta-seconds", () => {
    expect(parseRetryAfter("20", NOW)).toBe(20_000);
  });

  test("reads an HTTP-date", () => {
    expect(parseRetryAfter("Mon, 13 Jul 2026 10:00:30 GMT", NOW)).toBe(30_000);
  });

  test("a date already in the past is zero, never negative", () => {
    expect(parseRetryAfter("Mon, 13 Jul 2026 09:59:00 GMT", NOW)).toBe(0);
  });

  test("absent or unparseable yields null so the caller backs off instead", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
  });
});

describe("backoffMs", () => {
  test("doubles per attempt", () => {
    const noJitter = () => 0.5; // → factor 1.0
    expect(backoffMs(0, noJitter)).toBe(1000);
    expect(backoffMs(1, noJitter)).toBe(2000);
    expect(backoffMs(2, noJitter)).toBe(4000);
  });

  test("is jittered, so concurrent sessions do not retry in lockstep", () => {
    // Same attempt, different draws must not produce the same delay.
    expect(backoffMs(1, () => 0)).not.toBe(backoffMs(1, () => 1));
  });
});
