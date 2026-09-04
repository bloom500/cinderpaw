/**
 * Atomic write: the temp file must be unique per call.
 *
 * `atomicWriteFile` writes to a temp path, fsyncs, then renames over the
 * target. The temp name used to be `${file}.tmp.${pid}.${Date.now()}`, which is
 * unique across processes but NOT within one: `Date.now()` has millisecond
 * resolution, so two async writes to the same file that start in the same
 * millisecond pick the same temp path. One renames it away, the other renames a
 * file that is no longer there and throws ENOENT — a write the caller was told
 * would either fully happen or fully fail, that instead reports failure after
 * the temp was already consumed by someone else.
 *
 * The three callers are `write_file`, `edit_file` and `connectors-manage`, all
 * of which the agent can run in parallel through sub-agents, so "two writes in
 * the same millisecond" is a normal Tuesday, not a thought experiment.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/atomic-write.ts";

describe("atomicWriteFile", () => {
  test("concurrent writes to one file all settle, and leave no temp behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-atomic-"));
    const file = join(dir, "contended.json");

    // Enough concurrent writers that several land in the same millisecond.
    const writers = Array.from({ length: 64 }, (_, i) =>
      atomicWriteFile(file, JSON.stringify({ writer: i })),
    );
    const settled = await Promise.allSettled(writers);

    const rejected = settled.filter((s) => s.status === "rejected");
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);

    // Whoever won, the file is one whole document, never a shredded one.
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { writer: number };
    expect(typeof parsed.writer).toBe("number");

    // A rename that lost its temp leaves the temp on disk. Nothing may remain.
    const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});
