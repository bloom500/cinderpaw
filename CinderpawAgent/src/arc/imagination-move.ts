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
  /** How many cells the sprite is. */
  size: number;
  /**
   * The sprite's exact shape: every cell as an offset from its top-left corner,
   * with its colour, sorted. This is what picks it out of a board where its
   * colours also appear elsewhere — matching by size alone found the wrong
   * group and called every press dead.
   */
  shape: string;
  /** Where the sprite's corner was after the last press we watched. */
  lastAt: { x: number; y: number };
  /**
   * What the sprite has been seen to move ONTO, and what has been seen to stop
   * it. Learned, not assumed: this board lets the sprite cross colour 5 freely,
   * and a model where only the floor is walkable called two thirds of its
   * working presses dead.
   */
  passable: number[];
  blocking: number[];
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
): {
  dx: number;
  dy: number;
  colours: number[];
  leaves: number;
  size: number;
  shape: string;
  lastAt: { x: number; y: number };
} | null {
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
    ...spriteOf(input, moved.map((m) => m.colour), moved.flatMap((m) => m.cells), dx, dy),
  };
}

/**
 * The whole sprite on the board before the press, and where it ended up.
 *
 * The changed cells are only the part that did not overlap itself — a shape
 * five tall moving four rows shows one row of change. The group those cells
 * belong to is the sprite, and its corner after the move is where to start
 * looking next time.
 */
function spriteOf(
  input: Grid,
  colours: readonly number[],
  movedCells: readonly { x: number; y: number }[],
  dx: number,
  dy: number,
): { size: number; shape: string; lastAt: { x: number; y: number } } {
  const keys = new Set(movedCells.map((p) => `${p.x},${p.y}`));
  const group =
    componentsOf(input, colours).find((g) => g.some((p) => keys.has(`${p.x},${p.y}`))) ??
    movedCells.map((p) => ({ ...p, c: input[p.y]![p.x]! }));
  const minX = Math.min(...group.map((p) => p.x));
  const minY = Math.min(...group.map((p) => p.y));
  return {
    size: group.length,
    shape: shapeKey(group),
    lastAt: { x: minX + dx, y: minY + dy },
  };
}

/** Where the sprite's top-left corner is on this board, or null. */
export function spritePosition(
  grid: Grid,
  rule: Pick<MoveRule, "colours" | "size" | "shape" | "lastAt">,
): { x: number; y: number } | null {
  const cells = spriteIn(grid, rule);
  if (cells === null) return null;
  return { x: Math.min(...cells.map((p) => p.x)), y: Math.min(...cells.map((p) => p.y)) };
}

/**
 * The sprite on this board, or null when it cannot be picked out.
 *
 * Shape and colours first — the sprite's colours also appear elsewhere, and
 * matching by size alone found the wrong group. When two identical shapes are
 * on the board, the one nearest to where it was last seen is it, and a tie
 * means silence rather than a coin flip.
 */
function spriteIn(
  grid: Grid,
  rule: Pick<MoveRule, "colours" | "size" | "shape" | "lastAt">,
): { x: number; y: number; c: number }[] | null {
  const groups = componentsOf(grid, rule.colours).filter(
    (g) => g.length === rule.size && shapeKey(g) === rule.shape,
  );
  if (groups.length === 0) return null;
  const corner = (g: { x: number; y: number }[]) => ({
    x: Math.min(...g.map((p) => p.x)),
    y: Math.min(...g.map((p) => p.y)),
  });
  const distance = (g: { x: number; y: number }[]) => {
    const c = corner(g);
    return Math.abs(c.x - rule.lastAt.x) + Math.abs(c.y - rule.lastAt.y);
  };
  const ranked = [...groups].sort((a, b) => distance(a) - distance(b));
  if (ranked.length > 1 && distance(ranked[0]!) === distance(ranked[1]!)) return null;
  return ranked[0]!;
}

