/**
 * L4 paired module eval: the incumbent run must use the incumbent.
 *
 * For a `retrieval_strategy` candidate, both runs of the paired suite inject
 * a `[Memory context]` block — the candidate's from the module under test, the
 * incumbent's from the builtin FractalMemory ranking the live `recall` tool
 * uses. The builtin reaches the sidecar through `seamBuiltins`, and boot never
 * passed it: the incumbent's lookup threw "no builtin bound", recall swallowed
 * that as "", and every retrieval module was compared against NO memory at all
 * — not against the ranking it would replace.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import { RsiSidecar } from "../src/rsi/sidecar.ts";
import { openDatabase } from "../src/db.ts";
import type { InferenceRequest } from "../src/types.ts";

class Bridge extends RsiBridge {
  private n = 0;
  constructor() {
    super({ send: () => {} });
  }
  request<T>(method: string, params: unknown): Promise<T> {
    const id = `rsi-${++this.n}`;
    const data =
      method === "rsi_get_tier0_specs"
        ? [{ id: "tier0/x", name: "x", description: "x", prompt: "What is 2+2?", kind: "fact_lookup", expected: { type: "fact_lookup", answer: "4" } }]
        : null;
    setTimeout(() => this.onResponse({ id, ok: true, data } as RsiResponse), 0);
    return super.request<T>(method, params);
  }
}

describe("L4 paired eval — the incumbent is the live builtin", () => {
  test("a retrieval_strategy incumbent run carries the builtin's memory block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-l4-pairing-"));
    try {
      const prompts: string[] = [];
      const sidecar = new RsiSidecar({
        bridge: new Bridge(),
        db: openDatabase(":memory:"),
        router: {
          complete: async (req: InferenceRequest) => {
            prompts.push(String(req.messages.at(-1)?.content ?? ""));
            return { content: "4", totalTokens: 2, promptTokens: 1, completionTokens: 1, model: "fake", usedFallback: false };
          },
        },
        send: () => {},
        championPath: join(dir, "champion.json"),
        seamBuiltins: {
          retrieval_strategy: async () => ({ items: [{ text: "the user measures everything in metric units", score: 1, sourceId: "1" }] }),
        },
      });
      const deps = sidecar.moduleEvalDeps({
        seam: "retrieval_strategy",
        moduleDir: join(dir, "unused"),
        limits: { timeoutMs: 1000, maxRssMb: 64 },
      });
      await deps.runSuite("incumbent");
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.every((p) => p.includes("[Memory context]"))).toBe(true);
      expect(prompts[0]).toContain("metric units");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
