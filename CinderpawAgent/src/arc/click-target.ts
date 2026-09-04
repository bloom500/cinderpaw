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
  const [best] = clickCandidates(grid, 1);
  return best ? { x: best.x, y: best.y } : null;
}

/** One thing on the board worth aiming at. */
export interface ClickCandidate {
  /** Column, 0..63. The server's order, not the array's. */
  x: number;
  /** Row, 0..63. */
  y: number;
  /**
   * The scene graph spells it `color`, and types it `string | number` because
   * it serves callers that name colours as well as ones that number them. ARC
   * only ever sends 0-15, so this is a number in practice — widened rather than
   * cast, because a cast here would be a lie the compiler stops checking.
   */
  colour: number | string;
  width: number;
  height: number;
  /** `parseSceneGraph`'s own classification, e.g. "line", "rectangle". */
  shape: string;
  /** Cells in the object. What "biggest" is measured in. */
  cells: number;
}

/**
 * The objects on the board, biggest first, as places a click could go.
 *
 * WHY THIS IS THE INTERESTING FUNCTION. Measured on the live API, GLM 5.3 Flash
 * spends 14-45 tokens choosing between named buttons and **27,000-31,000 tokens**
 * choosing an x,y — the same model, the same grid, one press apart. Both
 * `medium` and `low` reasoning effort did it, so the effort knob is not the
 * lever. What we hand the model for ACTION6 is a 64x64 space, 4,096 cells, and a
 * prompt line that says to work out which are clickable by itself. That is not a
 * question, it is a search, and it is being run in natural language.
 *
 * This is the same perception the click FALLBACK already uses — it is what
 * `biggestObjectCentre` was built on, now returning the whole list instead of
 * only the winner.
 *
 * IT GENERATES CANDIDATES, IT DOES NOT ANSWER. The distinction matters for what
 * the benchmark can claim afterwards. Handing the model our top pick would make
 * the score a measurement of `parseSceneGraph`, with the model reduced to a
 * rubber stamp; handing it a shortlist and letting it choose — including
 * choosing something not on the list — narrows the search without making the
 * decision. The prompt that renders this says so explicitly, for the same
 * reason.
 */
export function clickCandidates(
  grid: readonly (readonly number[])[],
  max = 8,
): ClickCandidate[] {
  try {
    const counts = new Map<number, number>();
    for (const row of grid) for (const cell of row) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    let background = 0;
    let seen = -1;
    for (const [colour, n] of counts) if (n > seen) ((seen = n), (background = colour));
    const scene = parseSceneGraph(grid.map((r) => [...r]), background);
    return scene.objects
      .map((o) => {
        const b = o.boundingBox;
        return {
          x: Math.min(63, Math.max(0, Math.floor(b.x + b.width / 2))),
          y: Math.min(63, Math.max(0, Math.floor(b.y + b.height / 2))),
          colour: o.color,
          width: b.width,
          height: b.height,
          shape: o.shapeCategory,
          cells: o.pixels.length,
        };
      })
      .sort((a, b) => b.cells - a.cells)
      .slice(0, max);
  } catch {
    // Perception failing is not a reason to lose the turn: the grid is still in
    // the prompt and the model can pick a coordinate from it, expensively.
    return [];
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