/** A shape as text: cells relative to the top-left corner, with their colours. */
function shapeKey(cells: readonly { x: number; y: number; c: number }[]): string {
  const minX = Math.min(...cells.map((p) => p.x));
  const minY = Math.min(...cells.map((p) => p.y));
  return cells
    .map((p) => `${p.x - minX},${p.y - minY},${p.c}`)
    .sort()
    .join(" ");
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
  rule: Pick<
    MoveRule,
    "dx" | "dy" | "colours" | "leaves" | "size" | "shape" | "lastAt" | "passable" | "blocking"
  >,
): Grid | null {
  // AMBIGUITY IS NOT A NO-OP. Returning the board unchanged when the sprite
  // cannot be found would tell the policy "this press does nothing" with full
  // confidence, which is the one wrong answer that costs a level: it demotes a
  // press that would have worked. Not knowing returns null, and the policy goes
  // back to reading the board itself.
  const cells = spriteIn(grid, rule);
  if (cells === null) return null;

  const own = new Set(cells.map((p) => `${p.x},${p.y}`));
  const ahead: number[] = [];
  for (const p of cells) {
    const nx = p.x + rule.dx;
    const ny = p.y + rule.dy;
    // The edge stops everything, and needs no evidence to be believed.
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[ny]!.length) return grid;
    if (own.has(`${nx},${ny}`)) continue;
    ahead.push(grid[ny]![nx]!);
  }
  // Only what has been WATCHED stopping it counts as a wall. A colour never
  // seen ahead of this action is not a wall and not a floor — it is unknown,
  // and the honest answer is to say nothing rather than guess in either
  // direction. Assuming "not floor means wall" called two thirds of the
  // working presses dead on the game this was measured against.
  if (ahead.some((c) => rule.blocking.includes(c))) return grid;
  if (!ahead.every((c) => rule.passable.includes(c))) return null;

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
    let found: NonNullable<ReturnType<typeof moveBetween>> | null = null;
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
        // Keep the LATEST sighting: where the sprite is now is what the next
        // prediction has to start from, not where it was ten presses ago.
        found = { ...m };
        agreed++;
      } else {
        contradicted = true;
        break;
      }
    }
    if (contradicted || !found) continue;

    // WHAT STOPS IT, FROM EVIDENCE. Second pass, now that the offset and the
    // shape are known: for every press, find the sprite and look at the squares
    // it was trying to enter. A press that landed proves those colours are
    // walkable. A press that did nothing proves one of them is not — which one
    // is unknown, so nothing is condemned on a single sighting; a colour is
    // called blocking only once it has been in the way of a failure and never
    // under a success.
    const passable = new Set<number>();
    const suspect = new Map<number, number>();
    for (const pair of entry.pairs) {
      const cells = spriteIn(pair.input, found);
      if (!cells) continue;
      const own = new Set(cells.map((p) => `${p.x},${p.y}`));
      const ahead: number[] = [];
      let offBoard = false;
      for (const p of cells) {
        const nx = p.x + found.dx;
        const ny = p.y + found.dy;
        if (ny < 0 || ny >= pair.input.length || nx < 0 || nx >= pair.input[ny]!.length) {
          offBoard = true;
          break;
        }
        if (own.has(`${nx},${ny}`)) continue;
        ahead.push(pair.input[ny]![nx]!);
      }
      if (offBoard) continue; // the edge, which needs no colour to explain it
      // Did the SPRITE move? Not "did anything change" — a counter ticking in
      // the corner changes the board without the press having bought anything,
      // and treating that as a successful move taught the rule that walls are
      // walkable.
      const landed = spritePosition(pair.output, found);
      const started = { x: Math.min(...cells.map((p) => p.x)), y: Math.min(...cells.map((p) => p.y)) };
      const moved = landed !== null && (landed.x !== started.x || landed.y !== started.y);
      if (!moved) {
        // Once per PRESS, not once per cell: a sprite four cells wide facing a
        // wall indicts that colour four times over, and "twice before you call
        // it a wall" then means nothing.
        for (const c of new Set(ahead)) suspect.set(c, (suspect.get(c) ?? 0) + 1);
      } else for (const c of ahead) passable.add(c);
    }
    // Twice, not once. A failed press indicts every colour ahead of the sprite
    // and only one of them is the wall, so a single sighting convicts
    // bystanders — measured: one colour condemned on one failure produced the
    // only wrong "this press is dead" in ten games. Two independent failures
    // with the same colour ahead is cheap to wait for and much harder to get
    // by accident.
    const blocking = [...suspect].filter(([c, n]) => n >= 2 && !passable.has(c)).map(([c]) => c);
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
      shape: found.shape,
      lastAt: found.lastAt,
      passable: [...passable].sort((a, b) => a - b),
      blocking: blocking.sort((a, b) => a - b),
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

/** What this action would do to this board, or null when there is no rule. */
export function imagineMove(rules: readonly MoveRule[], action: string, grid: Grid): Grid | null {
  const rule = rules.find((r) => r.action === action);
  return rule ? applyMove(grid, rule) : null;
}
