/**
 * Breathing — the organism's only continuous motion, and a deliberately gated
 * one. A Fractal Memory Search *recall* pulse starts a breath; this function
 * maps the elapsed time since that pulse to a Julia-morph value that swells and
 * decays back to exactly 0 within a fixed window. Once it returns 0 the render
 * loop can stop, so an idle organism is perfectly still (no idle animation —
 * motion means the agent is actively recalling).
 *
 * Shape: a ~0.3 Hz oscillation (z swelling in and out) under a linear decay
 * envelope, scaled to the shader's [0, BREATH_MORPH_MAX] Julia-blend range.
 * Pure and deterministic so it can be unit-tested without a clock or GPU.
 */

/** Total breath duration. After this, morph is exactly 0 (loop self-stops). */
export const BREATH_WINDOW_MS = 2600;

/** Peak Julia-blend, matching the shader's u_morph cap (0..0.12). */
export const BREATH_MORPH_MAX = 0.12;

/** Breaths per second (~0.3 Hz → a calm, ~3s-ish full cycle, clipped short). */
const BREATH_FREQ_HZ = 0.3;

/**
 * Morph value for a breath that started `elapsedMs` ago. 0 at the start, 0 at
 * and beyond the window, bounded by BREATH_MORPH_MAX in between, decaying so
 * later swells are weaker than earlier ones.
 */
export function breathingMorph(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= BREATH_WINDOW_MS) return 0;
  // Linear decay envelope 1 → 0 across the window.
  const env = 1 - elapsedMs / BREATH_WINDOW_MS;
  // 0.5 - 0.5·cos(2πft) → starts at 0, rises to 1, in [0, 1].
  const phase = 2 * Math.PI * BREATH_FREQ_HZ * (elapsedMs / 1000);
  const swell = 0.5 - 0.5 * Math.cos(phase);
  return BREATH_MORPH_MAX * env * swell;
}
