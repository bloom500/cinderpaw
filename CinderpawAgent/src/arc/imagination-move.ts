/**
 * What an action does on THIS benchmark: it moves one thing, and something in
 * a corner counts that it happened.
 *
 * The MCTS learner in `imagination.ts` searches for a whole-grid transform —
 * rotate, mirror, recolour — because that is the ARC-AGI-1/2 task. Measured on
 * a real ARC-AGI-3 game (ls20, 59 presses): the best programs it returned were
 * `rotate(rotate(g,270),90)`, the identity in two steps, with confidence 0.44 —
 * matching only the presses where nothing happened. `trustworthy` wants 1.0, so
 * no rule was ever trusted and the search changed no decision in any game.
 *
 * Two things had to be learned the hard way before this fitted, and both are
 * why it is written the way it is:
 *
 *  1. A translation of the WHOLE board does not fit. One press moved 52 cells —
 *     50 of them a sprite sliding five rows, 2 of them a counter at the bottom
 *     of the screen ticking over. The counter is a side effect to tolerate, not
 *     something to explain.
 *  2. There is no single background. The most common colour on that board is
 *     the frame (2,609 cells of colour 4); the sprite moves across a floor of
 *     colour 3. Anything reasoning from "the background" reads every real move
 *     as noise. So this reasons per colour: a colour that leaves as many cells
 *     as it arrives at, all at one offset, MOVED.
 *
 * WHAT IT IS FOR. Predicting that a press does NOTHING. 18 of those 59 presses
 * changed not one cell — the sprite was against something. The score is
 * (human presses / our presses) squared, so a press spent walking into a wall
 * is paid for twice, once in the press and once in the square. A prediction
 * never spends an action; it only demotes one.
 *
 * WHAT IT REFUSES TO DO. Guess. One offset must explain every press of that
 * action that moved anything, it must map every vacated cell onto an arrival of
 * the same colour, and presses that changed nothing count against the rule's
 * confidence rather than being quietly dropped.
 */
import type { Grid, TaskPair } from "../core/mcts-verifier.ts";

export interface MoveRule {
  action: string;
  dx: number;
  dy: number;
  /** The colours that move together — the sprite, as the board draws it. */
  colours: number[];
  /** What is left behind where the sprite was: the floor it walks on. */
  leaves: number;
  /** How many cells the sprite is, used to tell it from its own colours elsewhere. */
  size: number;
  /** Share of this action's presses the offset explains, 0..1. */
  confidence: number;
  pairsSeen: number;
  /** Presses where the board did not change at all — blocked, most likely. */
  blockedSeen: number;
}

const same = (a: Grid, b: Grid): boolean => {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y]!.length !== b[y]!.length) return false;
    for (let x = 0; x < a[y]!.length; x++) if (a[y]![x] !== b[y]![x]) return false;
  }
  return true;
};

const mode = (xs: number[]): number => {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0] ?? 0;
  let seen = -1;
  for (const [v, n] of counts) if (n > seen) ((seen = n), (best = v));
  return best;
};

/**
 * The offset the moving thing travelled between these two boards, the colours
 * it is made of, and what it left behind — or null when no single offset
 * explains the change.
 *
 * Per colour, not per board: for each colour, the cells that lost it and the
 * cells that gained it must be the same in number and related by one offset.
 * Colours that fail that test are the scoreboard ticking, and are tolerated up
 * to `noiseAllowance` so a counter in the corner cannot veto a correct reading
 * of the board.
 */
