/**
 * rsiState.ts — small reactive store for the visible state of the RSI engine
 * that the Memory Layers tree needs to draw its ambient signals (trunk aura,
 * season tint, HUD pill copy). Subscribes to the same `dream_cycle` and
 * `rsi_engine_event` lines the rest of the UI watches, but keeps the result
 * in a separate subscriber list so a hot tree mount doesn't get laggier.
 */
import {
  events,
  type DreamCycleLine,
  type RsiEngineEventLine,
} from '@/lib/tauri';

export type RsiPhase = 'idle' | 'dreaming' | 'ratcheted' | 'error';

export interface RsiSnapshot {
  phase: RsiPhase;
  /** last ratchet timestamp (ms epoch), or null if the engine has never
   *  advanced a candidate in this session. */
  lastRatchetAt: number | null;
  /** Best known champion score (null before the engine has scored once). */
  lastRatchetScore: number | null;
  /** When the current dream cycle started (ms epoch), or null when idle. */
  dreamStartedAt: number | null;
  /** Last error message, if any. Cleared on a fresh start. */
  lastError: string | null;
}

const EMPTY: RsiSnapshot = {
  phase: 'idle',
  lastRatchetAt: null,
  lastRatchetScore: null,
  dreamStartedAt: null,
  lastError: null,
};

type Listener = (snap: RsiSnapshot) => void;

class RsiStateStore {
  #snap: RsiSnapshot = { ...EMPTY };
  #listeners = new Set<Listener>();
  #ratchetFlashUntil = 0;
  #unlistens: Array<() => void> = [];
  #subscribed = false;

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snap);
    this.#ensureSubscribed();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#teardown();
    };
  }

  /** Hot read used by the RAF loop — cheap, never throws. */
  snapshot(): RsiSnapshot {
    if (this.#ratchetFlashUntil > 0 && Date.now() > this.#ratchetFlashUntil) {
      this.#ratchetFlashUntil = 0;
      if (this.#snap.phase === 'ratcheted') this.#update({ phase: 'idle' });
    }
    return this.#snap;
  }

  /**
   * Bumped by every teardown, so a registration still in flight can tell that
   * the subscriber it was started for is already gone.
   *
   * `#subscribed` is set synchronously but the listeners register
   * asynchronously. A page that mounted and unmounted before `listen()`
   * resolved ran `#teardown()` against an empty `#unlistens`, and the
   * registration then landed afterwards with nothing left that could ever
   * release it — every quick mount/unmount cycle added another permanent
   * handler, all of them firing on every dream-cycle event for the rest of the
   * session.
   */
  #generation = 0;

  #ensureSubscribed(): void {
    if (this.#subscribed) return;
    this.#subscribed = true;
    const generation = this.#generation;
    void (async () => {
      try {
        const uDream = await events.onDreamCycle.listen((e: DreamCycleLine) => this.#applyDream(e));
        const uRsi = await events.onRsiEngineEvent.listen((e: RsiEngineEventLine) => this.#applyRsi(e));
        if (generation !== this.#generation) {
          // Torn down while we were registering — release immediately.
          try { uDream(); } catch { /* ignore */ }
          try { uRsi(); } catch { /* ignore */ }
          return;
        }
        this.#unlistens.push(() => uDream(), () => uRsi());
      } catch (err) {
        // Listen failures are non-fatal — the tree still draws the idle state.
        console.warn('[rsiState] subscribe failed', err);
      }
    })();
  }

  #teardown(): void {
    this.#generation += 1;
    for (const u of this.#unlistens) {
      try { u(); } catch { /* ignore */ }
    }
    this.#unlistens = [];
    this.#subscribed = false;
  }

  #applyDream(e: DreamCycleLine): void {
    if (!e) return;
    if (e.phase === 'started') {
      this.#update({
        phase: 'dreaming',
        dreamStartedAt: Date.now(),
        lastError: null,
      });
    } else if (e.phase === 'ended') {
      this.#update({ phase: 'idle', dreamStartedAt: null });
    }
  }

  #applyRsi(e: RsiEngineEventLine): void {
    if (!e) return;
    if (e.event === 'started') {
      this.#update({ phase: 'dreaming', lastError: null });
    } else if (e.event === 'stopped') {
      // A ratchet only fires when bestScore advanced. Without that flag we
      // surface a generic "idle" transition. The Rust engine only emits
      // stopped with a non-zero bestScore when something actually moved.
      const score = typeof e.bestScore === 'number' ? e.bestScore : null;
      if (score !== null && score > 0) {
        this.#update({
          phase: 'ratcheted',
          lastRatchetAt: Date.now(),
          lastRatchetScore: score,
          dreamStartedAt: null,
        });
        this.#ratchetFlashUntil = Date.now() + 1500;
      } else {
        this.#update({ phase: 'idle', dreamStartedAt: null });
      }
    }
  }

  #update(patch: Partial<RsiSnapshot>): void {
    this.#snap = { ...this.#snap, ...patch };
    for (const l of this.#listeners) l(this.#snap);
  }
}

export const rsiState = new RsiStateStore();
