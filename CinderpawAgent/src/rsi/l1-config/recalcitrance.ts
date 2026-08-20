/**
 * Faza 1 — Async RSI Engine: recalcitrance tracking.
 *
 * Recalcitrance is the fact that each successive score improvement costs
 * more than the last. The tracker records, on every RatchetAdvanced,
 * `improvement_difficulty = tokens / Δscore` (Δscore = score −
 * previousBest, always > 0 for a ratchet). When the moving average of
 * the last `window` events exceeds `multiplier` × the baseline (mean of
 * the first `baselineCount` events), it emits RecalcitranceHigh — the
 * signal for Fractal Search to zoom out and add wild explorers (Faza 3).
 *
 * The emission is latched: it fires once on the not-high → high
 * transition and re-arms only after the average recovers below the
 * threshold, so a sustained plateau doesn't spam the bus.
 */

import type { EventBus, RsiEvent } from "../infra/event-bus.ts";

export interface RecalcitranceOptions {
  /** Number of recent events in the moving average (default 10). */
  window?: number;
  /** Number of leading events that define the baseline (default 5). */
  baselineCount?: number;
  /** Threshold ratio MA / baseline that trips the signal (default 3). */
  multiplier?: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export class RecalcitranceTracker {
  private readonly window: number;
  private readonly baselineCount: number;
  private readonly multiplier: number;
  private readonly difficulties: number[] = [];
  private latched = false;

  constructor(
    private readonly bus: EventBus,
    opts: RecalcitranceOptions = {},
  ) {
    this.window = opts.window ?? 10;
    this.baselineCount = opts.baselineCount ?? 5;
    this.multiplier = opts.multiplier ?? 3;
    bus.on("RatchetAdvanced", (e) => this.onRatchet(e));
  }

  private async onRatchet(event: RsiEvent): Promise<void> {
    const delta = (event.score as number) - (event.previousBest as number);
    if (delta <= 0) return; // a ratchet always improves; guard anyway
    this.difficulties.push((event.tokenCost as number) / delta);

    // No baseline yet → nothing to compare against.
    if (this.difficulties.length < this.baselineCount) return;

    const baseline = mean(this.difficulties.slice(0, this.baselineCount));
    const movingAverage = mean(this.difficulties.slice(-this.window));
    const high = baseline > 0 && movingAverage > this.multiplier * baseline;

    if (high && !this.latched) {
      this.latched = true;
      await this.bus.emit({
        type: "RecalcitranceHigh",
        movingAverage,
        baseline,
        ratio: baseline > 0 ? movingAverage / baseline : Infinity,
      });
    } else if (!high) {
      this.latched = false; // recovered — re-arm
    }
  }
}
