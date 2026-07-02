/**
 * Faza 4 Slice 1 — LoraRegistry: promote/rollback/genealogy + the
 * corrupt-store discipline. Mirrors the rsi-pending-patches test shape.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoraRegistry, type LoraAdapterRecord } from "../src/rsi/lora-registry.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lora-reg-")), "lora-registry.json");
}

function rec(
  id: string,
  parentId?: string,
): Omit<LoraAdapterRecord, "status" | "createdAt"> {
  return {
    id,
    domain: "coding",
    adapterPath: `C:/adapters/${id}.gguf`,
    baseModel: "Qwen3.5-4B-Q8_0.gguf",
    provenance: {
      parentId,
      datasetId: `ds-${id}`,
      datasetHash: "abc123",
      hyperparameters: { rank: 16 },
      metrics: { loss: 0.5 },
    },
  };
}

describe("LoraRegistry", () => {
  test("add registers a candidate, idempotent per id", () => {
    const reg = new LoraRegistry(tmpFile());
    const a = reg.add(rec("a1"));
    expect(a.status).toBe("candidate");
    const again = reg.add(rec("a1"));
    expect(again.createdAt).toBe(a.createdAt);
    expect(reg.list()).toHaveLength(1);
  });

  test("promote crowns champion and retires the previous one", () => {
    const file = tmpFile();
    const reg = new LoraRegistry(file);
    reg.add(rec("a1"));
    reg.promote("a1");
    reg.add(rec("a2", "a1"));
    reg.markEvaluating("a2");
    reg.promote("a2");

    expect(reg.champion("coding")?.id).toBe("a2");
    expect(reg.get("a1")?.status).toBe("retired");
    // Persisted: a fresh load sees the same state.
    const reloaded = new LoraRegistry(file);
    expect(reloaded.champion("coding")?.id).toBe("a2");
  });

  test("rollback demotes champion and re-promotes the retired parent", () => {
    const reg = new LoraRegistry(tmpFile());
    reg.add(rec("a1"));
    reg.promote("a1");
    reg.add(rec("a2", "a1"));
    reg.promote("a2");

    const restored = reg.rollback("coding");
    expect(restored?.id).toBe("a1");
    expect(reg.champion("coding")?.id).toBe("a1");
    expect(reg.get("a2")?.status).toBe("rolled_back");
  });

  test("rollback with no ancestor leaves the domain on the foundation model", () => {
    const reg = new LoraRegistry(tmpFile());
    reg.add(rec("root"));
    reg.promote("root");
    const restored = reg.rollback("coding");
    expect(restored).toBeUndefined();
    expect(reg.champion("coding")).toBeUndefined();
    expect(reg.get("root")?.status).toBe("rolled_back");
  });

  test("rollback skips rolled_back ancestors in the walk", () => {
    const reg = new LoraRegistry(tmpFile());
    reg.add(rec("a1"));
    reg.promote("a1");
    reg.add(rec("a2", "a1"));
    reg.promote("a2");
    reg.rollback("coding"); // a2 rolled_back, a1 champion again
    reg.add(rec("a3", "a2")); // child of the BAD adapter
    reg.promote("a3"); // a1 retired
    const restored = reg.rollback("coding"); // a3 bad → skip a2 (rolled_back) → a1
    expect(restored?.id).toBe("a1");
  });

  test("lineage walks the genealogy, tolerating breaks and cycles", () => {
    const reg = new LoraRegistry(tmpFile());
    reg.add(rec("a1"));
    reg.add(rec("a2", "a1"));
    reg.add(rec("a3", "a2"));
    expect(reg.lineage("a3").map((a) => a.id)).toEqual(["a3", "a2", "a1"]);
    // Broken link: parent never registered.
    reg.add(rec("orphan", "ghost"));
    expect(reg.lineage("orphan").map((a) => a.id)).toEqual(["orphan"]);
  });

  test("guards: promote/markEvaluating/rollback reject wrong states", () => {
    const reg = new LoraRegistry(tmpFile());
    reg.add(rec("a1"));
    reg.promote("a1");
    expect(() => reg.promote("a1")).toThrow(/cannot promote/);
    expect(() => reg.markEvaluating("a1")).toThrow(/not candidate/);
    expect(() => reg.rollback("general")).toThrow(/nothing to roll back/);
    expect(() => reg.promote("ghost")).toThrow(/unknown adapter/);
  });

  test("corrupt or wrong-version store starts empty, never throws", () => {
    const file = tmpFile();
    writeFileSync(file, "{ not json");
    expect(new LoraRegistry(file).list()).toHaveLength(0);
    writeFileSync(file, JSON.stringify({ version: 99, adapters: [{}] }));
    expect(new LoraRegistry(file).list()).toHaveLength(0);
  });
});