export function moveBetween(
  input: Grid,
  output: Grid,
  noiseAllowance = 0.25,
): { dx: number; dy: number; colours: number[]; leaves: number; size: number } | null {
  if (input.length !== output.length || input[0]?.length !== output[0]?.length) return null;

  const lost = new Map<number, { x: number; y: number }[]>();
  const gained = new Map<number, { x: number; y: number }[]>();
  let changed = 0;
  for (let y = 0; y < input.length; y++) {
    for (let x = 0; x < input[y]!.length; x++) {
      const a = input[y]![x]!;
      const b = output[y]![x]!;
      if (a === b) continue;
      changed++;
      (lost.get(a) ?? lost.set(a, []).get(a)!).push({ x, y });
      (gained.get(b) ?? gained.set(b, []).get(b)!).push({ x, y });
    }
  }
  if (changed === 0) return null;

  const mean = (ps: { x: number; y: number }[], k: "x" | "y") =>
    ps.reduce((s, p) => s + p[k], 0) / ps.length;

  // A colour moved when everything it vacated turns up again, at one offset.
  const moved: {
    colour: number;
    dx: number;
    dy: number;
    cells: { x: number; y: number }[];
    arrivals: { x: number; y: number }[];
  }[] = [];
  for (const [colour, from] of lost) {
    const to = gained.get(colour);
    if (!to || to.length !== from.length) continue;
    const dx = Math.round(mean(to, "x") - mean(from, "x"));
    const dy = Math.round(mean(to, "y") - mean(from, "y"));
    if (dx === 0 && dy === 0) continue;
    const arrived = new Set(to.map((p) => `${p.x},${p.y}`));
    if (from.some((p) => !arrived.has(`${p.x + dx},${p.y + dy}`))) continue;
    moved.push({ colour, dx, dy, cells: from, arrivals: to });
  }
  if (moved.length === 0) return null;

  // THE FLOOR IS NOT A THING THAT MOVES. Where the sprite left, floor appears;
  // where it landed, floor disappears — so the floor colour passes exactly the
  // same test the sprite does, at the opposite offset, and the reading collapses
  // into "two things moved different ways, no rule". On the game measured here a
  // counter happened to make the floor's counts unequal, which hid this bug
  // completely until a four-line test board showed it.
  //
  // The two are indistinguishable from one press alone: each one's arrivals are
  // the other's departures. What separates them is the board — the floor is the
  // big uniform region, the sprite is the small thing on it. So the most
  // abundant candidate is dropped, and only when there is another candidate to
  // prefer: a board where the only mover IS the commonest colour keeps it.
  if (moved.length > 1) {
    const abundance = new Map<number, number>();
    for (const row of input) for (const c of row) abundance.set(c, (abundance.get(c) ?? 0) + 1);
    // Two conditions, and both are needed. Complementary: this colour appears
    // exactly where another one left, which is what filling a hole looks like.
    // Abundant: of the two, it is the one the board is mostly made of. Dropping
    // on abundance alone tore the sprite in half when it is drawn in two
    // colours — measured: a rule that read perfectly became "no rule".
    const filler = moved.filter((m) => {
      const others = new Set(
        moved.filter((o) => o !== m).flatMap((o) => o.cells).map((p) => `${p.x},${p.y}`),
      );
      return m.arrivals.every((p) => others.has(`${p.x},${p.y}`));
    });
    // When every candidate looks like a filler they are describing each other —
    // the sprite's arrivals are the floor's departures and the reverse — and
    // only abundance breaks the tie.
    if (filler.length > 0) {
      const floor = filler.reduce((a, b) =>
        (abundance.get(a.colour) ?? 0) >= (abundance.get(b.colour) ?? 0) ? a : b,
      );
      const rest = moved.filter((m) => m !== floor);
      if (rest.length > 0) {
        moved.length = 0;
        moved.push(...rest);
      }
    }
  }
  const explained = moved.reduce((n, m) => n + m.cells.length + m.arrivals.length, 0);

  // One offset for the whole sprite. Colours that travelled differently are a
  // different thing moving, and a rule that averages two things is a rule about
  // neither.
  const { dx, dy } = moved[0]!;
  if (moved.some((m) => m.dx !== dx || m.dy !== dy)) return null;
  if (1 - explained / changed > noiseAllowance) return null;

  // What the board shows where the sprite used to be: the floor, read off the
  // cells it just vacated rather than assumed to be the commonest colour.
  const vacated = moved.flatMap((m) => m.cells).filter((p) => {
    const inside = p.y + dy >= 0 && p.y + dy < input.length && p.x + dx >= 0 && p.x + dx < input[0]!.length;
    return !inside || true;
  });
  const leaves = mode(vacated.map((p) => output[p.y]![p.x]!));

  return {
    dx,
    dy,
    colours: moved.map((m) => m.colour).sort((a, b) => a - b),
    leaves,
    // The whole sprite, not just the part that vacated: when it overlaps itself
    // the untouched middle is still the sprite, and the group we look for at
    // prediction time is the whole shape.
    size: spriteSize(input, moved.map((m) => m.colour), moved.flatMap((m) => m.cells)),
  };
}

/**
 * Move the sprite, if the square it wants is free.
 *
 * Returns the board UNCHANGED when the destination is off the edge or holds
 * something that is neither floor nor the sprite itself — that is the
 * prediction worth having, because such a press buys nothing.
 *
 * Returns NULL when the sprite cannot be picked out of the board at all. The
 * two must never collapse into one answer: "it cannot move" and "I do not know
 * what is moving" look identical to a caller comparing grids, and one of them
 * would talk the policy out of a press that works.
 */
