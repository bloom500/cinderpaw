import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateForTests } from "../db.ts";
import { costOfRun } from "./cost-report.ts";

function dbWith(rows: Array<{ model: string; baseUrl: string; tokens: number; usd: number | null }>): Database {
  const db = new Database(":memory:");
  migrateForTests(db);
  for (const r of rows) {
    db.query(
      `INSERT INTO completion_cost (ts, session_id, model, base_url, prompt_tokens, completion_tokens, latency_ms, used_fallback, cost_usd)
       VALUES (10, 's', ?, ?, ?, 0, 1, 0, ?)`,
    ).run(r.model, r.baseUrl, r.tokens, r.usd);
  }
  return db;
}

describe("costOfRun", () => {
  test("provider-reported figures add up and are not marked estimated", () => {
    const db = dbWith([
      { model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api", tokens: 1000, usd: 0.0012 },
      { model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api", tokens: 1000, usd: 0.0008 },
    ]);
    expect(costOfRun(db, "s", 0)).toEqual({ tokens: 2000, usd: 0.002, estimated: false });
  });

  test("one unpriced completion makes the whole sum an estimate; loopback prices at $0", () => {
    const db = dbWith([
      { model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api", tokens: 1000, usd: 0.001 },
      { model: "glm-4.5-air", baseUrl: "https://api.z.ai/v1", tokens: 1000, usd: null }, // blended glm = 0.0015/1k
      { model: "qwen3", baseUrl: "http://127.0.0.1:11435/v1", tokens: 5000, usd: null },
    ]);
    const out = costOfRun(db, "s", 0);
    expect(out.estimated).toBe(true);
    expect(out.usd).toBeCloseTo(0.0025, 6);
  });

  test("another session and an earlier time window are not counted", () => {
    const db = dbWith([{ model: "m", baseUrl: "https://openrouter.ai/api", tokens: 10, usd: 1 }]);
    expect(costOfRun(db, "other", 0)).toEqual({ tokens: 0, usd: 0, estimated: false });
    expect(costOfRun(db, "s", 11)).toEqual({ tokens: 0, usd: 0, estimated: false });
  });
});
