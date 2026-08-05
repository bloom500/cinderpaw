/**
 * The category table — and the four things it must never do.
 *
 * It must not invent a category. It must not attribute cache to a category.
 * It must not scale our count to match the provider's. It must not turn
 * "nobody told us" into zero.
 *
 * Each of those is asserted below, because each of them is a way to produce a
 * table that looks authoritative and decides the wrong thing.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { WorkingMemory } from "../src/memory/working.ts";
import { costReport, renderCostReport } from "../src/core/cost-report.ts";
import type { PromptPart } from "../src/memory/working.ts";

function lane(parts: PromptPart[], category: string, detail?: string): number {
  return parts
    .filter((p) => p.category === category && (detail === undefined || p.detail === detail))
    .reduce((n, p) => n + p.tokens, 0);
}

describe("the breakdown partitions the prompt", () => {
  test("every lane is measured from what is actually there", () => {
    const mem = new WorkingMemory("SYSTEM PROMPT ".repeat(20));
    mem.setTodoList([{ id: "t1", content: "ship the thing", status: "open" }]);
    mem.addReplayed("user", "what did we decide last week? ".repeat(10));
    mem.addReplayed("assistant", "we decided to ship. ".repeat(10));
    mem.addUser("now do it");
    mem.addToolResult("read_file", "file contents ".repeat(40));
    mem.addToolResult("shell_exec", "command output ".repeat(40));
    mem.addAssistant("done");

    const { parts, localTotal } = mem.breakdown();

    expect(lane(parts, "system_prompt")).toBeGreaterThan(0);
    expect(lane(parts, "drawer", "todo_list")).toBeGreaterThan(0);
    // Replayed history is its own lane, not folded into the live conversation.
    expect(lane(parts, "episodic_replay")).toBeGreaterThan(0);
    expect(lane(parts, "conversation", "user")).toBeGreaterThan(0);
    expect(lane(parts, "conversation", "assistant")).toBeGreaterThan(0);
    // Tool output is split per tool.
    expect(lane(parts, "tool_output", "read_file (full)")).toBeGreaterThan(0);
    expect(lane(parts, "tool_output", "shell_exec (full)")).toBeGreaterThan(0);
    // The total is the sum of the lanes, with nothing counted twice and nothing
    // left out — which is what makes a share meaningful.
    expect(localTotal).toBe(parts.reduce((n, p) => n + p.tokens, 0));
  });

  test("the lanes agree with estimatedTokens — one accounting, not two", () => {
    const mem = new WorkingMemory("SYSTEM");
    mem.setTodoList([{ id: "t1", content: "a task", status: "open" }]);
    mem.addUser("hello");
    mem.addToolResult("read_file", "contents");
    mem.addAssistant("hi");
    // If these ever diverge, one of them is lying about the prompt size, and
    // the compaction budget is driven by the other one.
    expect(mem.breakdown().localTotal).toBe(mem.estimatedTokens());
  });

  test("a trimmed tool result is a different lane from a full one", () => {
    const mem = new WorkingMemory("SYSTEM");
    mem.addUser("go");
    // Five results: #budgetToolResults keeps the newest four at full size and
    // cuts the oldest, which is exactly the split worth seeing.
    for (let i = 0; i < 5; i++) mem.addToolResult("read_file", "x ".repeat(3000));
    // maybeCompress runs the trimmer first; a huge budget keeps it from
    // summarising, so the only change is the trim.
    return mem.maybeCompress(async () => "unused", 1_000_000).then(() => {
      const { parts } = mem.breakdown();
      expect(lane(parts, "tool_output", "read_file (trimmed)")).toBeGreaterThan(0);
      expect(lane(parts, "tool_output", "read_file (full)")).toBeGreaterThan(0);
    });
  });

  test("empty drawers are omitted, not reported as zero rows", () => {
    const mem = new WorkingMemory("SYSTEM");
    mem.addUser("hi");
    const { parts } = mem.breakdown();
    expect(parts.some((p) => p.tokens === 0)).toBe(false);
    expect(parts.some((p) => p.detail === "skill_menu")).toBe(false);
  });
});

describe("the two accounts stay separate", () => {
  /** A completion row as the router would have written it. */
  function insert(
    db: ReturnType<typeof openDatabase>,
    over: Partial<{
      prompt: number;
      completion: number;
      fresh: number | null;
      read: number | null;
      write: number | null;
      parts: PromptPart[] | null;
      local: number | null;
    }> = {},
  ) {
    const parts = over.parts === undefined
      ? ([
          { category: "tool_output", detail: "read_file (full)", tokens: 600 },
          { category: "system_prompt", detail: "system_prompt", tokens: 400 },
        ] as PromptPart[])
      : over.parts;
    db.raw
      .query(
        `INSERT INTO completion_cost
           (ts, session_id, model, base_url, prompt_tokens, completion_tokens,
            fresh_tokens, cache_read_tokens, cache_write_tokens, latency_ms,
            used_fallback, breakdown_json, local_prompt_tokens)
         VALUES (1, 's1', 'm', 'u', $p, $c, $fresh, $read, $write, 100, 0, $bd, $local)`,
      )
      .run({
        $p: over.prompt ?? 1000,
        $c: over.completion ?? 50,
        $fresh: over.fresh === undefined ? 200 : over.fresh,
        $read: over.read === undefined ? 800 : over.read,
        $write: over.write === undefined ? 0 : over.write,
        $bd: parts ? JSON.stringify(parts) : null,
        $local: over.local === undefined ? (parts ? 1000 : null) : over.local,
      });
  }

  test("category shares are of what we SENT, and carry no cache attribution", () => {
    const db = openDatabase(":memory:");
    insert(db);
    const report = costReport(db.raw);

    expect(report.sent[0]!.detail).toBe("read_file (full)");
    expect(report.sent[0]!.shareOfSent).toBeCloseTo(0.6, 5);
    // The whole point: 80% of this request came from cache, and NOTHING in the
    // category table knows or claims that.
    expect(report.provider.cacheReadTokens).toBe(800);
    expect(Object.keys(report.sent[0]!)).not.toContain("cacheReadTokens");
    const rendered = renderCostReport(report);
    expect(rendered).toContain("Cache is reported per request, never per message");
    db.close();
  });

  test("our total is not scaled to the provider's — the gap is reported instead", () => {
    const db = openDatabase(":memory:");
    // Provider says 1400 prompt tokens; our tokenizer counted 1000.
    insert(db, { prompt: 1400, local: 1000 });
    const report = costReport(db.raw);

    expect(report.localPromptTokens).toBe(1000);
    expect(report.provider.promptTokens).toBe(1400);
    expect(report.tokenizerRatio).toBeCloseTo(1000 / 1400, 5);
    // Shares are computed against OUR total, so they still sum to 1 — scaling
    // them onto the provider's total is what would have been the invention.
    const sum = report.sent.reduce((n, l) => n + l.shareOfSent, 0);
    expect(sum).toBeCloseTo(1, 5);
    db.close();
  });

  test("a window where nobody reported cache says unknown, not zero", () => {
    const db = openDatabase(":memory:");
    insert(db, { fresh: null, read: null, write: null });
    const report = costReport(db.raw);

    expect(report.provider.cacheReadTokens).toBeNull();
    expect(report.provider.completionsReportingCache).toBe(0);
    expect(renderCostReport(report)).toContain("unknown, not zero");
    db.close();
  });

  test("a mixed window sums only the completions that spoke, and says how many", () => {
    const db = openDatabase(":memory:");
    insert(db, { read: 800, fresh: 200 });
    insert(db, { fresh: null, read: null, write: null });
    const report = costReport(db.raw);

    expect(report.provider.completions).toBe(2);
    expect(report.provider.completionsReportingCache).toBe(1);
    expect(report.provider.cacheReadTokens).toBe(800);
    expect(renderCostReport(report)).toContain("1 of 2 completions said nothing about cache");
    db.close();
  });

  test("a row written before the breakdown existed counts as provider-only", () => {
    const db = openDatabase(":memory:");
    insert(db, { parts: null, local: null });
    const report = costReport(db.raw);

    // We genuinely do not know what it contained, so it contributes nothing to
    // the category table — and is not guessed at from its total either.
    expect(report.sent).toEqual([]);
    expect(report.localPromptTokens).toBe(0);
    expect(report.provider.completions).toBe(1);
    expect(renderCostReport(report)).toContain("No completion in this window recorded a breakdown");
    db.close();
  });
});
