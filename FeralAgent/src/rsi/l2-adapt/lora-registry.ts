/**
 * Faza 4 Slice 1 — the LoRA substrate: registry + provenance + rollback.
 * Spec: `docs/superpowers/specs/2026-07-02-faza4-personal-adaptation-design.md`.
 *
 * L2 Personal Adaptation trains per-user LoRA adapters and promotes them
 * through the SAME BRSI ladder the config genomes use: candidate → eval →
 * confidence → human review → champion. This module owns the durable
 * state of that ladder — who exists, whose child they are, who is
 * champion per domain, and how to walk back a regression.
 *
 * Deliberate mirrors of the existing substrate:
 *   - store discipline = `pending-patches.ts` (versioned JSON envelope,
 *     corrupt/missing/wrong-version → start empty, never throw on load);
 *   - champion semantics = `champion.json`, but PER DOMAIN — a coding
 *     adapter and a writing adapter evolve independently;
 *   - provenance = the genealogy tree Darius asked for: every adapter
 *     records its parent, dataset (id + hash), hyperparameters, and
 *     metrics, so `lineage(id)` reconstructs the full ancestry.
 *
 * What this module does NOT do (by design):
 *   - no training — `TrainerBackend` is the pluggable seam (Slice 4);
 *   - no eval — the gate reuses the existing Tier 0 / contract FSM
 *     machinery (Slice 3);
 *   - no auto-promotion — promotion is called by the host AFTER the
 *     human gate; L2 keeps the human in the loop (spec §Human Gate).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../infra/instance-paths.ts";

/** Adapter domains — the registry is champion-per-domain. `general` is
 *  the fallback the router uses when no domain-specific champion exists. */
export type LoraDomain =
  | "general"
  | "coding"
  | "research"
  | "writing"
  | "planning";

export type LoraStatus =
  | "candidate" // trained, not yet evaluated
  | "evaluating" // in the eval gate right now
  | "champion" // the live adapter for its domain
  | "retired" // demoted by a newer champion (still on disk, still valid)
  | "rolled_back"; // demoted by a regression rollback (suspect)

/** The genealogy record — every field is provenance, not configuration.
 *  The registry never re-derives any of this; the trainer/eval pipeline
 *  reports it once at birth/evaluation and it is frozen thereafter. */
export interface LoraProvenance {
  /** Registry id of the adapter this one was trained on top of (or
   *  whose dataset lineage it continues). Undefined for roots. */
  parentId?: string;
  /** Dataset Builder output this adapter was trained on. */
  datasetId: string;
  /** Content hash of the dataset JSONL — training is only reproducible
   *  if the data is pinned. */
  datasetHash: string;
  /** Trainer hyperparameters, as an opaque bag (rank, alpha, lr, epochs
   *  — shapes differ per backend; the registry just carries them). */
  hyperparameters: Record<string, unknown>;
  /** Metrics reported by the trainer and/or the eval gate. Same policy:
   *  opaque bag, written by the pipeline, read by the dashboard. */
  metrics: Record<string, number>;
}

export interface LoraAdapterRecord {
  /** Registry id. Convention: `lora-<domain>-<n>` but not enforced. */
  id: string;
  domain: LoraDomain;
  /** Path to the adapter file (GGUF LoRA) on disk. */
  adapterPath: string;
  /** The foundation model this adapter applies to (GGUF filename). An
   *  adapter is meaningless — and unsafe to load — on another base. */
  baseModel: string;
  status: LoraStatus;
  provenance: LoraProvenance;
  createdAt: number;
  /** Set when the status last changed (promotion, retirement, rollback). */
  statusChangedAt?: number;
}

/** Default on-disk location, next to the other RSI state. */
export function defaultLoraRegistryPath(): string {
  return join(paths().root, "lora-registry.json");
}

interface Envelope {
  version: 1;
  adapters: LoraAdapterRecord[];
}

/**
 * The pluggable trainer seam (Slice 4 implements backends; Slice 1 only
 * fixes the contract). FER orchestrates — the backend does the work.
 */
export interface TrainerBackend {
  /** Backend name for provenance + UI ("llama.cpp-finetune", "unsloth"…). */
  name: string;
  /** Is this backend usable on THIS machine right now (binary present,
   *  GPU/driver requirements met)? Hosts render "training unavailable"
   *  states from this — never a crash. */
  available(): Promise<boolean>;
  /** Run one training job. Resolves with the adapter file + trainer
   *  metrics; rejects only on infrastructure failure (a bad loss is a
   *  RESULT, not an error — the eval gate judges quality). */
  train(job: {
    baseModel: string;
    datasetPath: string;
    hyperparameters: Record<string, unknown>;
    outputDir: string;
  }): Promise<{ adapterPath: string; metrics: Record<string, number> }>;
}

export class LoraRegistry {
  #adapters: LoraAdapterRecord[] = [];

