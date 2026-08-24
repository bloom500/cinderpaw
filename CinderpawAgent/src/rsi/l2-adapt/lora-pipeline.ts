/**
 * Faza 4 Slice 4 (host half) — the LoRA training pipeline orchestrator.
 * Spec: `docs/superpowers/specs/2026-07-02-faza4-personal-adaptation-design.md` §Slice 4.
 *
 * Composes the pieces the earlier slices delivered, in order:
 *
 *   dataset (path + pinned hash) → TrainerBackend.train → LoraRegistry.add
 *   (candidate) → markEvaluating → eval run (injected) → evaluateLoraGate
 *   → LoraReviewStore card → HUMAN resolve → LoraRegistry.promote.
 *
 * The eval run is injected (`runEval`): actually loading a candidate
 * adapter for evaluation is the Rust inference half — this module only
 * demands "give me the Tier 0 outcome and the paired scores for this
 * adapter file" and judges what comes back. Tests inject a fake; the
 * live host wires the real one when adapter hot-load lands.
 *
 * The review card mirrors `pending-patches.ts`: versioned JSON store,
 * corrupt → start empty, explicit human resolve. One rule the patch
 * store doesn't have: `approve` is only legal on a `recommend_promote`
 * verdict — the gate's reject is not overridable from the card (L2 spec:
 * the human gate can veto a promotion, never force one past the stats).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import type { PairedSample } from "../infra/confidence.ts";
import { evaluateLoraGate, type LoraGateResult, type Tier0Result } from "./lora-eval-gate.ts";
import { paths } from "../infra/instance-paths.ts";
import type {
  LoraAdapterRecord,
  LoraDomain,
  LoraRegistry,
  TrainerBackend,
} from "./lora-registry.ts";

/** Deterministic adapter id: same base + dataset + hyperparameters ⇒
 *  same id ⇒ `registry.add` stays idempotent across re-runs. */
export function deriveAdapterId(
  domain: LoraDomain,
  baseModel: string,
  datasetHash: string,
  hyperparameters: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(baseModel)
    .update("\0")
    .update(datasetHash)
    .update("\0")
    .update(JSON.stringify(hyperparameters, Object.keys(hyperparameters).sort()))
    .digest("hex")
    .slice(0, 12);
  return `lora-${domain}-${digest}`;
}

// ---------------------------------------------------------------------------
// Review cards (the human gate's inbox)
// ---------------------------------------------------------------------------

export type LoraReviewStatus = "pending" | "approved" | "rejected";

export interface LoraReviewCard {
  /** Same id as the registry record. */
  adapterId: string;
  domain: LoraDomain;
  gate: LoraGateResult;
  /** Trainer metrics, for the card UI (loss curve headline etc.). */
  metrics: Record<string, number>;
  status: LoraReviewStatus;
  createdAt: number;
  resolvedAt?: number;
}

export function defaultLoraReviewsPath(): string {
  return join(paths().root, "lora-reviews.json");
}

interface Envelope {
  version: 1;
  cards: LoraReviewCard[];
}

export class LoraReviewStore {
  #cards: LoraReviewCard[] = [];

