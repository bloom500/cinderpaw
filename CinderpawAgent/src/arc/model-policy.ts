/**
 * The inner policy: a model looks at the grid and names one action.
 *
 * DELIBERATELY NOT AN ARC PROMPT. Darius's rule for this whole campaign is
 * that a change must be good for every user natively AND score well — not a
 * trick that only pays on one benchmark. So this prompt describes a SITUATION
 * (here is a grid, here is what you may press, here is what pressing costs)
 * and never the puzzle family, never a hint about ARC, never a worked example
 * of an ARC mechanic. Two consequences, both intended:
 *
 *   - Every improvement to the model's spatial reasoning shows up here, and
 *     every improvement here is a claim we can make about the agent rather
 *     than about our prompt engineering.
 *   - A score obtained this way means the AGENT is better. A score obtained
 *     from a bespoke ARC prompt would mean nothing outside ARC, which is the
 *     one thing we cannot publish.
 *
 * `complete` is injected rather than imported. This module makes no network
 * call, holds no key and knows no provider, so it is testable without one and
 * the benchmark runner decides what model answers.
 *
 * COST. One completion per action. That is the right trade on a benchmark that
 * scores `(human/ai)^2` and charges nothing for thinking — but it means the
 * frugal wrapper matters twice over, because every action it prevents is also
 * a completion nobody pays for.
 */

import type { ArcObservation } from "./environment.ts";
import type { ArcPolicy, PolicyContext } from "./play-level.ts";
import {
  formatSceneGraphYaml,
  parseSceneGraph,
} from "../research/perception/scene-graph.ts";

/** One turn of conversation, in the shape every provider in this repo takes. */
export interface PolicyMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelPolicyOptions {
  /** Runs one completion and returns the text. Injected: see the header. */
  complete: (messages: PolicyMessage[]) => Promise<string>;
  /**
   * How many past actions to show. Small on purpose — the grid is the state,
   * the history is only there so the model can tell it is repeating itself.
   */
  historyLength?: number;
  /** Every prompt and reply, for the run log. A bad score must be readable. */
  onExchange?: (prompt: PolicyMessage[], reply: string, chosen: string) => void;
  /**
   * Called when the reply named no available action and the fallback was used.
   * Worth counting: a high rate means the prompt or the model is wrong, and
   * without this it looks exactly like bad play.
   */
  onUnparsed?: (reply: string, fallback: string) => void;
  /**
   * Describe the grid as objects alongside the raw cells. `false` turns it off,
   * so the same game can be run twice and the difference attributed. Objects
   * are what the DSL and the MCTS rehearsal both reason in, and until now the
   * model was the only part of the stack that had to find them by eye.
   */
  scene?: SceneOptions | false;
  /** Called when a scene was rendered, for the run log: was perception used. */
  onScene?: (text: string) => void;
  /**
   * The model named ACTION6 without coordinates and we picked them. Counted
   * because a high rate means the prompt is not teaching the format, and
   * without it that looks identical to bad clicking.
   */
  onCoordinateGuess?: (action: string) => void;
}

const SYSTEM = [
  "You are playing an interactive grid game by pressing buttons.",
  "Each turn you see the current grid and the buttons that are available right now.",
  "Reply with exactly one button name and nothing else.",
  "A button that needs coordinates is written NAME:x,y with two integers from 0 to 63.",
  "The game does not tell you which squares are clickable - work it out from the grid.",
  "If ACTION7 is offered it undoes your last move, which makes trying something",
  "uncertain cheap to take back.",
  "",
  // Both halves, in this order, because the second one alone is what a model
  // optimises if you let it. Finishing the level is what the GAME score is made
  // of: an unfinished game is capped by the levels never reached, and those late
  // levels carry the most weight. Presses are the tiebreak between two ways of
  // finishing, never a reason to stop finishing.
  "Finishing the level is the goal. Never stop early to save presses: a level you",
  "do not finish forfeits every level after it, and those are worth the most.",
  "",
  "Between two presses that both make progress, prefer the cheaper one. A level's",
  "score is (a skilled human's presses / your presses) squared. Thinking is free; a",
  "press is not. Prefer the press that tells you the most or advances you the furthest.",
].join("\n");

