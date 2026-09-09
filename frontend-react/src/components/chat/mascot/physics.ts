/**
 * The bit of physics a draggable pet needs, and not one term more.
 *
 * Kept out of the component and free of React on purpose: a step function that
 * takes a body and a slice of time and hands back the next body is something a
 * test can drive frame by frame, and something a person reading the numbers can
 * change without understanding the perch at all. The perch owns the pointer and
 * the render loop; this file owns gravity.
 *
 * Units are pixels and SECONDS. Every constant below is therefore readable out
 * loud: gravity is 2200 pixels per second per second, the creature keeps 42% of
 * its speed through a bounce. Per-frame constants would have been shorter to
 * write and would silently mean something different on a 120Hz screen.
 */

export interface Body {
  /** Offset from the perch. `y` grows DOWNWARD like every other screen
   *  coordinate, so the perch floor is `y = 0` and being held up in the air is
   *  a negative `y`. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The box the creature may not leave, as offsets from the perch.
 *
 * `minY` is the ceiling and it is not optional. The first version of this file
 * had a floor and no ceiling, on the reasoning that gravity brings everything
 * back. It does, eventually — but an upward flick writes a velocity of a few
 * thousand pixels per second, which puts the creature hundreds of pixels above
 * the window and out of sight for a second or more. From the person's side
 * that is not physics, it is the pet leaving.
 */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
}

const GRAVITY = 2_200;
/** Speed kept after hitting the floor. Under a half, so a drop settles in two
 *  or three visible bounces instead of pattering for a second and a half. */
const FLOOR_BOUNCE = 0.42;
const WALL_BOUNCE = 0.5;
/** Sideways speed lost per floor contact, and per second in the air. Landing
 *  scrubs speed much faster than flying does, which is what makes a dropped
 *  thing stop rather than skate. */
const FLOOR_FRICTION = 0.72;
const AIR_DRAG_PER_S = 0.6;
/** Below this, in pixels per second, it has stopped. Without a floor like this
 *  a bounce halves forever and the creature never comes to rest. */
const REST_SPEED = 40;

/**
 * One step of free flight. `dt` is seconds; the caller clamps it.
 *
 * `impact` is the downward speed at the moment of a floor contact, before the
 * bounce takes its cut, so the caller can tell a creature that was dropped an
 * inch from one that was thrown at the ground and squash it accordingly.
 */
export function step(
  body: Body,
  dt: number,
  bounds: Bounds,
): { body: Body; landed: boolean; impact: number } {
  let { x, y, vx, vy } = body;
  let landed = false;
  let impact = 0;

  vy += GRAVITY * dt;
  // Exponential decay rather than a straight subtraction: subtracting a fixed
  // amount per frame can drive the speed through zero and out the other side,
  // which reads as the creature twitching backwards at the end of a throw.
  vx *= Math.max(0, 1 - AIR_DRAG_PER_S * dt);

  x += vx * dt;
  y += vy * dt;

  if (x < bounds.minX) {
    x = bounds.minX;
    vx = -vx * WALL_BOUNCE;
  } else if (x > bounds.maxX) {
    x = bounds.maxX;
    vx = -vx * WALL_BOUNCE;
  }

  // The ceiling, checked before the floor so a box shorter than one frame of
  // travel cannot let a body pass straight through it.
  if (y < bounds.minY) {
    y = bounds.minY;
    vy = -vy * WALL_BOUNCE;
  }

  if (y >= 0) {
    y = 0;
    landed = true;
    impact = Math.max(0, vy);
    vy = -vy * FLOOR_BOUNCE;
    vx *= FLOOR_FRICTION;
    // Resting is a state, not a slow limit. Both components go to zero
    // together so it cannot end up sliding along the floor with no bounce
    // left, which looks like a bug rather than a creature.
    if (Math.abs(vy) < REST_SPEED) {
      vy = 0;
      if (Math.abs(vx) < REST_SPEED) vx = 0;
    }
  }

  return { body: { x, y, vx, vy }, landed, impact };
}

/**
 * How far to lean, in degrees, for a given sideways speed.
 *
 * The creature is one rigid sprite, so the only way it can look like it has
 * weight is to tilt: it leans into a carry, swings behind a throw, and comes
 * upright as it slows. Without this a drag moves a picture across the screen,
 * which is the "monolith" complaint exactly.
 */
export function leanDegrees(vx: number): number {
  const MAX = 22;
  const PER_DEGREE = 55; // px/s of sideways speed per degree of lean
  return Math.max(-MAX, Math.min(MAX, vx / PER_DEGREE));
}

/**
 * How much to squash on landing, as a scale factor for height.
 *
 * Nothing below a gentle drop registers, and the hardest landing flattens it
 * to three quarters — past that it stops reading as a creature hitting a
 * surface and starts reading as a rendering bug.
 */
export function squashFor(impact: number): number {
  const IGNORE_BELOW = 300;
  const FULL_AT = 2_400;
  const MAX_SQUASH = 0.25;
  if (impact <= IGNORE_BELOW) return 1;
  const t = Math.min(1, (impact - IGNORE_BELOW) / (FULL_AT - IGNORE_BELOW));
  return 1 - MAX_SQUASH * t;
}

/** Has it stopped? Only true on the floor, so a body at the top of its arc
 *  with no speed for one frame is not mistaken for a settled one. */
export function atRest(body: Body): boolean {
  return body.y === 0 && body.vx === 0 && body.vy === 0;
}
