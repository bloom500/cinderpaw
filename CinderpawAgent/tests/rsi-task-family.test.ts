/**
 * S1.1 of the AgentLoop evolution spec: the task family contract. Whole
 * templates per partition, one frozen budget per family, a hash that moves
 * when anything moves, and no way to hand a holdout task to the evolver.
 */
import { describe, expect, test } from "bun:test";
import {
  developmentTasks,
  familyHash,
  partitionOf,
  taskHash,
  validateBudget,
  validateFamily,
  validateTask,
  type AgentTask,
  type DevelopmentTask,
  type TaskFamily,
} from "../src/rsi/research/task-family.ts";

const family = (over: Partial<TaskFamily> = {}): TaskFamily => ({
  schemaVersion: 1,
  id: "build-repair",
  version: "1",
  templates: ["missing-dep", "bad-env", "wrong-engine", "broken-import"],
  partitions: {
    development: ["missing-dep"],
    promotion: ["bad-env"],
    final: ["wrong-engine"],
    transfer: ["broken-import"],
  },
  budget: { maxInputTokens: 15_000, maxOutputTokens: 4_000, maxToolCalls: 20, maxWallMs: 120_000, maxUsd: 0 },
  ...over,
});

const task = (templateId: string, seed: number, over: Partial<AgentTask> = {}): AgentTask => ({
  id: `${templateId}-${seed}`,
  familyId: "build-repair",
  templateId,
  seed,
  instruction: "Make `bun run build` pass.",
  workspaceImage: "a".repeat(64),
  budget: { ...family().budget },
  verifier: { kind: "command", checkId: `${templateId}-build` },
  ...over,
});

describe("family validation", () => {
  test("a well-formed family has no problems", () => {
    expect(validateFamily(family())).toEqual([]);
  });

  test("a template listed twice is refused", () => {
    const f = family({ templates: ["missing-dep", "missing-dep", "bad-env", "wrong-engine", "broken-import"] });
    expect(validateFamily(f).join("\n")).toContain('"missing-dep" is listed twice');
  });

  test("a template in two partitions is refused", () => {
    const f = family();
    const problems = validateFamily({ ...f, partitions: { ...f.partitions, promotion: ["bad-env", "missing-dep"] } });
    expect(problems.join("\n")).toContain('"missing-dep" is in both development and promotion');
  });

  test("a template in no partition, or an unknown one, is refused", () => {
    const f = family();
    expect(validateFamily({ ...f, partitions: { ...f.partitions, transfer: [] } }).join("\n")).toContain(
      '"broken-import" is in no partition',
    );
    expect(validateFamily({ ...f, partitions: { ...f.partitions, final: ["wrong-engine", "ghost"] } }).join("\n")).toContain(
      'unknown template "ghost"',
    );
  });

  test("an empty development partition is refused", () => {
    const f = family();
    const problems = validateFamily({
      ...f,
      partitions: { ...f.partitions, development: [], promotion: ["bad-env", "missing-dep"] },
    });
    expect(problems.join("\n")).toContain("development partition is empty");
  });
});

describe("budget validation", () => {
  const ok = family().budget;

  test("non-finite, negative, fractional or zero limits are refused", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
      expect(validateBudget({ ...ok, maxInputTokens: bad })).toHaveLength(1);
      expect(validateBudget({ ...ok, maxWallMs: bad })).toHaveLength(1);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(validateBudget({ ...ok, maxUsd: bad })).toHaveLength(1);
    }
  });

  test("a USD limit of 0 is valid: stub model only", () => {
    expect(validateBudget({ ...ok, maxUsd: 0 })).toEqual([]);
  });

  test("a family with a bad budget is refused", () => {
    expect(validateFamily(family({ budget: { ...ok, maxToolCalls: Number.NaN } }))).toHaveLength(1);
  });
});

describe("partitions", () => {
  test("every seed of a template lands in the same partition", () => {
    const f = family();
    for (const t of f.templates) {
      const first = partitionOf(f, t);
      for (let seed = 0; seed < 200; seed++) expect(partitionOf(f, task(t, seed).templateId)).toBe(first);
    }
  });

  test("an unknown template throws instead of defaulting", () => {
    expect(() => partitionOf(family(), "ghost")).toThrow(/not in any partition/);
  });

  test("developmentTasks keeps only development, over many seeds", () => {
    const f = family();
    const all = f.templates.flatMap((t) => Array.from({ length: 50 }, (_, s) => task(t, s)));
    const dev = developmentTasks(all, f);
    expect(dev).toHaveLength(50);
    expect(dev.every((t) => t.templateId === "missing-dep")).toBe(true);
  });

  test("a holdout task is not a DevelopmentTask at the type level", () => {
    const takesDev = (t: DevelopmentTask): string => t.id;
    // @ts-expect-error a plain AgentTask (e.g. a final task) cannot be passed where a DevelopmentTask is required
    expect(takesDev(task("wrong-engine", 1))).toBe("wrong-engine-1");
  });
});

describe("task validation", () => {
  test("a task of the family is valid", () => {
    expect(validateTask(task("bad-env", 3), family())).toEqual([]);
  });

  test("a task with its own budget is refused", () => {
    const t = task("bad-env", 3, { budget: { ...family().budget, maxInputTokens: 99_000 } });
    expect(validateTask(t, family()).join("\n")).toContain("budget differs from the family budget");
  });

  test("wrong family, unknown template, bad seed, empty instruction, unknown verifier", () => {
    const f = family();
    expect(validateTask(task("bad-env", 1, { familyId: "other" }), f)).toHaveLength(1);
    expect(validateTask(task("ghost", 1), f)).toHaveLength(1);
    expect(validateTask(task("bad-env", 1.5), f)).toHaveLength(1);
    expect(validateTask(task("bad-env", 1, { instruction: "  " }), f)).toHaveLength(1);
    expect(validateTask(task("bad-env", 1, { verifier: { kind: "vibes" as never, checkId: "x" } }), f)).toHaveLength(1);
  });
});

describe("hashing", () => {
  test("the family hash moves when any field moves", () => {
    const base = family();
    const h = familyHash(base);
    const variants: TaskFamily[] = [
      { ...base, id: "other" },
      { ...base, version: "2" },
      { ...base, templates: [...base.templates, "extra"] },
      { ...base, partitions: { ...base.partitions, promotion: ["broken-import"], transfer: ["bad-env"] } },
      { ...base, budget: { ...base.budget, maxUsd: 0.5 } },
    ];
    for (const v of variants) expect(familyHash(v)).not.toBe(h);
    expect(familyHash(family())).toBe(h);
  });

  test("the task hash moves when any field moves, and ignores key order", () => {
    const base = task("bad-env", 1);
    const h = taskHash(base);
    for (const over of [
      { seed: 2 },
      { instruction: "Other." },
      { workspaceImage: "b".repeat(64) },
      { verifier: { kind: "file_exists" as const, checkId: "bad-env-build" } },
    ]) {
      expect(taskHash({ ...base, ...over })).not.toBe(h);
    }
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as AgentTask;
    expect(taskHash(reordered)).toBe(h);
  });
});
