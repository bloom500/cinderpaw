/**
 * Cinderpaw Mood — the agent's internal emotional state.
 *
 * V1 scope: four in-memory dimensions, event-driven updates, no persistence,
 * no decay, no proactivity gate. Mood influences the tone of inner-thoughts
 * prompts when that feature is enabled (V2). In V1 it is live state that
 * the agent loop updates but no other code depends on.
 *
 * V2 additions deferred: decay toward resting values, shouldBeProactive() gate,
 * per-session persistence, cross-session mood continuity.
 */

export interface MoodState {
  energy: number;
  curiosity: number;
  satisfaction: number;
  concern: number;
}

export type MoodEvent =
  | "message_received"  // user sent a message
  | "message_answered"  // agent produced a final answer
  | "tool_success"      // a tool returned ok: true
  | "tool_error"        // a tool returned ok: false
  | "inference_error"   // LLM call failed
  | "budget_warning"    // token budget > 80% consumed
  | "new_topic";        // query has low similarity to recent history

const INITIAL: MoodState = {
  energy: 0.5,
  curiosity: 0.5,
  satisfaction: 0.6,
  concern: 0.1,
};

const DELTAS: Record<MoodEvent, Partial<MoodState>> = {
  message_received: { energy: +0.08, curiosity: +0.06 },
  message_answered: { energy: -0.04, satisfaction: +0.10 },
  tool_success:     { satisfaction: +0.06, concern: -0.05 },
  tool_error:       { satisfaction: -0.08, concern: +0.10 },
  inference_error:  { energy: -0.10, concern: +0.15, satisfaction: -0.10 },
  budget_warning:   { concern: +0.12, energy: -0.06 },
  new_topic:        { curiosity: +0.15, energy: +0.05 },
};

export class MoodEngine {
  #state: MoodState;

  constructor(initial: Partial<MoodState> = {}) {
    this.#state = { ...INITIAL, ...initial };
  }

  get state(): Readonly<MoodState> {
    return { ...this.#state };
  }

  /** Apply an event, updating mood dimensions with clamping to [0, 1]. */
  applyEvent(event: MoodEvent): void {
    const delta = DELTAS[event];
    this.#state = clamp({
      energy:       this.#state.energy       + (delta.energy       ?? 0),
      curiosity:    this.#state.curiosity    + (delta.curiosity    ?? 0),
      satisfaction: this.#state.satisfaction + (delta.satisfaction ?? 0),
      concern:      this.#state.concern      + (delta.concern      ?? 0),
    });
  }

  /** Human-readable summary for injection into inner-thoughts prompts. */
  describe(): string {
    const { energy, curiosity, satisfaction, concern } = this.#state;
    const parts: string[] = [];
    if (energy > 0.7)        parts.push("energized");
    else if (energy < 0.3)   parts.push("low energy");
    if (curiosity > 0.7)     parts.push("curious");
    if (satisfaction > 0.8)  parts.push("satisfied");
    else if (satisfaction < 0.3) parts.push("frustrated");
    if (concern > 0.6)       parts.push("concerned");
    return parts.length > 0 ? parts.join(", ") : "balanced";
  }

  /** Snapshot of current state (for logging). */
  snapshot(): MoodState {
    return { ...this.#state };
  }
}

function clamp(s: MoodState): MoodState {
  return {
    energy:       Math.max(0, Math.min(1, s.energy)),
    curiosity:    Math.max(0, Math.min(1, s.curiosity)),
    satisfaction: Math.max(0, Math.min(1, s.satisfaction)),
    concern:      Math.max(0, Math.min(1, s.concern)),
  };
}
