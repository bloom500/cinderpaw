/**
 * Faza 1 — Async RSI Engine: the population manager.
 *
 * Owns the in-memory view of the live population that the eval worker,
 * the ratchet handler, and the selection/mutation handler all read from.
 * Three responsibilities, per PLAN.md "Scored Memory Pool":
 *
 *   1. the live set of genomes (alive / dead);
 *   2. the best-all-time fitness — the ratchet reference. It is
 *      monotonic and survives a genome's death;
 *   3. fitness sharing: `shared_fitness = fitness_score / niche_count`,
 *      recomputed whenever the population changes, so monoculture is
 *      penalised proactively rather than detected after the fact.
 *
 * The `concurrency` parameter (how many evals run at once) also lives
 * here; it starts at 1 and is raised once the engine is validated.
 */

import type { GenomeConfig } from "./genome.ts";

/** A genome's in-memory record. Mirrors the `rsi_genome` table shape. */
export interface Genome {
  id: string;
  generation: number;
  /** Parent genome ids (git LCA lineage is tracked separately, in Rust). */
  lineage: string[];
  /** The evolving agent configuration (strategy_dna). Optional on the
   *  record because the manager never interprets it — handlers do. */
  config?: GenomeConfig;
  /** 0..100; null until the genome has been evaluated. */
  fitnessScore: number | null;
  /** Per-task score vector from the eval suite; null until evaluated. */
  behavioralFingerprint: number[] | null;
  /** fitness_score / niche_count; null until shared fitness is computed. */
  sharedFitness: number | null;
  alive: boolean;
}

/** The fields needed to bring a genome into the world (a GenomeBorn). */
export interface GenomeSpec {
  id: string;
  generation: number;
  lineage: string[];
  config?: GenomeConfig;
}

/** The eval result attached to a genome on EvalComplete. */
export interface EvalRecord {
  fitnessScore: number;
  behavioralFingerprint: number[];
}

/** The best-all-time genome, the ratchet reference. */
export interface BestRecord {
  genomeId: string;
  score: number;
}

export interface PopulationOptions {
  /** Concurrent evals. Starts at 1; raised once the engine is validated. */
  concurrency?: number;
  /** Cosine-similarity above which two genomes share a behavioural niche. */
  nicheThreshold?: number;
}

export class PopulationManager {
  private readonly genomes = new Map<string, Genome>();
  /** Best fitness ever recorded. Monotonic: only ever increases, and
   *  is not cleared when the record-holding genome dies. */
  private bestRecord: BestRecord | null = null;

  /** How many evals may run at once. Mutated via `rsi_set_concurrency`. */
  concurrency: number;
  private readonly nicheThreshold: number;

  constructor(opts: PopulationOptions = {}) {
    this.concurrency = opts.concurrency ?? 1;
    this.nicheThreshold = opts.nicheThreshold ?? 0.85;
  }

  /** Insert a newly-born genome into the live population. */
  add(spec: GenomeSpec): void {
    this.genomes.set(spec.id, {
      id: spec.id,
      generation: spec.generation,
      lineage: spec.lineage,
      config: spec.config,
      fitnessScore: null,
      behavioralFingerprint: null,
      sharedFitness: null,
      alive: true,
    });
  }

  /** Attach an eval result to a genome (called on EvalComplete). */
  recordEval(id: string, record: EvalRecord): void {
    const g = this.genomes.get(id);
    if (!g) throw new Error(`recordEval: unknown genome '${id}'`);
    g.fitnessScore = record.fitnessScore;
    g.behavioralFingerprint = record.behavioralFingerprint;
    if (this.bestRecord === null || record.fitnessScore > this.bestRecord.score) {
      this.bestRecord = { genomeId: id, score: record.fitnessScore };
    }
    this.recomputeSharedFitness();
  }

  /** Mark a genome dead (a GenomeDied). It leaves the alive set but its
   *  contribution to best-all-time is retained. */
  kill(id: string): void {
    const g = this.genomes.get(id);
    if (!g) throw new Error(`kill: unknown genome '${id}'`);
    g.alive = false;
    this.recomputeSharedFitness();
  }

  /**
   * Recompute `shared_fitness = fitness_score / niche_count` for every
   * live, evaluated genome. niche_count is the number of live evaluated
   * genomes (itself included) within `nicheThreshold` cosine similarity
   * on the behavioral fingerprint. Called on every population change.
   */
  recomputeSharedFitness(): void {
    const scored = this.alive().filter(
      (g) => g.fitnessScore !== null && g.behavioralFingerprint !== null,
    );
    for (const g of scored) {
      let nicheCount = 0;
      for (const other of scored) {
        if (
          cosineSimilarity(g.behavioralFingerprint!, other.behavioralFingerprint!) >
          this.nicheThreshold
        ) {
          nicheCount += 1;
        }
      }
      g.sharedFitness = nicheCount > 0 ? g.fitnessScore! / nicheCount : g.fitnessScore!;
    }
  }

  /** The best-all-time genome + score, or null if nothing is evaluated. */
  best(): BestRecord | null {
    return this.bestRecord;
  }

  /** The live genomes, in insertion order. */
  alive(): Genome[] {
    return [...this.genomes.values()].filter((g) => g.alive);
  }

  /** Look up a genome record by id (alive or dead). */
  get(id: string): Genome | undefined {
    return this.genomes.get(id);
  }
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0
 * when either vector has zero magnitude (an unevaluated/degenerate
 * fingerprint shares a niche with nothing).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
