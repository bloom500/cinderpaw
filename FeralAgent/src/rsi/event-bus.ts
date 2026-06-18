/**
 * Faza 1 — Async RSI Engine: the event bus.
 *
 * The engine is event-driven, not loop-based: there is no master
 * scheduler ticking through generations. Handlers subscribe to event
 * types and may emit further events in response (e.g. an `EvalComplete`
 * handler emits `RatchetAdvanced`). To keep that cascade deterministic
 * and free of unbounded recursion, the bus serialises everything through
 * a single async pump — one event is fully handled before the next is
 * pulled from the queue.
 */

/** The nine fundamental events of the RSI engine (PLAN.md "Async RSI Engine"). */
export type RsiEventType =
  | "GenomeBorn"
  | "EvalStarted"
  | "EvalComplete"
  | "RatchetAdvanced"
  | "GenomeDied"
  | "ExtinctionTriggered"
  | "PBTSyncTriggered"
  | "GoodhartDetected"
  | "RecalcitranceHigh";

/** Base event shape: a discriminant `type` plus arbitrary payload fields. */
export interface RsiEvent {
  type: RsiEventType;
  [key: string]: unknown;
}

export type RsiEventHandler = (event: RsiEvent) => Promise<void> | void;

export class EventBus {
  private readonly handlers = new Map<RsiEventType, RsiEventHandler[]>();
  private readonly queue: RsiEvent[] = [];
  private pumping = false;

  /** Register `handler` to run on every event of `type`. */
  on(type: RsiEventType, handler: RsiEventHandler): void {
    const list = this.handlers.get(type);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(type, [handler]);
    }
  }

  /**
   * Enqueue `event` for dispatch.
   *
   * If no pump is running, this call becomes the pump: it drains the
   * queue (including any events emitted by handlers along the way) and
   * resolves only once the whole cascade is exhausted. If a pump is
   * already running — the usual case when a handler emits a follow-up
   * event — the event is appended to the live queue and `emit` returns
   * immediately; the in-flight pump will process it in order.
   *
   * Within a single pump, events are handled strictly one at a time, so
   * a handler always runs to completion before the next event begins
   * (no re-entrant nesting). That is what makes a cascade such as
   * EvalComplete → RatchetAdvanced → PBTSyncTriggered deterministic.
   */
  async emit(event: RsiEvent): Promise<void> {
    this.queue.push(event);
    if (this.pumping) return;

    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        const list = this.handlers.get(next.type);
        if (!list) continue;
        for (const handler of list) {
          await handler(next);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
