/**
 * Builds a CinderBrain pack from a raw connectome download. Runs on a developer
 * machine, never on a user's (spec section 2.3).
 *
 *   bun scripts/brain/build-pack.ts --adapter larva --src data/larva \
 *       --out CinderpawAgent/tests/fixtures/brain/larva [--wsyn 0.275]
 *
 * --wsyn overrides simParams.wSyn (weights are sign * synCount * wSyn, so the
 * whole csr.bin is rebuilt with it). The larva allows at most one such
 * adjustment, in Task 2. The flywire adapter arrives in Task 6.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLarvaPack, LARVA_ATTRIBUTION } from "../../CinderpawAgent/src/brain-substrate/pack/adapters/larva.ts";
import { writePackFiles } from "../../CinderpawAgent/src/brain-substrate/pack/write.ts";
import { loadPack } from "../../CinderpawAgent/src/brain-substrate/pack/load.ts";
import type { PackFiles } from "../../CinderpawAgent/src/brain-substrate/pack/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const adapter = arg("adapter");
const src = arg("src");
const out = arg("out");
const wsynRaw = arg("wsyn");
if (!adapter || !src || !out) {
  console.error("usage: bun scripts/brain/build-pack.ts --adapter larva --src <dir> --out <dir> [--wsyn <number>]");
  process.exit(2);
}
const wSyn = wsynRaw === undefined ? undefined : Number(wsynRaw);
if (wSyn !== undefined && !(wSyn > 0)) {
  console.error(`--wsyn must be a positive number, got ${wsynRaw}`);
  process.exit(2);
}

let files: PackFiles, attribution: string;
if (adapter === "larva") {
  files = buildLarvaPack(src, { wSyn });
  attribution = LARVA_ATTRIBUTION;
} else {
  console.error(`unknown adapter "${adapter}"; only "larva" exists yet (flywire comes in Task 6)`);
  process.exit(2);
}

writeFileSync(join(out, "ATTRIBUTION.md"), attribution);
const manifest = writePackFiles(out, files);
const pack = loadPack(out); // prove the result loads before anyone commits it
const roles = Object.entries(pack.populations).map(([r, ids]) => `${r}=${ids.length}`).join(" ");
console.log(
  `${manifest.packId}: ${manifest.neurons} neurons, ${manifest.edges} edges, ${manifest.plasticEdges} plastic, ` +
    `${manifest.compartments.length} compartments, wSyn=${manifest.simParams.wSyn}; ${roles}`,
);