/**
 * Grid as text.
 *
 * One hex digit per cell (the server's values are 0-15) with no separators: a
 * 64x64 grid is 4,159 characters instead of the 8,321 a JSON array of arrays
 * costs, and the rows stay visually aligned, which is the part
 * a model actually needs to see structure.
 */
export function renderGrid(grid: readonly (readonly number[])[]): string {
  if (!Array.isArray(grid) || grid.length === 0) return "(empty)";
  return grid
    .map((row) => (Array.isArray(row) ? row.map((cell) => cellChar(cell)).join("") : ""))
    .join("\n");
}

function cellChar(cell: number): string {
  return Number.isInteger(cell) && cell >= 0 && cell <= 15 ? cell.toString(16) : "?";
}

/**
 * Pick the action the reply names.
 *
 * LAST match, not first: models routinely think out loud and mention several
 * buttons before committing, and the commitment is at the end. Only actions
 * the caller offered are considered, so a hallucinated button cannot be
 * chosen — `playLevel` would end the level on it.
 */
export function parseChoice(reply: string, offered: readonly string[]): string | null {
  if (typeof reply !== "string") return null;
  let best: { index: number; action: string } | null = null;
  for (const action of offered) {
    // Coordinates may follow the name, so capture them when they are there.
    const pattern = new RegExp(`\\b${escapeRegExp(action)}\\b(?:\\s*[:\\s]\\s*(\\d{1,2})\\s*,\\s*(\\d{1,2}))?`, "gi");
    for (const match of reply.matchAll(pattern)) {
      const index = match.index ?? 0;
      const chosen =
        match[1] !== undefined && match[2] !== undefined ? `${action}:${match[1]},${match[2]}` : action;
      if (!best || index >= best.index) best = { index, action: chosen };
    }
  }
  return best?.action ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Caps that keep the scene summary a summary. */
export interface SceneOptions {
  /** Beyond this many non-background cells the grid is noise, not a scene. */
  maxCells?: number;
  /** Objects listed before the list is truncated. */
  maxObjects?: number;
  /** Relations listed. They are O(objects^2), so this is the one that bites. */
  maxRelations?: number;
}

const SCENE_DEFAULTS: Required<SceneOptions> = {
  // Measured, after the first cap was set by fear rather than by a stopwatch.
  // A real ARC frame (ls20) has 1,487 non-background cells and parses in 6ms;
  // the old 1,200 turned perception OFF for every game we were about to run.
  // The pathological case is cheap too: a scattered 64x64 grid is 819 objects
  // in 32ms. CPU was never the problem.
  maxCells: 3000,
  // The output is. That same scattered grid yields 346,205 relations, and even
  // the real frame yields 272 — which renders longer than the grid it
  // describes. These two caps bound the PROMPT, which is the cost that matters.
  maxObjects: 40,
  maxRelations: 60,
};

/**
 * The grid, described.
 *
 * The model was given 4,159 characters of hex and asked to find structure in
 * it. We already own the code that finds the structure — `parseSceneGraph`
 * returns connected components with bounding boxes, shape classes, symmetry and
 * spatial relations, and it is the same perception the DSL primitives are
 * written against. It costs no keypresses, so it is free against the score.
 *
 * Returns null when there is nothing worth saying, and that is the important
 * half:
 *
 * - Background is the MOST COMMON cell, not hard-coded 0. A game whose
 *   playfield is colour 8 would otherwise come back as one enormous object
 *   containing everything, which is worse than no description.
 * - A grid with more than `maxCells` non-background cells is skipped entirely.
 *   Not for CPU — measured, parsing costs 6ms on a real frame and 32ms on a
 *   pathological one — but because past that density the description stops
 *   being a summary of anything.
 * - Past `maxObjects` the list is truncated and relations are dropped, with the
 *   truncation stated. A summary that silently omits half the scene is worse
 *   than one that admits it.
 */
export function renderScene(
  grid: readonly (readonly number[])[],
  options: SceneOptions = {},
): string | null {
  const { maxCells, maxObjects, maxRelations } = { ...SCENE_DEFAULTS, ...options };
  if (!Array.isArray(grid) || grid.length === 0) return null;

  const counts = new Map<number, number>();
  let total = 0;
  for (const row of grid) {
    if (!Array.isArray(row)) return null;
    for (const cell of row) {
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return null;

  let background = 0;
  let seen = -1;
  for (const [colour, n] of counts) {
    if (n > seen) {
      seen = n;
      background = colour;
    }
  }
  // Everything one colour: there is no scene, and saying "1 object covering
  // everything" is noise the grid already told them.
  if (seen === total) return null;
  if (total - seen > maxCells) return null;

  let scene;
  try {
    scene = parseSceneGraph(
      grid.map((row) => [...row]),
      background,
    );
  } catch {
    // Perception failing is not a reason to lose the turn: the grid itself is
    // still in the prompt and the model can play from that alone.
    return null;
  }

  const truncated = scene.objects.length > maxObjects;
  const summary = {
    ...scene,
    objects: scene.objects.slice(0, maxObjects),
    // Relations between objects that are no longer listed describe nothing.
    relations: truncated ? [] : scene.relations.slice(0, maxRelations),
  };
  const text = formatSceneGraphYaml(summary);
  const notes: string[] = [];
  if (truncated) {
    notes.push(`${scene.objects.length} objects in total; the ${maxObjects} largest are listed`);
  } else if (scene.relations.length > summary.relations.length) {
    // Said out loud for the same reason the object count is: a list that stops
    // early without saying so reads as a complete description of the scene.
    notes.push(`${scene.relations.length} relations in total; ${summary.relations.length} listed`);
  }
  return notes.length > 0 ? `${text}
(${notes.join("; ")})` : text;
}

/** Dead centre, the fallback when there is nothing on the board to aim at. */
function centreOf(grid: readonly (readonly number[])[]): { x: number; y: number } {
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
function biggestObjectCentre(
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

export function createModelPolicy(options: ModelPolicyOptions): ArcPolicy {
  const { complete, historyLength = 8, onExchange, onUnparsed, scene, onScene, onCoordinateGuess } =
    options;

  return async (observation: ArcObservation, ctx: PolicyContext): Promise<string | null> => {
    const offered = [...ctx.actions];
    // Nothing to choose from is not a decision this policy can make. playLevel
    // treats null as a voluntary stop, which is the honest answer here.
    if (offered.length === 0) return null;

    const recent = ctx.taken.slice(-historyLength);
    // The description goes ABOVE the cells, and the cells stay. The summary is
    // a reading of the grid and can be wrong about what matters; the grid is
    // the ground truth and the model must always be able to check one against
    // the other.
    const described = scene === false ? null : renderScene(observation.grid, scene ?? {});
    if (described) onScene?.(described);
    const messages: PolicyMessage[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          ...(described ? ["What is on the grid, as objects:", described, ""] : []),
          renderGrid(observation.grid),
          "",
          `Buttons available now: ${offered.join(", ")}`,
          `Presses remaining: ${ctx.remaining}`,
          recent.length > 0 ? `Your last presses: ${recent.join(", ")}` : "This is your first press.",
          "",
          "Which one button do you press? Answer with the name only.",
        ].join("\n"),
      },
    ];

    const reply = await complete(messages);
    const parsed = parseChoice(reply, offered);
    // A reply naming no available button must still produce a press. Conceding
    // scores zero for the level, so an arbitrary offered action strictly beats
    // stopping — and `onUnparsed` makes the difference between "played badly"
    // and "never understood the question" visible in the log instead of buried
    // in the final number.
    let chosen = parsed ?? offered[0]!;
    if (parsed === null) onUnparsed?.(reply, chosen);
    // A bare ACTION6 is not a press, it is a malformed request: the server
    // needs x,y and answers 500 without them. Models name it without
    // coordinates often enough that refusing here would throw away the turn.
    //
    // So we choose the point ourselves, and perception is already holding the
    // only defensible answer — the middle of the biggest thing on the board.
    // The docs say the game "does not provide explicit X/Y coordinates for
    // active areas", so a click has to be inferred from the grid by whoever is
    // looking at it; this is that inference, made once, in the open.
    if (chosen === "ACTION6") {
      const point = biggestObjectCentre(observation.grid) ?? centreOf(observation.grid);
      chosen = `ACTION6:${point.x},${point.y}`;
      onCoordinateGuess?.(chosen);
    }
    onExchange?.(messages, reply, chosen);
    return chosen;
  };
}
