/**
 * What is drawn AROUND the creature.
 *
 * This file used to hold procedural props of its own: four sparkle pixels for
 * a tool call, a six-pixel check for a finished turn, a handful of confetti.
 * They were the right idea in the wrong quantity — the canvas has over a
 * thousand free cells and they used about five of them — and they duplicated
 * the props that were also carved into the sprite, so a sleeping creature drew
 * its Z's twice, at two sizes, in two places.
 *
 * All of it is gone. The scene now comes from `scenes.ts`: real objects, at the
 * size the reference pack drew them, standing three cells clear of the body.
 *
 * What stays here is the geometry, because the rest of the mascot measures
 * itself against it.
 */

import type { MascotState } from './frames';
import { SCENES, sceneFor } from './scenes';

export interface EffectPixel {
  x: number;
  y: number;
  color: string;
}

/**
 * Margin around the 32x34 sprite area inside the effects canvas.
 *
 * It grows UPWARD and sideways, never down. Below the creature's feet is the
 * composer's text field, and a prop drawn there covers what somebody is
 * typing; above and beside is empty chat, which is why the perch already
 * bleeds into it. The canvas that results is 60x54 cells for a creature that
 * occupies 722 of them, and the app still reserves the same 64px of layout.
 */
export const FX_MARGIN_X = 14;
export const FX_MARGIN_TOP = 20;

export const EFFECTS: Partial<Record<MascotState, (tick: number) => EffectPixel[]>> =
  Object.fromEntries(
    (Object.keys(SCENES) as MascotState[]).map((state) => [
      state,
      (tick: number) => sceneFor(state, tick),
    ]),
  );
