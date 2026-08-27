/**
 * Tests for `tools/builtin/self.ts` — runtime introspection tools.
 *
 * Focus on the pure-data shape helpers (round-trip JSON → typed shape) and
 * the subsystem catalog (no I/O). The full Tool wiring (registry, router)
 * is exercised by integration tests; here we lock the data contracts the
 * agent reasons over so a schema change surfaces as a test failure rather
 * than a silent hallucination.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testInternals } from "../src/tools/builtin/self.ts";

const {
  readJsonSync,
  tailJsonl,
  shapeChampion,
  shapePopulation,
  shapeDreams,
  shapeMemory,
  shapeLora,
  shapeConnectors,
  healthChampion,
  healthPopulation,
  healthDreams,
  healthLora,
  healthConnectors,
  healthNotebook,
  SUBSYSTEMS,
} = __testInternals;

describe("readJsonSync", () => {
  test("returns parsed JSON for a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "ok.json");
      writeFileSync(f, JSON.stringify({ a: 1, b: [2, 3] }));
      expect(readJsonSync(f)).toEqual({ a: 1, b: [2, 3] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null on a missing file (does not throw)", () => {
    expect(readJsonSync("/this/does/not/exist/nope.json")).toBeNull();
  });

  test("returns null on a corrupt file (does not throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "broken.json");
      writeFileSync(f, "{not-json");
      expect(readJsonSync(f)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tailJsonl", () => {
  test("returns the last n parsed objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "log.jsonl");
      writeFileSync(f, '{ "n": 1 }\n{ "n": 2 }\n{ "n": 3 }\n');
      const last = tailJsonl(f, 3);
      expect(last).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns [] on a missing file", () => {
    expect(tailJsonl("/this/does/not/exist.jsonl", 5)).toEqual([]);
  });

  test("ignores malformed lines (does not throw on one bad row)", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "log.jsonl");
      writeFileSync(f, '{ "n": 1 }\n{not-json\n{ "n": 2 }\n');
      expect(tailJsonl(f, 10)).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subsystem catalog", () => {
  test("every subsystem has all required fields populated", () => {
    for (const [name, doc] of Object.entries(SUBSYSTEMS)) {
      expect(doc.purpose.length).toBeGreaterThan(20);
      expect(doc.inputs.length).toBeGreaterThanOrEqual(2);
      expect(doc.outputs.length).toBeGreaterThanOrEqual(1);
      expect(doc.safety.length).toBeGreaterThanOrEqual(2);
      expect(doc.promotion.length).toBeGreaterThan(20);
      expect(doc.rollback.length).toBeGreaterThan(20);
      expect(doc.inspect.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("required subsystems are present", () => {
    for (const required of [
      "brsi",
      "fms",
      "lora",
      "dreaming",
      "genomes",
      "connectors",
      "memory",
      "brain_stack",
      "rsi",
      // The notebook is opt-in, which is exactly why it belongs here: a
      // subsystem the agent cannot describe is one it will deny having.
      "notebook",
    ]) {
      expect(SUBSYSTEMS[required]).toBeDefined();
    }
  });

  test("healthNotebook calls a deliberately-off notebook fine, not broken", () => {
    // `available: false` here would flip self_health's banner to "some
    // subsystems not yet persisted" on every install that turned the notebook
    // off — a diagnostic that always complains stops being read.
    //
    // Set explicitly rather than deleted: the notebook is ON by default as of
    // 2026-08-26 (it is the largest lever on token cost), so "unset" no longer
    // means "off" and deleting the variable would test the wrong branch.
    const before = process.env.CINDERPAW_ENABLE_NOTEBOOK;
    process.env.CINDERPAW_ENABLE_NOTEBOOK = "false";
    try {
      const h = healthNotebook();
      expect(h.available).toBe(true);
      expect(h.detail).toContain("disabled");
    } finally {
      if (before === undefined) delete process.env.CINDERPAW_ENABLE_NOTEBOOK;
      else process.env.CINDERPAW_ENABLE_NOTEBOOK = before;
    }
  });

  test("unset means ENABLED — the default that ships", () => {
    const before = process.env.CINDERPAW_ENABLE_NOTEBOOK;
    delete process.env.CINDERPAW_ENABLE_NOTEBOOK;
    try {
      expect(healthNotebook().detail).toContain("enabled");
    } finally {
      if (before !== undefined) process.env.CINDERPAW_ENABLE_NOTEBOOK = before;
    }
  });

  test("healthNotebook reports the snapshot count once enabled", () => {
    const before = process.env.CINDERPAW_ENABLE_NOTEBOOK;
    process.env.CINDERPAW_ENABLE_NOTEBOOK = "true";
    try {
      const h = healthNotebook();
      expect(h.available).toBe(true);
      expect(h.detail).toContain("enabled");
      expect(h.detail).toMatch(/\d+ session snapshot/);
    } finally {
      if (before === undefined) delete process.env.CINDERPAW_ENABLE_NOTEBOOK;
      else process.env.CINDERPAW_ENABLE_NOTEBOOK = before;
    }
  });

  test("introspect pointers reference self.* tools that exist", () => {
    const knownSelfTools = new Set([
      "self_describe",
      "self_status",
      "self_runtime",
      "self_tools",
      "self_providers",
      "self_memory",
      "self_connectors",
      "self_genome",
      "self_dreams",
      "self_lora",
      "self_health",
      "self_subsystem",
      "recall",
    ]);
    for (const doc of Object.values(SUBSYSTEMS)) {
      for (const tool of doc.inspect) {
        expect(knownSelfTools.has(tool)).toBe(true);
      }
    }
  });
});

describe("shape helpers (use temp dirs so they're environment-independent)", () => {
  test("shapeChampion returns null on a missing file", () => {
    expect(shapeChampion({ champion: "/this/does/not/exist.json" })).toBeNull();
  });

  test("shapeChampion populates from a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "champion.json");
      writeFileSync(
        f,
        JSON.stringify({
          genomeId: "g-42",
          score: 0.91,
          config: { temperature: 0.7 },
          updatedAt: 1700000000000,
        }),
      );
      expect(shapeChampion({ champion: f })).toEqual({
        genomeId: "g-42",
        score: 0.91,
        config: { temperature: 0.7 },
        updatedAt: 1700000000000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shapePopulation returns null on a missing file", () => {
    expect(shapePopulation({ population: "/nope.json" })).toBeNull();
  });

  test("shapePopulation aggregates alive/dead + best-record", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "population.json");
      writeFileSync(
        f,
        JSON.stringify({
          version: 1,
          concurrency: 4,
          nicheThreshold: 0.85,
          genomes: [
            { id: "a", alive: true, fitnessScore: 0.7 },
            { id: "b", alive: true, fitnessScore: 0.9 },
            { id: "c", alive: false, fitnessScore: 0.4 },
          ],
          bestRecord: { genomeId: "b", score: 0.9 },
          hallOfFameIds: ["b"],
        }),
      );
      expect(shapePopulation({ population: f })).toEqual({
        alive: 2,
        dead: 1,
        best_score: 0.9,
        best_genome: "b",
        hall_of_fame: 1,
        concurrency: 4,
        niche_threshold: 0.85,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shapeDreams returns null last_episode on a missing file", () => {
    expect(shapeDreams(5, { dream: "/nope.jsonl" })).toEqual({
      last_episode: null,
      total_episodes: 0,
    });
  });

  test("shapeDreams reads the last episode", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "dream.jsonl");
      const ep1 = { startedAt: 1000, endedAt: 2000, trigger: "idle", iterations: 5, tokens: 200, ratchets: 1, stopReason: "ok", errors: [], emptyResponses: 0 };
      const ep2 = { startedAt: 3000, endedAt: 4500, trigger: "schedule", iterations: 7, tokens: 400, ratchets: 0, stopReason: "budget", errors: ["boom"], emptyResponses: 2 };
      writeFileSync(f, JSON.stringify(ep1) + "\n" + JSON.stringify(ep2) + "\n");
      const d = shapeDreams(5, { dream: f });
      expect(d.total_episodes).toBe(2);
      expect(d.last_episode?.trigger).toBe("schedule");
      expect(d.last_episode?.ratchets).toBe(0);
      expect(d.last_episode?.emptyResponses).toBe(2);
      expect(d.last_episode?.errors).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shapeMemory returns defaults when both files are missing", () => {
    const m = shapeMemory({ leafStore: "/nope-leaves", memoryGraph: "/nope-graph" });
    expect(m.leaf_store_exists).toBe(false);
    expect(m.leaf_store_bytes).toBe(0);
    expect(m.graph_exists).toBe(false);
    expect(m.graph_nodes_hint).toBeNull();
    expect(m.estimators.leaf_count_estimate).toBe(0);
  });

  test("shapeLora computes per-domain buckets", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "lora-registry.json");
      writeFileSync(
        f,
        JSON.stringify({
          version: 1,
          adapters: [
            { id: "lora-coding-1", domain: "coding", status: "candidate", adapterPath: "/x" },
            { id: "lora-coding-2", domain: "coding", status: "champion", adapterPath: "/y" },
            { id: "lora-writing-1", domain: "writing", status: "retired", adapterPath: "/z" },
            { id: "lora-research-1", domain: "research", status: "evaluating", adapterPath: "/w" },
          ],
        }),
      );
      const out = shapeLora({ lora: f });
      expect(out.total).toBe(4);
      expect(out.active_path).toBe("/y");
      expect(out.by_domain.coding.champion).toBe("lora-coding-2");
      expect(out.by_domain.coding.candidates).toBe(1);
      expect(out.by_domain.coding.retired).toBe(0);
      expect(out.by_domain.writing.champion).toBeNull();
      expect(out.by_domain.writing.retired).toBe(1);
      expect(out.by_domain.research.candidates).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shapeConnectors returns empty when file is missing", () => {
    expect(shapeConnectors({ connectors: "/nope.json" })).toEqual([]);
  });

  test("shapeConnectors never echoes secret values", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-self-"));
    try {
      const f = join(dir, "connectors.json");
      writeFileSync(
        f,
        JSON.stringify({
          connectors: [
            {
              id: "discord",
              enabled: true,
              secrets: { DISCORD_TOKEN: "super-secret-do-not-leak" },
              allowlist: ["abc", "def"],
              channels: ["#x", "#y", "#z"],
              mode: "owner",
            },
          ],
        }),
      );
      const out = shapeConnectors({ connectors: f });
      expect(out).toEqual([
        {
          id: "discord",
          enabled: true,
          active: true,
          mode: "owner",
          allowlist_count: 2,
          channels_count: 3,
          secret_fields: ["DISCORD_TOKEN"],
        },
      ]);
      const serialised = JSON.stringify(out);
      expect(serialised).not.toContain("super-secret");
      expect(serialised).not.toContain("do-not-leak");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("health helpers (use temp dirs)", () => {
  test("healthChampion reports not-available when no file", () => {
    const h = healthChampion({ champion: "/nope.json" });
    expect(h.available).toBe(false);
    expect(h.detail ?? "").toMatch(/no champion/i);
  });

  test("healthPopulation reports not-available when no file", () => {
    const h = healthPopulation({ population: "/nope.json" });
    expect(h.available).toBe(false);
    expect(h.detail ?? "").toMatch(/no population/i);
  });

  test("healthLora reports not-available when no file", () => {
    const h = healthLora({ lora: "/nope.json" });
    expect(h.available).toBe(false);
    expect(h.detail ?? "").toMatch(/no lora/i);
  });

  test("healthDreams reports not-available when no log", () => {
    const h = healthDreams({ dream: "/nope.jsonl" });
    expect(h.available).toBe(false);
    expect(h.detail ?? "").toMatch(/no dream/i);
  });

  test("healthConnectors reports available with empty list", () => {
    const h = healthConnectors({ connectors: "/nope.json" });
    expect(h.available).toBe(true);
    expect(h.detail ?? "").toMatch(/no connectors/i);
  });
});
