/**
 * "Is that you?" has to work on every connector, and nobody can link 21 chat
 * apps by hand before a release. This holds it at the source: every
 * allowlist gate reports its sender first, and every connector in the
 * catalog is one connectors_pair accepts. A new transport that forgets
 * either fails here, not on a stranger's machine.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, PAIRABLE } from "../src/tools/builtin/connectors-manage.ts";

const dir = join(import.meta.dir, "../src/transports");

test("every allowlist gate reports its sender before it decides", () => {
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("non-allowlisted")) return;
      // The gate is the `if` just above the log line; the report sits above
      // the gate (or a comment or two above it, in connectors.ts).
      const before = lines.slice(Math.max(0, i - 6), i).join("\n");
      if (!before.includes("onSender?.(")) missing.push(`${f}:${i + 1}`);
    });
  }
  expect(missing).toEqual([]);
});

test("every connector in the catalog can be paired", () => {
  expect(Object.keys(CATALOG).filter((id) => !PAIRABLE[id])).toEqual([]);
});