  constructor(private readonly file: string = defaultLoraReviewsPath()) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Envelope;
      if (parsed?.version === 1 && Array.isArray(parsed.cards)) {
        this.#cards = parsed.cards;
      }
    } catch {
      // Journal discipline: the registry + adapter files are the durable
      // record; the review inbox is resolvable state.
    }
  }

  #save(): void {
    try {
      const envelope: Envelope = { version: 1, cards: this.#cards };
      atomicWriteFileSync(this.file, JSON.stringify(envelope, null, 2));
    } catch {
      // Best-effort: review inbox is resolvable state, registry is durable. Corruption handled on load.
    }
  }

  /** Idempotent per adapterId, like every other store on this substrate. */
  add(card: Omit<LoraReviewCard, "status" | "createdAt">): LoraReviewCard {
    const existing = this.get(card.adapterId);
    if (existing) return existing;
    const full: LoraReviewCard = { ...card, status: "pending", createdAt: Date.now() };
    this.#cards.push(full);
    this.#save();
    return structuredClone(full);
  }

  get(adapterId: string): LoraReviewCard | undefined {
    const c = this.#cards.find((x) => x.adapterId === adapterId);
    return c ? structuredClone(c) : undefined;
  }

  list(): LoraReviewCard[] {
    return structuredClone(this.#cards);
  }

  /** pending → approved/rejected. `approve` is refused unless the gate
   *  said `recommend_promote` (see module docblock). */
  resolve(adapterId: string, action: "approve" | "reject"): LoraReviewCard {
    const c = this.#cards.find((x) => x.adapterId === adapterId);
    if (!c) throw new Error(`unknown review card '${adapterId}'`);
    if (c.status !== "pending") {
      throw new Error(`review card '${adapterId}' is ${c.status}, not pending`);
    }
    if (action === "approve" && c.gate.verdict !== "recommend_promote") {
      throw new Error(
        `cannot approve '${adapterId}': gate verdict is ${c.gate.verdict}`,
      );
    }
    c.status = action === "approve" ? "approved" : "rejected";
    c.resolvedAt = Date.now();
    this.#save();
    return structuredClone(c);
  }
}

// ---------------------------------------------------------------------------
// The training cycle
// ---------------------------------------------------------------------------

export interface LoraTrainCycleArgs {
  registry: LoraRegistry;
  reviews: LoraReviewStore;
  trainer: TrainerBackend;
  domain: LoraDomain;
  /** Foundation model the adapter applies to (GGUF filename/path). */
  baseModel: string;
  /** Dataset Builder output — path on disk + the pinned content hash. */
  dataset: { id: string; path: string; hash: string };
  hyperparameters: Record<string, unknown>;
  /** Where the trainer writes. One dir per job; the caller owns naming. */
  outputDir: string;
  /**
   * Evaluate the candidate adapter: run Tier 0 + the paired eval suite
   * with the adapter loaded (candidate) vs the current champion or plain
   * base model (baseline). Injected — see module docblock.
   */
  runEval: (adapterPath: string) => Promise<{
    tier0: Tier0Result;
    samples: PairedSample[];
  }>;
}

export type LoraTrainCycleResult =
  | {
      ok: true;
      record: LoraAdapterRecord;
      card: LoraReviewCard;
    }
  | { ok: false; reason: string };

/**
 * One full candidate cycle: train → register → evaluate → card. Never
 * promotes — the card's human resolve does that via `applyLoraReview`.
 * Infra failures (trainer unavailable, train/eval throw) come back as
 * `{ok:false}`; they are host-visible states, not crashes.
 */