export function applyMove(
  grid: Grid,
  rule: Pick<MoveRule, "dx" | "dy" | "colours" | "leaves" | "size">,
): Grid | null {
  // NOT every cell of those colours — the sprite's colours also appear
  // elsewhere on the board (a goal marker, a legend), and moving those too put
  // some part of the board against a wall on every single press, so the rule
  // predicted "nothing happens" 30 times out of 30. The sprite is the connected
  // group that is the size the move was learned from, and when two groups could
  // both be it, this says nothing rather than picking one.
  //
  // AMBIGUITY IS NOT A NO-OP. Returning the board unchanged here would tell the
  // policy "this press does nothing" with full confidence, which is the one
  // wrong answer that costs a level: it demotes a press that would have worked.
  // Not knowing which group is the sprite returns null — no belief — and the
  // policy goes back to reading the board itself.
  const groups = componentsOf(grid, rule.colours).filter((g) => g.length === rule.size);
  if (groups.length !== 1) return null;
  const cells = groups[0]!;

  const own = new Set(cells.map((p) => `${p.x},${p.y}`));
  for (const p of cells) {
    const nx = p.x + rule.dx;
    const ny = p.y + rule.dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[ny]!.length) return grid; // the edge
    if (own.has(`${nx},${ny}`)) continue; // its own tail
    if (grid[ny]![nx] !== rule.leaves) return grid; // something is in the way
  }
  const out = grid.map((row) => [...row]);
  for (const p of cells) out[p.y]![p.x] = rule.leaves;
  for (const p of cells) out[p.y + rule.dy]![p.x + rule.dx] = p.c;
  return out;
}

/**
 * One rule per action, from the presses that action has produced.
 *
 * A rule survives only if every press that moved something agrees on the same
 * offset and the same colours. Disagreement means the action is not a move
 * here — a menu, a spawn, something that depends on hidden state — and the
 * honest answer is no rule at all.
 */
export function learnMoveRules(
  history: readonly { action: string; pairs: readonly TaskPair[] }[],
): MoveRule[] {
  const rules: MoveRule[] = [];
  for (const entry of history) {
    if (!entry?.pairs?.length) continue;
    let found: { dx: number; dy: number; colours: number[]; leaves: number; size: number } | null = null;
    let agreed = 0;
    let blocked = 0;
    let contradicted = false;
    for (const pair of entry.pairs) {
      if (same(pair.input, pair.output)) {
        blocked++;
        continue;
      }
      const m = moveBetween(pair.input, pair.output);
      if (!m) {
        contradicted = true;
        break;
      }
      if (!found) {
        found = m;
        agreed++;
      } else if (
        m.dx === found.dx &&
        m.dy === found.dy &&
        String(m.colours) === String(found.colours)
      ) {
        agreed++;
      } else {
        contradicted = true;
        break;
      }
    }
    if (contradicted || !found) continue;
    // Blocked presses count in the denominator on purpose: a rule that has seen
    // the move fail more often than land does not understand this board yet,
    // and saying so costs less than acting on it.
    rules.push({
      action: entry.action,
      dx: found.dx,
      dy: found.dy,
      colours: found.colours,
      leaves: found.leaves,
      size: found.size,
      confidence: agreed / (agreed + blocked),
      pairsSeen: agreed + blocked,
      blockedSeen: blocked,
    });
  }
  return rules;
}

/**
 * Connected groups (4-neighbour) of cells whose colour is in `colours`.
 * The sprite is one of these; its colours appearing elsewhere are others.
 */
function componentsOf(grid: Grid, colours: readonly number[]): { x: number; y: number; c: number }[][] {
  const seen = new Set<string>();
  const out: { x: number; y: number; c: number }[][] = [];
  const inSet = (x: number, y: number) =>
    y >= 0 && y < grid.length && x >= 0 && x < grid[y]!.length && colours.includes(grid[y]![x]!);
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y]!.length; x++) {
      if (!inSet(x, y) || seen.has(`${x},${y}`)) continue;
      const group: { x: number; y: number; c: number }[] = [];
      const stack = [{ x, y }];
      seen.add(`${x},${y}`);
      while (stack.length > 0) {
        const p = stack.pop()!;
        group.push({ x: p.x, y: p.y, c: grid[p.y]![p.x]! });
        for (const [nx, ny] of [
          [p.x + 1, p.y],
          [p.x - 1, p.y],
          [p.x, p.y + 1],
          [p.x, p.y - 1],
        ] as const) {
          if (inSet(nx, ny) && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            stack.push({ x: nx, y: ny });
          }
        }
      }
      out.push(group);
    }
  }
  return out;
}

/** The size of the group the moved cells belong to, on the board before the move. */
function spriteSize(
  input: Grid,
  colours: readonly number[],
  movedCells: readonly { x: number; y: number }[],
): number {
  const keys = new Set(movedCells.map((p) => `${p.x},${p.y}`));
  for (const group of componentsOf(input, colours)) {
    if (group.some((p) => keys.has(`${p.x},${p.y}`))) return group.length;
  }
  return movedCells.length;
}

/** What this action would do to this board, or null when there is no rule. */
export function imagineMove(rules: readonly MoveRule[], action: string, grid: Grid): Grid | null {
  const rule = rules.find((r) => r.action === action);
  return rule ? applyMove(grid, rule) : null;
}
