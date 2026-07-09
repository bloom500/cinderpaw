/**
 * L4 Architecture — B2: module host (spec §4).
 *
 * Contract under test (AC3):
 *   - a module importing node:fs, using fetch, or referencing process.env
 *     is rejected at the sandbox stage with a NAMED reason;
 *   - a module that sleeps past timeoutMs is killed (request-level) and
 *     reported; N consecutive timeouts kill the host process;
 *   - seeded RNG shim: same seed → identical Math.random stream;
 *   - JSON-lines protocol with version byte in hello (§12.2);
 *   - scrubbed env, request/response only.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { wallCheck } from "../src/rsi/l4-modules/module-wall.ts";
import { spawnModuleHost, HOST_PROTOCOL } from "../src/rsi/l4-modules/module-host-client.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "modules");
const LIMITS = { timeoutMs: 5_000, maxRssMb: 512 };

// ── Lexical wall (pure, no spawn) ──────────────────────────────────────────

describe("wallCheck (spec §4)", () => {
  test("clean single-file module passes", () => {
    const src = `export default { async retrieve(q: {query:string}) { return { items: [] }; } };`;
    expect(wallCheck(src).ok).toBe(true);
  });

  test("node:assert is the one allowed import", () => {
    expect(wallCheck(`import assert from "node:assert";\nexport default {};`).ok).toBe(true);
  });

  test("node:fs import → named reject", () => {
    const res = wallCheck(`import { readFileSync } from "node:fs";\nexport default {};`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("node:fs");
  });

  test("bun: import → reject", () => {
    expect(wallCheck(`import { db } from "bun:sqlite";`).ok).toBe(false);
  });

  test("npm package import → reject", () => {
    expect(wallCheck(`import _ from "lodash";`).ok).toBe(false);
  });

  test("relative import → reject (modules are single-file)", () => {
    expect(wallCheck(`import { x } from "./helper.ts";`).ok).toBe(false);
  });

  test("fetch / process / require / eval / Bun / Function / dynamic import tokens → named reject", () => {
    const cases: Array<[string, string]> = [
      [`const r = await fetch("http://x");`, "fetch"],
      [`const home = process.env.HOME;`, "process"],
      [`const fs = require("fs");`, "require"],
      [`eval("1+1");`, "eval"],
      [`Bun.file("/etc/passwd");`, "Bun"],
      [`new Function("return 1")();`, "Function constructor"],
      [`const m = await import("node:fs");`, "dynamic import()"],
    ];
    for (const [src, name] of cases) {
      const res = wallCheck(`export default {};\n${src}`);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain(name);
    }
  });
});

// ── Host end-to-end (real subprocess) ──────────────────────────────────────

describe("module host e2e (spec §4)", () => {
  test("hello (protocol byte) + request/response round-trip", async () => {
    const res = await spawnModuleHost({
      moduleDir: join(FIXTURES, "good-retrieval"),
      limits: LIMITS,
      seed: 42,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { host } = res;
    expect(host.moduleId).toBe("mod-retrieval-fixture-01");
    expect(host.methods).toContain("retrieve");
    const reply = await host.request("retrieve", { query: "hello", k: 3, sessionId: "s1" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const items = (reply.result as { items: Array<{ text: string }> }).items;
      expect(items[0]!.text).toBe("echo:hello");
    }
    host.stop();
    expect(host.alive()).toBe(false);
  }, 30_000);

  test("seeded RNG: same seed → identical score, different seed → different", async () => {
    const score = async (seed: number): Promise<number> => {
      const res = await spawnModuleHost({
        moduleDir: join(FIXTURES, "good-retrieval"),
        limits: LIMITS,
        seed,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.reason);
      const reply = await res.host.request("retrieve", { query: "q", k: 1, sessionId: "s" });
      res.host.stop();
      if (!reply.ok) throw new Error(reply.error);
      return (reply.result as { items: Array<{ score: number }> }).items[0]!.score;
    };
    const [a, b, c] = [await score(7), await score(7), await score(8)];
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  }, 60_000);

  test("unknown method → ok:false with named error, host stays alive", async () => {
    const res = await spawnModuleHost({
      moduleDir: join(FIXTURES, "good-retrieval"),
      limits: LIMITS,
      seed: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const reply = await res.host.request("plan", {});
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain("unknown method");
    expect(res.host.alive()).toBe(true);
    res.host.stop();
  }, 30_000);

  test("sleep past timeoutMs → timed-out reply; 3 consecutive → host killed (AC3)", async () => {
    const res = await spawnModuleHost({
      moduleDir: join(FIXTURES, "sleepy"),
      limits: { timeoutMs: 300, maxRssMb: 512 },
      seed: 1,
      maxConsecutiveTimeouts: 3,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { host } = res;
    for (let i = 1; i <= 3; i++) {
      const reply = await host.request("retrieve", { query: "q", k: 1, sessionId: "s" });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.timedOut).toBe(true);
    }
    expect(host.alive()).toBe(false);
    expect(host.stats().consecutiveTimeouts).toBe(3);
    // Requests after death fail fast, no throw.
    const after = await host.request("retrieve", {});
    expect(after.ok).toBe(false);
  }, 30_000);

  test("stopping the host mid-request settles the pending request as failure", async () => {
    const res = await spawnModuleHost({
      moduleDir: join(FIXTURES, "sleepy"),
      limits: { timeoutMs: 20_000, maxRssMb: 512 },
      seed: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pending = res.host.request("retrieve", { query: "q", k: 1, sessionId: "s" });
    res.host.stop();
    const reply = await pending;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain("host stopped");
  }, 30_000);

  test("a walled module never spawns (named reason, sandbox stage)", async () => {
    // Write an evil module to a temp fixture dir on the fly.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "feral-evil-mod-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ id: "mod-evil", seam: "retrieval_strategy", entry: "module.ts" }),
      "utf8",
    );
    writeFileSync(join(dir, "module.ts"), `import { readFileSync } from "node:fs";\nexport default {};`, "utf8");
    const res = await spawnModuleHost({ moduleDir: dir, limits: LIMITS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("lexical wall");
  }, 30_000);

  test("protocol constant is 1 (bump = deliberate §12.2 act)", () => {
    expect(HOST_PROTOCOL).toBe(1);
  });
});