export async function runLoraTrainingCycle(
  args: LoraTrainCycleArgs,
): Promise<LoraTrainCycleResult> {
  const { registry, reviews, trainer, domain, baseModel, dataset } = args;

  if (!(await trainer.available())) {
    return {
      ok: false,
      reason:
        `trainer '${trainer.name}' unavailable on this machine — set FERAL_LORA_TRAINER_BIN ` +
        `to a binary implementing the trainer contract (docs/LORA_TRAINER.md; ` +
        `scripts/setup-lora-trainer validates + registers it)`,
    };
  }

  const id = deriveAdapterId(domain, baseModel, dataset.hash, args.hyperparameters);

  // Idempotency across re-runs: a card for this exact job already went to
  // the human — don't retrain, don't re-open the question.
  const existingCard = reviews.get(id);
  if (existingCard) {
    const record = registry.get(id);
    if (record) return { ok: true, record, card: existingCard };
  }

  let adapterPath: string;
  let metrics: Record<string, number>;
  const trainStarted = Date.now();
  try {
    const trained = await trainer.train({
      baseModel,
      datasetPath: dataset.path,
      hyperparameters: args.hyperparameters,
      outputDir: args.outputDir,
    });
    adapterPath = trained.adapterPath;
    // Slice 5: training time is a first-class provenance metric — the
    // dashboard's cost story needs it and the trainer can't self-report
    // (it doesn't know when the host called it).
    metrics = { ...trained.metrics, training_ms: Date.now() - trainStarted };
  } catch (err) {
    return {
      ok: false,
      reason: `training failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const record = registry.add({
    id,
    domain,
    adapterPath,
    baseModel,
    provenance: {
      parentId: registry.champion(domain)?.id,
      datasetId: dataset.id,
      datasetHash: dataset.hash,
      hyperparameters: args.hyperparameters,
      metrics,
    },
  });
  if (record.status === "candidate") registry.markEvaluating(id);

  let gate: LoraGateResult;
  try {
    const evalRun = await args.runEval(adapterPath);
    gate = evaluateLoraGate(evalRun.tier0, evalRun.samples);
  } catch (err) {
    return {
      ok: false,
      reason: `eval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const card = reviews.add({ adapterId: id, domain, gate, metrics });
  return { ok: true, record: registry.get(id)!, card };
}

// ---------------------------------------------------------------------------
// Slice 5 — dashboard aggregation
// ---------------------------------------------------------------------------

/** The dashboard numbers (spec §Slice 5), derived purely from the registry
 *  + review inbox — no extra state to keep in sync. */
export interface LoraStats {
  /** Adapters ever trained (registry rows). */
  adapters: number;
  /** Distinct datasets those adapters were trained on. */
  datasets: number;
  /** Cards still waiting on the human. */
  pendingReviews: number;
  /** Live champions across domains. */
  champions: number;
  /** Adapters pulled by a regression rollback. */
  rollbacks: number;
  /** approved / (approved + rejected). Null until something was resolved. */
  acceptanceRate: number | null;
  /** Mean paired-eval gain (bootstrap mean of candidate − baseline) over
   *  cards that reached statistics. Null when none did. */
  averageGain: number | null;
  /** Total measured training time, ms (Slice 5 provenance metric). */
  trainingMsTotal: number;
}

export function loraStats(
  adapters: readonly LoraAdapterRecord[],
  cards: readonly LoraReviewCard[],
): LoraStats {
  const resolved = cards.filter((c) => c.status !== "pending");
  const approved = resolved.filter((c) => c.status === "approved").length;
  const gains = cards
    .map((c) => c.gate.confidence?.bootstrap.mean)
    .filter((g): g is number => typeof g === "number" && Number.isFinite(g));
  return {
    adapters: adapters.length,
    datasets: new Set(adapters.map((a) => a.provenance.datasetHash)).size,
    pendingReviews: cards.filter((c) => c.status === "pending").length,
    champions: adapters.filter((a) => a.status === "champion").length,
    rollbacks: adapters.filter((a) => a.status === "rolled_back").length,
    acceptanceRate: resolved.length > 0 ? approved / resolved.length : null,
    averageGain:
      gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / gains.length : null,
    trainingMsTotal: adapters.reduce(
      (s, a) => s + (a.provenance.metrics.training_ms ?? 0),
      0,
    ),
  };
}

/**
 * Apply a human decision to a pending card: `approve` promotes the
 * adapter to champion of its domain (the ONLY call site of
 * `registry.promote` in the pipeline — spec §Human Gate); `reject`
 * retires the candidate so the dashboard doesn't show it in flight
 * forever.
 */
export function applyLoraReview(
  registry: LoraRegistry,
  reviews: LoraReviewStore,
  adapterId: string,
  action: "approve" | "reject",
): { card: LoraReviewCard; record: LoraAdapterRecord } {
  const card = reviews.resolve(adapterId, action);
  const record =
    action === "approve" ? registry.promote(adapterId) : registry.retire(adapterId);
  return { card, record };
}
