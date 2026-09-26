/**
 * The genome that is live must not be culled from the population that breeds.
 *
 * The Hall of Fame (extinction immunity) only ever inducted the best RAW eval
 * score (`recordEval`). That genome is often not the champion: a lucky run the
 * confidence gate rejected still holds the record. The ratcheted champion —
 * the config the user's agent is actually running — had no protection, and a
 * periodic extinction (every 20 evals, 80% of the unprotected pool) could
 * remove it, so the search drifted away from what is live while an unproven
 * outlier stayed immune forever. Extinction's own doc assumed the Hall of
 * Fame "already contains main"; it did not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/rsi/infra/event-bus.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import { RatchetHandler } from "../src/rsi/l1-config/ratchet-handler.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
};

describe("the ratcheted champion is extinction-immune", () => {
  test("an extinction that kills every unprotected genome spares the live champion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-champ-immune-"));
    dirs.push(dir);
    const pop = new PopulationManager();
    for (const id of ["outlier", "champ", "weak"]) {
      pop.add({ id, generation: 0, lineage: [], config, mutationType: "seed" });
    }
    const bus = new EventBus();
    new RatchetHandler(
      bus,
      {
        commitGenome: async () => ({ commitHash: "e".repeat(40) }),
        ratchetAttempt: async () => ({ advanced: true, previousBest: 0, candidateScore: 40, hadPrior: false }),
        journalPath: () => join(dir, "journal.jsonl"),
      },
      pop,
    );

    // The outlier holds the best raw score (auto-inducted), but it is the
    // champion that the ratchet promotes.
    pop.recordEval("outlier", { fitnessScore: 54, behavioralFingerprint: [1, 1] });
    pop.recordEval("weak", { fitnessScore: 5, behavioralFingerprint: [0, 1] });
    pop.recordEval("champ", { fitnessScore: 40, behavioralFingerprint: [1, 0] });
    await bus.emit({ type: "EvalComplete", genomeId: "champ", score: 40, errored: false });

    const culled = pop.selectForExtinction({ killFraction: 1, eliteCount: 0 });
    expect(culled).not.toContain("champ");
    expect(culled).toContain("weak");
  });
});
