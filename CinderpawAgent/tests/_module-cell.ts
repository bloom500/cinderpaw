/**
 * A module cell that runs the host as a plain bun process ON THE HOST, so the
 * protocol tests (hello, timeouts, RSS, seeded RNG) run without Docker.
 *
 * Tests only. Production has no such cell on purpose: `spawnModuleHost`
 * refuses when there is no isolation cell rather than running generated code
 * on the host. The real cell is exercised in tests/rsi-module-cell.test.ts.
 */

import type { ModuleCell } from "../src/rsi/l3-code/isolation.ts";

export const hostProcessCell: ModuleCell = {
  name: "host-process (tests only)",
  available: async () => ({ ok: true, note: "tests" }),
  prepare: async () => ({ ok: true, note: "tests" }),
  command: (spec) => ({
    argv: [Bun.which("bun") ?? process.execPath, spec.hostScript, spec.moduleDir],
    // A compiled test runner is a bun binary; BUN_BE_BUN makes it act as one.
    env: { PATH: process.env["PATH"] ?? "", ...spec.env, BUN_BE_BUN: "1" },
  }),
  destroy: async () => {},
};
