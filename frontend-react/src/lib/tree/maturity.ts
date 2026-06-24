/**
 * Persisted monotonic "maturity floor" for the tree's structural depth.
 * The floor only ever increases — earned complexity is never lost, even when
 * memory is pruned. Stored per-install in localStorage; degrades to 0 (no
 * persistence) if storage is unavailable, without throwing.
 */
const KEY = 'feral.fractal.maturityFloor';

export const maturity = {
  /** Load the current persisted floor (0 when unset or unavailable). */
  load(): number {
    try {
      const v = localStorage.getItem(KEY);
      const n = v == null ? 0 : parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  },
  /** Save a new floor value — monotonic: never decreases below current. */
  save(value: number): number {
    const next = Math.max(this.load(), value, 0);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* storage unavailable — reactive-only depth this session */
    }
    return next;
  },
};
