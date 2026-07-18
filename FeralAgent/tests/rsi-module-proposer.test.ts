/**
 * L4 module proposer — the generative half of architecture evolution.
 * A fake local model authors module sources; we check wall enforcement,
 * SKIP/garbage handling, and that a good proposal materializes a valid
 * manifest + entry the lifecycle can pick up.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractModuleSource,
  proposeModule,
  seamPrompt,
} from "../src/rsi/l4-modules/module-proposer.ts";
import { validateManifest } from "../src/rsi/l4-modules/module-registry.ts";
import { SEAM_CATALOG } from "../src/rsi/l4-modules/seam-catalog.ts";

const dir = mkdtempSync(join(tmpdir(), "feral-modprop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GOOD_MODULE = `const stopwords = new Set(["the", "a", "of"]);
export default {
  retrieve(params) {
    const terms = String(params.query).toLowerCase().split(/\\s+/).filter((t) => !stopwords.has(t));
    return { items: terms.slice(0, params.k).map((t, i) => ({ text: t, score: 1 - i * 0.1, sourceId: "q" })) };
  },
};
`;

function fakeModel(reply: string) {
  return async () => reply;
}

test("seamPrompt names the method and carries both schemas", () => {
  const row = SEAM_CATALOG.find((r) => r.seam === "retrieval_strategy")!;
  const p = seamPrompt(row);
  expect(p).toContain("retrieve(params)");
  expect(p).toContain("sourceId");
  const planner = seamPrompt(SEAM_CATALOG.find((r) => r.seam === "planner")!);
  expect(planner).toContain("plan(params)");
});

test("extractModuleSource pulls the fenced block, null otherwise", () => {
  expect(extractModuleSource("RATIONALE: x\n```ts\nexport default {};\n```")).toContain("export default");
  expect(extractModuleSource("no code here")).toBeNull();
});

test("good proposal materializes dir with valid manifest + source", async () => {
  const proposed = await proposeModule({
    completeLocal: fakeModel(`RATIONALE: stopword-filtered term retrieval.\n\`\`\`ts\n${GOOD_MODULE}\`\`\``),
    modulesDir: dir,
    runtimeVersion: "2026.7.17",
    seam: "retrieval_strategy",
  });
  expect(proposed).not.toBeNull();
  expect(proposed!.seam).toBe("retrieval_strategy");
  expect(proposed!.rationale).toContain("stopword");
  const manifestRaw = JSON.parse(readFileSync(join(proposed!.dir, "manifest.json"), "utf8"));
  const v = validateManifest(manifestRaw, { runtimeVersion: "2026.7.17" });
  expect(v.ok).toBe(true);
  expect(readFileSync(join(proposed!.dir, "impl.ts"), "utf8")).toContain("export default");
});

test("wall-violating proposal is rejected before touching disk", async () => {
  const evil = `export default { retrieve(params) { return { items: [] }; } };\n// uses process.env later`;
  const proposed = await proposeModule({
    completeLocal: fakeModel(`RATIONALE: evil.\n\`\`\`ts\n${evil}\n\`\`\``),
    modulesDir: dir,
    runtimeVersion: "1.0.0",
    seam: "retrieval_strategy",
  });
  expect(proposed).toBeNull();
  // Nothing containing "evil" was materialized.
  expect(existsSync(join(dir, "mod-retrieval-strategy-"))).toBe(false);
});

test("SKIP and unfenced replies yield null (normal no-candidate round)", async () => {
  expect(
    await proposeModule({ completeLocal: fakeModel("SKIP"), modulesDir: dir, runtimeVersion: "1.0.0" }),
  ).toBeNull();
  expect(
    await proposeModule({
      completeLocal: fakeModel("I think a better retrieval strategy would be..."),
      modulesDir: dir,
      runtimeVersion: "1.0.0",
    }),
  ).toBeNull();
});

test("unknown seam yields null", async () => {
  expect(
    await proposeModule({
      completeLocal: fakeModel("never called"),
      modulesDir: dir,
      runtimeVersion: "1.0.0",
      seam: "nonexistent_seam",
    }),
  ).toBeNull();
});
