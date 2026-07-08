/**
 * L4 Architecture — B3: seam adapter + builtin fast-path + watchdog
 * auto-quarantine (spec §1, §6, §8).
 *
 * Contract under test:
 *   AC4  — killing/failing the module host mid-request returns the
 *          builtin result for that request (no user-facing error) and
 *          increments the watchdog; 3 strikes → auto-quarantine +
 *          registry restored to builtin.
 *   AC10 — with no module promoted, the builtin is called directly:
 *          no host is ever spawned (no process boundary).
 *   §6   — re-resolution on next request after promotion/demotion,
 *          no restart required.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleRegistry } from "../src/rsi/module-registry.ts";
import { SeamAdapter } from "../src/rsi/seam-adapter.ts";
import { spawnModuleHost, type SpawnResult } from "../src/rsi/module-host-client.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "modules");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-l4-b3-"));
  tmpDirs.push(d);
  return d;
}

function harness(opts: {
  active?: string;
  moduleDir?: string;
  limits?: { timeoutMs: number; maxRssMb: number };
  spawn?: typeof spawnModuleHost;
} = {}) {
  const dir = freshDir();
  const gov = freshDir();
  const registry = new ModuleRegistry({ dir, governanceDir: gov });
  if (opts.active) {
    registry.repoint("retrieval_strategy", opts.active, "test", "setup");
  }
  const builtinCalls: Array<{ method: string; params: unknown }> = [];
  const adapter = new SeamAdapter({
    seam: "retrieval_strategy",
    registry,
    governanceDir: gov,
    builtin: async (method, params) => {
      builtinCalls.push({ method, params });
      return { items: [{ text: "builtin", score: 1, sourceId: "builtin" }] };
    },
    moduleDirFor: () => opts.moduleDir ?? join(FIXTURES, "good-retrieval"),
    limits: opts.limits ?? { timeoutMs: 5_000, maxRssMb: 512 },
    spawn: opts.spawn,
  });
  return { adapter, registry, gov, builtinCalls };
}

describe("SeamAdapter (spec §1/§6/§8)", () => {
  test("AC10: builtin active → direct call, host NEVER spawned", async () => {
    let spawns = 0;
    const spy: typeof spawnModuleHost = async (o) => {
      spawns++;
      return spawnModuleHost(o);
    };
    const { adapter, builtinCalls } = harness({ spawn: spy });
    const out = await adapter.invoke("retrieve", { query: "q", k: 1, sessionId: "s" });
    expect((out as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
    expect(builtinCalls.length).toBe(1);
    expect(spawns).toBe(0);
  });

  test("module active → module host serves the request", async () => {
    const { adapter, builtinCalls } = harness({ active: "mod-retrieval-fixture-01" });
    const out = await adapter.invoke("retrieve", { query: "ping", k: 1, sessionId: "s" });
    expect((out as { items: Array<{ text: string }> }).items[0]!.text).toBe("echo:ping");
    expect(builtinCalls.length).toBe(0);
    adapter.stopHost();
  }, 30_000);

  test("§6 re-resolution: promotion is picked up on the NEXT request, no restart", async () => {
    const { adapter, registry, builtinCalls } = harness();
    const first = await adapter.invoke("retrieve", { query: "a", k: 1, sessionId: "s" });
    expect((first as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
    registry.repoint("retrieval_strategy", "mod-retrieval-fixture-01", "darius", "approved");
    const second = await adapter.invoke("retrieve", { query: "b", k: 1, sessionId: "s" });
    expect((second as { items: Array<{ text: string }> }).items[0]!.text).toBe("echo:b");
    // Demotion re-resolves the same way.
    registry.repoint("retrieval_strategy", "builtin", "darius", "demoted");
    const third = await adapter.invoke("retrieve", { query: "c", k: 1, sessionId: "s" });
    expect((third as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
    expect(builtinCalls.length).toBe(2);
    adapter.stopHost();
  }, 30_000);

  test("AC4: module timeouts → builtin result per request, 3 strikes → quarantine + registry restored", async () => {
    const { adapter, registry, gov, builtinCalls } = harness({
      active: "mod-retrieval-sleepy-01",
      moduleDir: join(FIXTURES, "sleepy"),
      limits: { timeoutMs: 300, maxRssMb: 512 },
    });
    for (let i = 1; i <= 3; i++) {
      const out = await adapter.invoke("retrieve", { query: "q", k: 1, sessionId: "s" });
      // The user sees builtin behavior, never an error (spec §4).
      expect((out as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
    }
    expect(builtinCalls.length).toBe(3);
    // Quarantined: registry back at builtin, audit row + history row written.
    expect(registry.activeFor("retrieval_strategy")).toBe("builtin");
    const audit = readFileSync(join(gov, "governance_audit.jsonl"), "utf8");
    expect(audit).toContain("module_quarantined");
    expect(registry.historyRows().at(-1)?.actor).toBe("watchdog");
    // Post-quarantine requests are pure builtin — no spawn attempts.
    const after = await adapter.invoke("retrieve", { query: "z", k: 1, sessionId: "s" });
    expect((after as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
  }, 30_000);

  test("spawn failure (unwallable module) → builtin + strikes → quarantine", async () => {
    const dir = freshDir(); // no manifest at all — spawn refuses
    const { adapter, registry, gov } = harness({ active: "mod-broken", moduleDir: dir });
    for (let i = 0; i < 3; i++) {
      const out = await adapter.invoke("retrieve", { query: "q", k: 1, sessionId: "s" });
      expect((out as { items: Array<{ sourceId: string }> }).items[0]!.sourceId).toBe("builtin");
    }
    expect(registry.activeFor("retrieval_strategy")).toBe("builtin");
    expect(readFileSync(join(gov, "governance_audit.jsonl"), "utf8")).toContain("module_quarantined");
  }, 30_000);

  test("onQuarantine fires once with the module id (desktop toast surface)", async () => {
    const dir = freshDir();
    const gov = freshDir();
    const registry = new ModuleRegistry({ dir, governanceDir: gov });
    registry.repoint("planner", "mod-bad", "test", "setup");
    const seen: string[] = [];
    const adapter = new SeamAdapter({
      seam: "planner",
      registry,
      governanceDir: gov,
      builtin: async () => ({ steps: [] }),
      moduleDirFor: () => freshDir(), // empty dir — spawn always refuses
      onQuarantine: (id) => seen.push(id),
    });
    for (let i = 0; i < 3; i++) await adapter.invoke("plan", { goal: "g", maxDepth: 1, toolNames: [] });
    expect(seen).toEqual(["mod-bad"]);
  }, 30_000);
});
