/**
 * Faza 1 — Async RSI Engine: production adapters for protocol (a).
 *
 * The bridge client (`RsiBridge`) is pure: it serialises the request
 * and resolves the Promise when the matching response arrives. These
 * tests verify the ADAPTER layer composes the right payload shape and
 * maps the Rust response back into the ratchet handler's vocabulary.
 *
 * The bridge is mocked here — we don't run a live Tauri host. What we
 * verify:
 *
 *   * commitGenome looks up the genome in the population, fills the
 *     `metadata` shape (score from req, lineage + mutationType from
 *     the Genome record, config serialised to a JSON string), and
 *     sends the expected snake_case payload to the bridge.
 *   * commitGenome surfaces the Rust error if the bridge rejects.
 *   * ratchetAttempt forwards the commit hash and maps
 *     `prior_score: null` to `previousBest: 0`.
 *   * ratchetAttempt surfaces the Rust error if the bridge rejects.
 *
 * The `db` dep is unused by the adapter body today but kept in the
 * signature so future audit-log writes (e.g. a row per commit attempt)
 * can hook in without breaking callers — see the doc on
 * `BridgeAdapterDeps`. Tests pass a `null as unknown as Database`
 * because nothing reads it.
 */

import { describe, expect, test } from "bun:test";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import {
  makeCommitGenomeAdapter,
  makeRatchetAttemptAdapter,
} from "../src/rsi/infra/adapters.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import type { Database } from "bun:sqlite";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

/** Hand-roll a bridge that records every request and lets the test
 *  enqueue a response with `enqueue`. The response is delivered
 *  synchronously to `onResponse` — no separate pump step — so the
 *  Promise the adapter awaits resolves on the same microtask. */
class MockBridge extends RsiBridge {
  readonly sent: Array<{
    type?: string;
    id: string;
    method: string;
    params: unknown;
  }> = [];

  constructor() {
    super({ send: (m) => this.sent.push(m as { id: string; method: string }) });
  }

  enqueue(resp: Omit<RsiResponse, "type">): void {
    this.onResponse({ type: "rsi_response", ...resp });
  }
}

function makeAdapters() {
  const bridge = new MockBridge();
  const pop = new PopulationManager();
  pop.add({
    id: "11111111-2222-4333-8444-555555555555",
    generation: 0,
    lineage: [],
    config: CFG,
    mutationType: "parametric",
  });
  // A second genome with mutationType "seed" — exercises the field
  // pass-through, including the bootstrap-seed case the audit chain
  // needs to disambiguate.
  pop.add({
    id: "00000000-0000-4000-8000-000000000001",
    generation: 0,
    lineage: [],
    config: CFG,
    mutationType: "seed",
  });
  // Stub db — nothing reads it yet; cast so the test compiles.
  const db = null as unknown as Database;
  const commit = makeCommitGenomeAdapter({
    bridge,
    pop,
    db,
    strategy: "test-strategy",
  });
  const ratchet = makeRatchetAttemptAdapter({ bridge });
  return { bridge, pop, commit, ratchet };
}

