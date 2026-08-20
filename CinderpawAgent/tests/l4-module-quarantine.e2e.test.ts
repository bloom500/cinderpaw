/**
 * L4 — Module quarantine watchdog (B5 e2e smoke, assembled version).
 *
 * Env-gated: FERAL_E2E=1 bun test tests/l4-module-quarantine.e2e.test.ts
 *
 * Drives the seam-adapter watchdog end-to-end:
 *   1. Registry is repointed to a deliberately-failing module id.
 *   2. Each invoke counts a strike; the user sees the builtin result
 *      every time (no module error leaks to the surface).
 *   3. After `maxStrikes` failures inside `strikeWindowMs`, the seam
 *      adapter auto-quarantines: registry re-pointed to builtin, the
 *      `module_quarantined` row lands in the chained governance audit,
 *      the last history row is `actor: "watchdog"`, and post-quarantine
 *      requests are pure builtin (no further spawn attempts).
 *
 * The granular unit tests live in `rsi-seam-adapter.test.ts`. This file
 * is the assembled end-to-end view a reviewer can read in 60 seconds,
 * with a deliberately-injected failing spawn so the guard fires
 * deterministically without a real subprocess.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModuleRegistry } from "../src/rsi/l4-modules/module-registry.ts";
import { SeamAdapter } from "../src/rsi/l4-modules/seam-adapter.ts";
import type { SpawnResult } from "../src/rsi/l4-modules/module-host-client.ts";

const ENABLED = process.env.FERAL_E2E === "1";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe("L4 — module quarantine watchdog (FERAL_E2E)", () => {
  it.skipIf(!ENABLED)(
    "host-spawn failure × maxStrikes → builtin + audit row + history watchdog row",
    async () => {
      const dir = freshDir("feral-e2e-l4-reg-");
      const gov = freshDir("feral-e2e-l4-gov-");
      const moduleDir = freshDir("feral-e2e-l4-mod-");
      const registry = new ModuleRegistry({ dir, governanceDir: gov });
      registry.repoint("retrieval_strategy", "mod-deliberately-broken", "test", "promote");

      // Inject a spawn that always refuses — no real subprocess.
      let spawnAttempts = 0;
      const fakeSpawn = async (): Promise<SpawnResult> => {
        spawnAttempts++;
        return { ok: false, reason: "injected: manifest missing" };
      };

      const builtinCalls: string[] = [];
      const adapter = new SeamAdapter({
        seam: "retrieval_strategy",
        registry,
        governanceDir: gov,
        moduleDirFor: () => moduleDir,
        limits: { timeoutMs: 1_000, maxRssMb: 256 },
        spawn: fakeSpawn as unknown as Parameters<typeof SeamAdapter>[0]["spawn"],
        builtin: async (method) => {
          builtinCalls.push(method);
          return { items: [{ text: "builtin-floor", score: 1, sourceId: "builtin" }] };
        },
      });

      // 3 invokes, each spawn refuses → 3 strikes → quarantine.
      for (let i = 0; i < 3; i++) {
        const out = (await adapter.invoke("retrieve", {
          query: "q",
          k: 1,
          sessionId: "s",
        })) as { items: Array<{ sourceId: string }> };
        // User never sees an error — the floor is always the builtin.
        expect(out.items[0]!.sourceId).toBe("builtin");
      }
      expect(builtinCalls.length).toBe(3);
      expect(spawnAttempts).toBe(3);

      // Guard 1: registry auto-repointed to builtin.
      expect(registry.activeFor("retrieval_strategy")).toBe("builtin");

      // Guard 2: governance audit row says "module_quarantined".
      const audit = readFileSync(join(gov, "governance_audit.jsonl"), "utf8");
      expect(audit).toContain("module_quarantined");

      // Guard 3: the most recent registry history row was written by
      // the watchdog (not a human).
      const lastRow = registry.historyRows().at(-1);
      expect(lastRow?.actor).toBe("watchdog");
      expect(lastRow?.seam).toBe("retrieval_strategy");

      // Guard 4: post-quarantine invokes are pure builtin — the spawn
      // stub never gets called again.
      const callsBefore = spawnAttempts;
      const after = (await adapter.invoke("retrieve", {
        query: "z",
        k: 1,
        sessionId: "s",
      })) as { items: Array<{ sourceId: string }> };
      expect(after.items[0]!.sourceId).toBe("builtin");
      expect(spawnAttempts).toBe(callsBefore);
      adapter.stopHost();
    },
  );

  it.skipIf(!ENABLED)(
    "negative control: builtin active → no spawn attempts even with a faulty spawn",
    async () => {
      const dir = freshDir("feral-e2e-l4-control-reg-");
      const gov = freshDir("feral-e2e-l4-control-gov-");
      const moduleDir = freshDir("feral-e2e-l4-control-mod-");
      const registry = new ModuleRegistry({ dir, governanceDir: gov });

      let spawnAttempts = 0;
      const fakeSpawn = async (): Promise<SpawnResult> => {
        spawnAttempts++;
        return { ok: false, reason: "would have failed" };
      };

      const adapter = new SeamAdapter({
        seam: "retrieval_strategy",
        registry,
        governanceDir: gov,
        moduleDirFor: () => moduleDir,
        limits: { timeoutMs: 1_000, maxRssMb: 256 },
        spawn: fakeSpawn as unknown as Parameters<typeof SeamAdapter>[0]["spawn"],
        builtin: async () => ({ items: [{ text: "floor", score: 1, sourceId: "builtin" }] }),
      });

      // No repoint → active === "builtin". No spawn attempts, no strikes.
      for (let i = 0; i < 5; i++) {
        const out = (await adapter.invoke("retrieve", {
          query: `q${i}`,
          k: 1,
          sessionId: "s",
        })) as { items: Array<{ sourceId: string }> };
        expect(out.items[0]!.sourceId).toBe("builtin");
      }
      expect(spawnAttempts).toBe(0);
      // No quarantine — the audit log doesn't exist (nothing was appended).
      adapter.stopHost();
    },
  );
});
