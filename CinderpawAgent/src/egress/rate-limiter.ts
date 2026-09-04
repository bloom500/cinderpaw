/**
 * Client-side request rate limiting for inference endpoints.
 *
 * Providers publish a requests-per-minute cap (NVIDIA NIM's free tier is 40
 * RPM). Nothing in Cinderpaw counted requests, so the limit was discovered the
 * expensive way: the first task that fanned out into a handful of tool calls
 * spent one request per agent-loop iteration, tripped the cap, and every
 * subsequent call came back 429 — the agent fell over mid-task.
 *
 * The unit that matters is the REQUEST, not the token: a long generation is one
 * request no matter how many tokens it streams. What burns the budget is the
 * agent loop, where each tool round-trip costs another completion.
 *
 * This gate holds a sliding 60s window of send timestamps per endpoint. When
 * the next request would exceed the cap it waits exactly long enough for the
 * oldest one to age out of the window — usually a couple of seconds, not the
 * full minute. It is deliberately NOT a "sleep a minute when we get close"
 * rule: that would stall the agent far longer than the limit requires.
 *
 * Two things this is not:
 *   - A guarantee. The count is local, so a key used from somewhere else at the
 *     same time is invisible here. The 429 handling in the providers is the
 *     backstop; this gate is what makes a 429 rare rather than routine.
 *   - A token-budget. That already exists in InferenceRouter and is unrelated.
 */

/** Fraction of the published limit actually spent. See `effectiveLimit`. */
const HEADROOM = 0.9;

const WINDOW_MS = 60_000;

/**
 * Published per-minute request caps for endpoints known to enforce one,
 * keyed by hostname.
 *
 * NVIDIA NIM's free tier is 40 RPM. Endpoints absent from this table are
 * unlimited unless `CINDERPAW_RATE_LIMIT_RPM` says otherwise — notably the local
 * engine, which has no cap and must never be throttled.
 */
export const DEFAULT_RPM_BY_HOST: Readonly<Record<string, number>> = {
  "integrate.api.nvidia.com": 40,
};

/**
 * Spend only HEADROOM of the published cap.
 *
 * The server's minute and ours are not the same minute: a request we send at
 * 59.9s of our window can land inside the next one of theirs, and a retry or a
 * duplicate we did not count puts us over. Aiming at exactly 40/40 therefore
 * produces the occasional 429 by construction. Aiming at 36 does not, and the
 * four requests of margin cost a few seconds per minute at full tilt.
 */
export function effectiveLimit(publishedRpm: number): number {
  return Math.max(1, Math.floor(publishedRpm * HEADROOM));
}

/**
 * Longest `Retry-After` we are willing to sit out. Beyond this the wait is
 * worse than the failure: the user is staring at a frozen agent. A provider
 * asking for ten minutes is telling us to come back later, not to block.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * `Retry-After` in milliseconds, or null when absent/unusable.
 *
 * The header is either delta-seconds (`Retry-After: 20`) or an HTTP-date
 * (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`). Both are in the spec and
 * providers use both, so parse both. A date in the past yields 0, not a
 * negative wait.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const raw = header.trim();

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Backoff for a 429 that arrived without a usable `Retry-After`: 1s, 2s, 4s.
 * Jittered, because a fixed schedule makes concurrent sessions retry in
 * lockstep and re-trip the limit together.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = 1000 * 2 ** attempt;
  return Math.round(base * (0.75 + random() * 0.5));
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Details handed to the wait listener so a caller can tell the user why. */
export interface ThrottleWait {
  baseUrl: string;
  waitMs: number;
  /** Published cap for the endpoint (not the headroomed one). */
  limitRpm: number;
}

export class RequestRateLimiter {
  /** endpoint key → send timestamps inside the current window, oldest first. */
  readonly #windows = new Map<string, number[]>();
  /** Overrides every endpoint's cap when > 0. */
  readonly #overrideRpm: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    overrideRpm = 0,
    // Injected so the tests can drive time instead of waiting on it.
    deps: {
      now?: () => number;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.#overrideRpm = overrideRpm > 0 ? overrideRpm : 0;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? abortableSleep;
  }

  /** Published cap for `baseUrl`, or 0 when the endpoint is unlimited. */
  limitFor(baseUrl: string): number {
    if (this.#overrideRpm > 0) return this.#overrideRpm;
    return DEFAULT_RPM_BY_HOST[hostOf(baseUrl)] ?? 0;
  }

  /**
   * Block until sending one request to `baseUrl` keeps us inside the cap, then
   * count it. Returns immediately for an unlimited endpoint.
   *
   * `signal` aborts the wait — a user pressing stop must not sit through a
   * throttle delay. `onWait` fires once per wait so the caller can surface it;
   * a silent multi-second pause is indistinguishable from a hang.
   */
  async acquire(
    baseUrl: string,
    signal?: AbortSignal,
    onWait?: (info: ThrottleWait) => void,
  ): Promise<void> {
    const limitRpm = this.limitFor(baseUrl);
    if (limitRpm === 0) return;

    const key = hostOf(baseUrl);
    const cap = effectiveLimit(limitRpm);

    for (;;) {
      signal?.throwIfAborted();

      const now = this.#now();
      const window = this.#prune(key, now);

      // Check and count in one synchronous step: concurrent callers cannot
      // interleave between them, so two waiters waking in the same tick can
      // never both take the last slot.
      if (window.length < cap) {
        window.push(now);
        return;
      }

      // The oldest request leaves the window at `oldest + WINDOW_MS`; that is
      // the earliest moment a slot exists. +1ms so we wake up strictly after it
      // has aged out rather than exactly on the boundary.
      const waitMs = window[0]! + WINDOW_MS - now + 1;
      onWait?.({ baseUrl, waitMs, limitRpm });
      await this.#sleep(waitMs, signal);
      // Loop rather than assume the slot is ours: another caller may have taken
      // it while we slept.
    }
  }

  /**
   * Record that a request was sent without waiting for a slot.
   *
   * For requests that bypass `acquire` but still count against the provider's
   * cap — a retry after a 429 is the case that matters, since the provider
   * counted the rejected attempt too.
   */
  note(baseUrl: string): void {
    if (this.limitFor(baseUrl) === 0) return;
    const now = this.#now();
    this.#prune(hostOf(baseUrl), now).push(now);
  }

  /** Requests counted against `baseUrl` in the last window. Tests/telemetry. */
  countInWindow(baseUrl: string): number {
    return this.#prune(hostOf(baseUrl), this.#now()).length;
  }

  /** Drop timestamps that have aged out, returning the live window. */
  #prune(key: string, now: number): number[] {
    const window = this.#windows.get(key) ?? [];
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < window.length && window[drop]! <= cutoff) drop++;
    const live = drop > 0 ? window.slice(drop) : window;
    this.#windows.set(key, live);
    return live;
  }
}

/** `setTimeout` that rejects if `signal` aborts, so a stop is never sat out. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
