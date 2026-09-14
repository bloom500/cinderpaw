import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("brain:bench on the larva completes and writes a report", async () => {
  const out = mkdtempSync(join(tmpdir(), "brain-bench-"));
  const proc = Bun.spawn(
    ["bun", "run", "src/brain-substrate/bench/run.ts", "--pack", "tests/fixtures/brain/larva", "--seeds", "3", "--shuffles", "2", "--pairs", "40", "--interference", "80", "--out", out],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);
  const files = readdirSync(out);
  expect(files.some((f) => f.endsWith("-synthetic.md"))).toBe(true);
  expect(files.some((f) => f.endsWith("-synthetic.json"))).toBe(true);
}, 120_000);
