/**
 * Where to click when something asks for ACTION6 without saying where.
 *
 * ACTION6 is the only action that carries coordinates and it REQUIRES them:
 * sent bare, the server answers 500 with an HTML page that reads like an
 * outage. The model names it without coordinates often, and so does the frugal
 * policy — its one override substitutes an action from `available_actions`,
 * which lists BARE names, so a veto could hand a coordinate-less ACTION6 to the
 * client after nine good clicks. That is how a game died 9 presses in.
 *
 * So the choice lives here, in one place both the policy and the client can
 * reach, and the client applies it as a last resort — every caller routes
 * through it, including callers not written yet.
 *
 * The docs say the game "does not provide explicit X/Y coordinates for active
 * areas", so a click has to be inferred from the grid by whoever is looking at
 * it. This is that inference, made once, in the open.
 */
import { parseSceneGraph } from "../research/perception/scene-graph.ts";

/** Dead centre, the fallback when there is nothing on the board to aim at. */
export function centreOf(grid: readonly (readonly number[])[]): { x: number; y: number } {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  return { x: Math.max(0, Math.floor(cols / 2)), y: Math.max(0, Math.floor(rows / 2)) };
}

/**
 * The centre of the largest non-background object, or null when the board has
 * nothing to aim at.
 *
 * Same reading `renderScene` puts in the prompt, so the click lands on
 * something the model was just shown rather than on a coordinate nobody has
 * seen. `x` is the column and `y` the row — the server's order, not the
 * array's, and the one place that is easy to get backwards.
 */
export function biggestObjectCentre(
  grid: readonly (readonly number[])[],
): { x: number; y: number } | null {
  try {
    const counts = new Map<number, number>();
    for (const row of grid) for (const cell of row) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    let background = 0;
    let seen = -1;
    for (const [colour, n] of counts) if (n > seen) ((seen = n), (background = colour));
    const scene = parseSceneGraph(grid.map((r) => [...r]), background);
    let best = null as null | { x: number; y: number; px: number };
    for (const o of scene.objects) {
      if (best && o.pixels.length <= best.px) continue;
      const b = o.boundingBox;
      best = {
        x: Math.min(63, Math.max(0, Math.floor(b.x + b.width / 2))),
        y: Math.min(63, Math.max(0, Math.floor(b.y + b.height / 2))),
        px: o.pixels.length,
      };
    }
    return best ? { x: best.x, y: best.y } : null;
  } catch {
    return null;
  }
}

/** `"ACTION6"` -> `"ACTION6:x,y"` against this grid; anything else untouched. */
export function withClickTarget(
  action: string,
  grid: readonly (readonly number[])[],
): string {
  if (action !== "ACTION6") return action;
  const point = biggestObjectCentre(grid) ?? centreOf(grid);
  return `ACTION6:${point.x},${point.y}`;
}
