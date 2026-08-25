/**
 * _runner-vitest.ts — Vitest compatibility layer for this Bun-native repo.
 *
 * Two roles:
 * 1. Static re-export so the dual-runner test files resolve Vitest through
 *    its normal graph (a computed dynamic `import("vitest")` is mis-resolved
 *    as a relative path by the SSR transformer).
 * 2. Via vitest.config.ts alias, "bun:test" resolves HERE so the rest of
 *    the suite runs under Vitest too. The only non-trivial mapping is
 *    bun's `mock` → an adapter over vi.fn/vi.spyOn.
 *
 * The repo gate stays `bun test` (see AGENTS.md); this file exists so
 * `npx vitest run` works as a second, equivalent gate.
 */

import * as viModule from "vitest";

const vi = viModule.vi;

/** Adapter approximating bun:test's `mock` surface on top of vi. */
export const mock = Object.assign((fn?: (...args: unknown[]) => unknown) => vi.fn(fn), {
  fn: (impl?: (...args: unknown[]) => unknown) => vi.fn(impl),
  spyOn: (obj: object, method: string) => vi.spyOn(obj as Record<string, never>, method),
  restore: () => vi.restoreAllMocks(),
  clearAllMocks: () => vi.clearAllMocks(),
  resetAllMocks: () => vi.resetAllMocks(),
});

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from "vitest";

// Bun-only matchers used by parts of the legacy suite — registered so a
// future FULL-suite vitest run gets closer to green (see OPUS_RECEIPT).
viModule.expect.extend({
  toStartWith(received: unknown, prefix: unknown) {
    const pass =
      typeof received === "string" && typeof prefix === "string" && received.startsWith(prefix);
    return { pass, message: () => `expected ${String(received)} to start with ${String(prefix)}` };
  },
  toEndWith(received: unknown, suffix: unknown) {
    const pass =
      typeof received === "string" && typeof suffix === "string" && received.endsWith(suffix);
    return { pass, message: () => `expected ${String(received)} to end with ${String(suffix)}` };
  },
});
