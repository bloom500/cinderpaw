/**
 * INVARIANT I2 TEST — single advancement path.
 *
 * The invariant doc asked for exactly this and it was never written: a
 * grep-based guard that no module other than the known ones can advance the
 * promoted lineage. A second, quieter sender of `rsi_ratchet_attempt` is not a
 * failing test anywhere else in the suite; it is simply a new way for main to
 * move, and nothing would notice.
 *
 * Two rings are held:
 *   1. Who may put `rsi_ratchet_attempt` on the wire (the bridge adapters).
 *   2. Who may call the adapter the deploy stage is handed.
 *
 * The doc named `ratchet-handler.ts` for both, which stopped being true when
 * the contract FSM landed: the deploy leaves own the call now. The lists below
 * are reality, and a new entry has to be argued for here before it can ship.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const SENDERS = ["rsi/infra/adapters.ts", "rsi/l3-code/code-rsi.ts"];
const CALLERS = ["rsi/infra/contract-leaves.ts", "rsi/l3-code/code-leaves.ts"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** A mention in a comment is documentation, not a code path. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function filesWhere(match: (body: string) => boolean): string[] {
  return tsFiles(SRC)
    .filter((f) => match(code(readFileSync(f, "utf8"))))
    .map((f) => relative(SRC, f).split(sep).join("/"))
    .sort();
}

describe("single advancement path", () => {
  it("has exactly one set of modules that can put the ratchet on the wire", () => {
    expect(filesWhere((b) => b.includes('"rsi_ratchet_attempt"'))).toEqual(SENDERS.sort());
  });

  it("has exactly one set of modules that can call the ratchet adapter", () => {
    expect(filesWhere((b) => /\.ratchetAttempt\s*\(/.test(b))).toEqual(CALLERS.sort());
  });

  it("keeps the promoted branch out of the candidate path", () => {
    // The other half of the invariant: a candidate commit must not be able to
    // name `main` as its own branch and advance by writing to it directly.
    const runtime = readFileSync(join(SRC, "..", "..", "crates", "cinderpaw-core", "src", "rsi", "runtime.rs"), "utf8");
    expect(runtime).toContain("resolves to the promoted branch");
  });
});