  constructor(private readonly file: string = defaultLoraRegistryPath()) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Envelope;
      if (parsed?.version === 1 && Array.isArray(parsed.adapters)) {
        this.#adapters = parsed.adapters;
      }
    } catch {
      // Missing / corrupt / wrong version → start empty (journal
      // discipline). Adapter FILES on disk are the durable artifacts;
      // the registry is resolvable state.
    }
  }

  #save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const envelope: Envelope = { version: 1, adapters: this.#adapters };
    writeFileSync(this.file, JSON.stringify(envelope, null, 2));
  }

  /** Register a freshly trained adapter as `candidate`. Idempotent per
   *  id (a re-run of the same job does not duplicate the registry). */
  add(rec: Omit<LoraAdapterRecord, "status" | "createdAt">): LoraAdapterRecord {
    const existing = this.get(rec.id);
    if (existing) return existing;
    const full: LoraAdapterRecord = {
      ...rec,
      status: "candidate",
      createdAt: Date.now(),
    };
    this.#adapters.push(full);
    this.#save();
    return structuredClone(full);
  }

  get(id: string): LoraAdapterRecord | undefined {
    const a = this.#adapters.find((x) => x.id === id);
    return a ? structuredClone(a) : undefined;
  }

  list(domain?: LoraDomain): LoraAdapterRecord[] {
    const all = domain
      ? this.#adapters.filter((a) => a.domain === domain)
      : this.#adapters;
    return structuredClone(all);
  }

  /** The live adapter for a domain, if any. */
  champion(domain: LoraDomain): LoraAdapterRecord | undefined {
    const a = this.#adapters.find(
      (x) => x.domain === domain && x.status === "champion",
    );
    return a ? structuredClone(a) : undefined;
  }

  /** candidate → evaluating. The eval gate calls this when it picks the
   *  candidate up, so the dashboard shows what is in flight. */
  markEvaluating(id: string): void {
    const a = this.#require(id);
    if (a.status !== "candidate") {
      throw new Error(`adapter '${id}' is ${a.status}, not candidate`);
    }
    this.#setStatus(a, "evaluating");
  }

  /** Promote an adapter to champion of its domain. Called by the host
   *  AFTER eval + confidence + HUMAN approval (spec §Human Gate — the
   *  registry cannot verify the human, so the caller carries that
   *  responsibility; keep this the only call site policy). The previous
   *  champion (if any) is demoted to `retired`. */
  promote(id: string): LoraAdapterRecord {
    const a = this.#require(id);
    if (a.status !== "evaluating" && a.status !== "candidate") {
      throw new Error(`adapter '${id}' is ${a.status} — cannot promote`);
    }
    const prev = this.#adapters.find(
      (x) => x.domain === a.domain && x.status === "champion",
    );
    if (prev) this.#setStatus(prev, "retired");
    this.#setStatus(a, "champion");
    return structuredClone(a);
  }

  /** Retire a candidate/evaluating adapter the human REJECTED at the
   *  review card — it never becomes champion and stops showing as "in
   *  flight". Champions are not retired here (that's `promote`'s demotion
   *  or `rollback`). */
  retire(id: string): LoraAdapterRecord {
    const a = this.#require(id);
    if (a.status !== "candidate" && a.status !== "evaluating") {
      throw new Error(`adapter '${id}' is ${a.status} — cannot retire`);
    }
    this.#setStatus(a, "retired");
    return structuredClone(a);
  }

  /**
   * Regression rollback: demote the current champion to `rolled_back`
   * and re-promote its nearest promotable ancestor (walking parentId
   * past other rolled-back/missing links). Returns the new champion, or
   * undefined when no ancestor exists — domain reverts to the plain
   * foundation model, which is always a safe floor.
   */
  rollback(domain: LoraDomain): LoraAdapterRecord | undefined {
    const champ = this.#adapters.find(
      (x) => x.domain === domain && x.status === "champion",
    );
    if (!champ) {
      throw new Error(`no champion for domain '${domain}' — nothing to roll back`);
    }
    this.#setStatus(champ, "rolled_back");

    // Walk the genealogy for the nearest ancestor that isn't itself
    // suspect. `retired` ancestors are the normal case (they were
    // champions once and only stepped down for the adapter we just
    // pulled).
    let cursor = champ.provenance.parentId;
    while (cursor) {
      const parent = this.#adapters.find((x) => x.id === cursor);
      if (!parent) break;
      if (parent.status === "retired") {
        this.#setStatus(parent, "champion");
        this.#save();
        return structuredClone(parent);
      }
      cursor = parent.provenance.parentId;
    }
    this.#save();
    return undefined;
  }

  /** The ancestry chain of an adapter, oldest last: [self, parent,
   *  grandparent, …]. Broken links end the walk (no throw — genealogy
   *  is diagnostic data). */
  lineage(id: string): LoraAdapterRecord[] {
    const chain: LoraAdapterRecord[] = [];
    let cursor: string | undefined = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const a = this.#adapters.find((x) => x.id === cursor);
      if (!a) break;
      chain.push(structuredClone(a));
      cursor = a.provenance.parentId;
    }
    return chain;
  }

  #setStatus(a: LoraAdapterRecord, status: LoraStatus): void {
    a.status = status;
    a.statusChangedAt = Date.now();
    this.#save();
  }

  #require(id: string): LoraAdapterRecord {
    const a = this.#adapters.find((x) => x.id === id);
    if (!a) throw new Error(`unknown adapter '${id}'`);
    return a;
  }
}