describe("RSI bridge adapters", () => {
  test("commitGenome serialises genome config to a JSON string and forwards snake_case metadata", async () => {
    const { bridge, commit } = makeAdapters();

    // Trigger the request FIRST so `sent[0]` exists, then enqueue
    // the response for that id. The bridge synchronously pushes to
    // `sent` inside `request()` (before the Promise suspends), so
    // awaiting the call after enqueueing is safe.
    const promise = commit({
      genomeId: "11111111-2222-4333-8444-555555555555",
      score: 73.4,
      tokenCost: 1234,
      durationMs: 567,
    });
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: true,
      data: { commitHash: "a".repeat(40) },
    });

    const ack = await promise;
    expect(ack.commitHash).toBe("a".repeat(40));

    // Verify the wire shape: method, snake_case params, JSON-stringified
    // genome_json, mutationType from the Genome record.
    const req = bridge.sent[0]!;
    expect(req.method).toBe("rsi_commit_genome");
    expect(req.params).toMatchObject({
      genome_id: "11111111-2222-4333-8444-555555555555",
      candidate_branch: "genome-11111111", // short-id convention (dash, not slash — Rust rejects '/')
      metadata: {
        score: 73.4,
        strategy: "test-strategy",
        parent_lineage: [],
        mutation_type: "parametric",
        cost_tokens: 1234,
        duration_ms: 567,
      },
    });
    const genomeJson = (req.params as { genome_json: unknown }).genome_json;
    expect(typeof genomeJson).toBe("string");
    // Parses back to the same config the population holds.
    const parsed = JSON.parse(genomeJson as string) as GenomeConfig;
    expect(parsed.temperature).toBeCloseTo(0.7);
    expect(parsed.toolPreferenceWeights).toEqual([0.25, 0.25, 0.25, 0.25]);

    expect(bridge.sent.length).toBe(1);
  });

  test("commitGenome surfaces the Rust error verbatim when the bridge rejects", async () => {
    const { bridge, commit } = makeAdapters();
    const promise = commit({
      genomeId: "11111111-2222-4333-8444-555555555555",
      score: 50,
      tokenCost: 0,
      durationMs: 0,
    });
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: false,
      error: "rsi_commit_genome: candidate_branch must not be 'main'",
    });

    await expect(promise).rejects.toThrow("candidate_branch must not be 'main'");
  });

  test("commitGenome falls back to 'unknown' mutation_type for genomes added before the field existed", async () => {
    const { bridge, pop, commit } = makeAdapters();
    pop.add({ id: "pre-7b-genome", generation: 0, lineage: [] });
    // ^ no mutationType — the adapter must still produce a valid
    //   request (Rust's IterationMetadata.mutation_type is non-optional).

    const promise = commit({
      genomeId: "pre-7b-genome",
      score: 50,
      tokenCost: 0,
      durationMs: 0,
    });
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: true,
      data: { commitHash: "c".repeat(40) },
    });

    const ack = await promise;
    expect(ack.commitHash).toBe("c".repeat(40));
    expect((bridge.sent[0]!.params as { metadata: { mutation_type: string } }).metadata.mutation_type)
      .toBe("unknown");
  });

  test("commitGenome propagates mutationType='seed' for bootstrap seeds (audit disambiguation)", async () => {
    const { bridge, commit } = makeAdapters();
    const promise = commit({
      genomeId: "00000000-0000-4000-8000-000000000001", // the seed
      score: 0, // seeds are committed with score 0 — they precede the ratchet
      tokenCost: 0,
      durationMs: 0,
    });
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: true,
      data: { commitHash: "s".repeat(40) },
    });

    await promise;
    expect((bridge.sent[0]!.params as { metadata: { mutation_type: string } }).metadata.mutation_type)
      .toBe("seed");
  });

  test("commitGenome throws on unknown genomeId (defensive — population is the source of truth)", async () => {
    const { commit } = makeAdapters();
    await expect(
      commit({
        genomeId: "00000000-deadbeef-0000-0000-000000000000",
        score: 0,
        tokenCost: 0,
        durationMs: 0,
      }),
    ).rejects.toThrow("unknown genome");
  });

  test("ratchetAttempt forwards commit hash and maps prior_score → previousBest", async () => {
    const { bridge, ratchet } = makeAdapters();
    const promise = ratchet("a".repeat(40), 73.4);
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: true,
      data: {
        advanced: true,
        previous_tip: "b".repeat(40),
        new_tip: "a".repeat(40),
        candidate_score: 73.4,
        prior_score: 50,
      },
    });

    const result = await promise;
    // candidateScore is the number the ratchet actually compared — read out
    // of the commit's own metadata. It used to be dropped here, which is why
    // a decline could report `previous best 0 >= 50`, a sentence that is false
    // as written and names neither side of the real comparison.
    expect(result).toEqual({
      advanced: true,
      previousBest: 50,
      candidateScore: 73.4,
      hadPrior: true,
    });

    const req = bridge.sent[0]!;
    expect(req.method).toBe("rsi_ratchet_attempt");
    expect(req.params).toEqual({ candidate_commit: "a".repeat(40) });
  });

  test("ratchetAttempt normalises prior_score=null to previousBest=0 (fresh repo)", async () => {
    const { bridge, ratchet } = makeAdapters();
    const promise = ratchet("a".repeat(40), 73.4);
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: true,
      data: {
        advanced: true,
        previous_tip: null,
        new_tip: "a".repeat(40),
        candidate_score: 73.4,
        prior_score: null,
      },
    });
    const result = await promise;
    expect(result.previousBest).toBe(0);
    expect(result.advanced).toBe(true);
    // …and `hadPrior` keeps "there was no champion" distinguishable from
    // "the champion scored zero", which previousBest alone flattens.
    expect(result.hadPrior).toBe(false);
    expect(result.candidateScore).toBe(73.4);
  });

  test("ratchetAttempt surfaces Rust errors verbatim", async () => {
    const { bridge, ratchet } = makeAdapters();
    const promise = ratchet("z".repeat(40), 0);
    bridge.enqueue({
      id: bridge.sent[0]!.id,
      ok: false,
      error: "candidate commit has no parseable iteration metadata",
    });
    await expect(promise).rejects.toThrow("no parseable iteration metadata");
  });
});
