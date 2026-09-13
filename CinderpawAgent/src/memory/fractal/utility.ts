/**
 * Utility-scored retrieval (competence plan §3.3), first slice: the feedback
 * edge from a task's outcome back to the memories that were in context, and
 * the scorer that uses it.
 *
 * Today a memory is ranked by how much it resembles the question. Astra's
 * point: a memory is good if it HELPED, not if it looked relevant. That
 * needs something that does not exist yet: knowing, when a task closes,
 * which leaves were shown while it ran. This file is that ledger and the
 * arithmetic over it. Wiring it into the live recall path is the next
 * slice; here it is pure and measured.
 *
 *   present(leaf)  how many closed tasks had the leaf in context
 *   helped(leaf)   how many of those closed as verified successes
 *   utility(leaf)  (1 + helped) / (1 + present)
 *   score          similarity * utility ^ weight
 *
 * `weight` is one knob, default 0: today's behaviour, byte for byte, until
 * the campaign measures a value. At 1 a leaf that was shown ten times and
 * never helped is halved; a leaf never shown is left alone (utility 1), so
 * a memory is never buried for being new. The floor is that: unknown is
 * neutral, not penalised.
 *
 * What a "success" is: the runner's verdict on the receipt (plan §1), a
 * `done_when` that passed, or explicit user feedback. Never the model
 * saying it succeeded. The ledger takes a boolean and does not care which
 * verifier produced it; the caller is responsible for that honesty.
 */

/** One turn's recall: which leaves were shown, in rank order. */
export interface RecallRecord {
  turnId: string;
  leafIds: number[];
  at: number;
}

export interface LeafUtility {
  present: number;
  helped: number;
}

export class UtilityLedger {
  #open = new Map<string, RecallRecord>();
  #stats = new Map<number, LeafUtility>();

  /** A recall happened for `turnId`; remember what it showed. A second
   *  recall on the same turn merges, so a turn with two lookups still
   *  counts each leaf once. */
  shown(turnId: string, leafIds: number[], at = Date.now()): void {
    const prev = this.#open.get(turnId);
    const merged = prev ? [...new Set([...prev.leafIds, ...leafIds])] : [...new Set(leafIds)];
    this.#open.set(turnId, { turnId, leafIds: merged, at });
  }

  /** The task that spanned `turnIds` closed. Every leaf shown in any of
   *  those turns was present; if `success`, each of them helped. The turns
   *  are then forgotten: a task closes once. */
  closed(turnIds: string[], success: boolean): number {
    const leaves = new Set<number>();
    for (const t of turnIds) {
      const rec = this.#open.get(t);
      if (!rec) continue;
      for (const id of rec.leafIds) leaves.add(id);
      this.#open.delete(t);
    }
    for (const id of leaves) {
      const s = this.#stats.get(id) ?? { present: 0, helped: 0 };
      s.present++;
      if (success) s.helped++;
      this.#stats.set(id, s);
    }
    return leaves.size;
  }

  /** Turns shown but never closed (a crash, an abandoned chat). Not
   *  evidence either way; the caller may sweep them by age. */
  openTurns(): RecallRecord[] {
    return [...this.#open.values()];
  }

  utility(leafId: number): number {
    const s = this.#stats.get(leafId);
    return s ? (1 + s.helped) / (1 + s.present) : 1;
  }

  stats(leafId: number): LeafUtility | undefined {
    const s = this.#stats.get(leafId);
    return s ? { ...s } : undefined;
  }

  /** For persistence: every leaf with a count. */
  entries(): Array<[number, LeafUtility]> {
    return [...this.#stats.entries()].map(([id, s]) => [id, { ...s }]);
  }

  /** Restore counts written by `entries()`. */
  static from(entries: Iterable<[number, LeafUtility]>): UtilityLedger {
    const l = new UtilityLedger();
    for (const [id, s] of entries) l.#stats.set(id, { ...s });
    return l;
  }
}

/** The score, with the knob. `weight` 0 = similarity only (today). */
export function utilityScore(similarity: number, utility: number, weight = 0): number {
  if (weight === 0) return similarity;
  return similarity * Math.pow(utility, weight);
}

/** Re-rank hits by utility. Stable for equal scores, so at weight 0 the
 *  order is exactly the input order. */
export function rerankByUtility<T extends { leafId: number; score: number }>(
  hits: readonly T[],
  ledger: UtilityLedger,
  weight = 0,
): T[] {
  if (weight === 0) return [...hits];
  return hits
    .map((h, i) => ({ h, i, s: utilityScore(h.score, ledger.utility(h.leafId), weight) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => ({ ...x.h, score: x.s }));
}
