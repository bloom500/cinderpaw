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
import { biggestObjectCentre, centreOf, clickCandidates } from "./click-target.ts";
import { colourChar } from "./colour.ts";

/**
 * The candidate block, or null when there is nothing to offer.
 *
 * WHY IT IS A SHORTLIST AND NOT AN ANSWER. Choosing between named buttons costs
 * this model 14-45 tokens. Choosing an x,y on the same grid cost it 27,163
 * (effort medium) and 31,557 (effort low) — the effort knob is not the lever,
 * and the 4,096-cell space is. So perception narrows the space. It must not
 * close it:
 *
 *   - the list says what perception FOUND, not what is clickable, because
 *     nobody knows what is clickable and the docs say the game will not tell us;
 *   - the model is told in the same breath that it may press any coordinate,
 *     including one not listed;
 *   - the raw grid stays in the prompt above it, so the list can be checked
 *     against the thing it claims to describe.
 *
 * Anything stronger and the score measures `parseSceneGraph` with the model as
 * a rubber stamp — which would be a better number and a worthless result.
 */
export function renderClickCandidates(
  grid: readonly (readonly number[])[],
  max = 8,
): string | null {
  const found = clickCandidates(grid, max);
  if (found.length === 0) return null;
  const lines = found.map(
    (c, i) =>
      `  ${i + 1}. centre (${c.x},${c.y}) — colour ${colourChar(c.colour)}, ${c.shape}, ` +
      `${c.width}x${c.height} box, ${c.cells} cells`,
  );
  return [
    "Objects perception found on this grid, biggest first (x is the column, y is the row):",
    ...lines,
    "These are objects, NOT a list of what is clickable — the game does not say what is.",
    "You may press any coordinate from 0 to 63, including one that is not listed.",
  ].join("\n");
}

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
  /**
   * How many past exchanges to carry as a real conversation — the model's own
   * previous answers, in the message list, the way the official reference agent
   * does it (`MESSAGE_LIMIT = 10`).
   *
   * ZERO BY DEFAULT, which is the single-turn prompt this policy has always
   * sent. That default is not timidity: turning this on changes what the model
   * is asked in a way that must be measured against the arm that does not have
   * it, and every existing caller — the app, the CLI, the tests — is entitled
   * to the behaviour it was written against.
   *
   * WHY IT MATTERS. Rebuilding the prompt from nothing every press means the
   * model re-derives what the buttons do every press, which is where the
   * completion tokens went: prompt tokens were flat at ~3,100 across a 32-press
   * run while completion tokens climbed past 11,000. It also means the prompt
   * prefix is never stable, so a gateway cache can never hit.
   */
  conversationTurns?: number;
  /**
   * A standing note from something that has looked at more than this turn — a
   * supervisor, a previous game's lessons. Placed above the grid, and marked as
   * advice rather than fact, because it is a reading of the game and the grid
   * is the ground truth.
   *
   * A function, not a string: it is read once per press, so whatever produces
   * it can change between presses without this policy knowing how.
   */
  strategy?: () => string | null;
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
  /**
   * Offer a shortlist of click targets when ACTION6 is available. `false` sends
   * the model the bare 64x64 grid, which is what it got before this existed and
   * what the measurement that motivated it was taken on — so the two are
   * comparable by running the same game twice.
   */
  clickCandidates?: boolean;
  /** A candidate list was rendered, for the run log. */
  onClickCandidates?: (text: string) => void;
  /**
   * The prompt carried what the last presses DID, rather than only their names.
   * Counted for the same reason as the two above: without it, a run that
   * silently lost the outcome feed — `--no-frugal`, a caller that drops the
   * field, a wrapper reordered — looks exactly like a run that has it, right up
   * until the completion-token bill arrives. This is the only place that
   * difference is visible from outside.
   */
  onOutcomes?: (lines: readonly string[]) => void;
}

const SYSTEM = [
  "You are playing an interactive grid game by pressing buttons.",
  "Each turn you see the current grid and the buttons that are available right now.",
  "Reply with exactly one button name and nothing else.",
  "A button that needs coordinates is written NAME:x,y with two integers from 0 to 63.",
  // SAY THE ENCODING OUT LOUD. Making every renderer agree (colour.ts) stops the
  // prompt contradicting itself; it does not tell the model what the characters
  // MEAN. One press was spent deriving "color 10 is 'a' in hex?" from first
  // principles and ran out of tokens before answering. One line is cheaper.
  "Colours are single hex digits: 0-9 then a-f, so colour ten is written a.",
  "Every colour you are shown — in the grid and in any description — uses that form.",
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

/** One cell, through the single colour renderer. See colour.ts. */
function cellChar(cell: number): string {
  return colourChar(cell);
}

/**
 * Pick the action the reply names.
 *
 * LAST match, not first: models routinely think out loud and mention several
 * buttons before committing, and the commitment is at the end. Only actions
 * the caller offered are considered, so a hallucinated button cannot be
 * chosen — `playLevel` would end the level on it.
 */
/**
 * The part of a reply that is an ANSWER, or null when there isn't one.
 *
 * THIS IS THE FIX FOR THE WORST BUG THIS HARNESS HAS HAD. A press cost 65,536
 * completion tokens — exactly 2^16, the output ceiling — and the reply ended
 * mid-sentence inside its own reasoning:
 *
 *     "...Wait colors list says 10x1805, 3x178, 14x147, 0x62, 9x6, 11x2, 15x2</think>"
 *
 * There was no answer. The model never decided anything; it ran out of room
 * while thinking. But `parseChoice` scanned the WHOLE reply for the last
 * mention of an offered action and found one — in the model's own notes, in the
 * phrase "ACTION3/4/6/7 correspond to operations like fill, erase". So the
 * harness pressed ACTION3, recorded `source: "model"`, and did not fire
 * `onUnparsed`. The run log said the model chose that button. It did not.
 *
 * That is measurement contamination, and it is worse than any cost problem: a
 * benchmark that spends too much can be optimised, a benchmark carrying
 * actions the model never decided is not a benchmark. Every published number
 * has to be defensible as "the model chose this", so the rule is semantic now
 * rather than textual — a decision must appear WHERE A DECISION GOES, not
 * anywhere in the transcript.
 *
 * The regions, and why each is drawn where it is:
 *
 *  - No `<think` at all: the whole reply is the answer. Plenty of models never
 *    emit one, and treating their entire reply as reasoning would reject every
 *    valid answer they give.
 *  - A closed `</think>`: everything after the LAST one. Providers fold
 *    `reasoning` back in as `<think>...</think>` (see inference-providers.ts),
 *    so the answer is what survives it.
 *  - An unterminated `<think`: null. This is truncation, and it is the exact
 *    65,536-token case. Everything present is thinking; the answer was never
 *    written.
 *  - Nothing but whitespace after `</think>`: null. A model that closed its
 *    thinking and then said nothing has not answered either.
 */
export function answerRegion(reply: string): string | null {
  if (typeof reply !== "string") return null;
  const opened = reply.indexOf("<think");
  if (opened === -1) return reply.trim() === "" ? null : reply;
  const closed = reply.lastIndexOf("</think>");
  // Closed before it opened means the tags are not a thinking block at all;
  // treat the reply as ordinary text rather than inventing a region.
  if (closed === -1 || closed < opened) return null;
  const after = reply.slice(closed + "</think>".length);
  return after.trim() === "" ? null : after;
}

/**
 * Pick the action the reply names — from the ANSWER only. See `answerRegion`:
 * a button named while thinking is not a decision, and treating it as one put
 * presses in a scorecard that no model ever chose.
 */
/**
 * The one action that takes a point. The server answers 500 for a bare one and
 * has no use for coordinates on any other button, so this is the environment's
 * rule rather than a preference of ours.
 */
export const CLICK_ACTION = "ACTION6";

export function parseChoice(reply: string, offered: readonly string[]): string | null {
  const answer = answerRegion(reply);
  if (answer === null) return null;
  let best: { index: number; action: string } | null = null;
  for (const action of offered) {
    // Coordinates may follow the name, so capture them when they are there.
    const pattern = new RegExp(`\\b${escapeRegExp(action)}\\b(?:\\s*[:\\s]\\s*(\\d{1,2})\\s*,\\s*(\\d{1,2}))?`, "gi");
    for (const match of answer.matchAll(pattern)) {
      const index = match.index ?? 0;
      // ONLY THE CLICK ACTION TAKES A POINT. Every other button is global, and
      // coordinates after its name are the model inventing syntax — measured
      // live on game bp35, with the model saying so out loud: "Selecting a
      // coordinate-targeted ACTION3 on the f cell to test clickability."
      //
      // Dropping them is not pedantry. `ACTION3:0,63` and `ACTION3` are
      // different strings, so the transition table, the inertness inference and
      // the outcome feedback treat them as different buttons and never learn
      // that the button does nothing — the same way a move counter drawn in the
      // grid made every state unique. One button must have one name.
      const chosen =
        action === CLICK_ACTION && match[1] !== undefined && match[2] !== undefined
          ? `${action}:${match[1]},${match[2]}`
          : action;
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
  // Hex, the same as the grid. See colour.ts: two encodings in one prompt is
  // what the 65,536-token press was mostly spent reconciling.
  const text = formatSceneGraphYaml(summary, colourChar);
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

export function createModelPolicy(options: ModelPolicyOptions): ArcPolicy {
  const {
    complete,
    historyLength = 8,
    onExchange,
    onUnparsed,
    scene,
    onScene,
    onCoordinateGuess,
    clickCandidates: offerCandidates = true,
    onClickCandidates,
    onOutcomes,
    conversationTurns = 0,
    strategy,
  } = options;

  /**
   * The rolling conversation, oldest first: what we asked, what it answered.
   * Empty when `conversationTurns` is 0, which is the default — every existing
   * caller keeps the single-turn prompt it has always sent.
   */
  const conversation: PolicyMessage[] = [];

  return async (observation: ArcObservation, ctx: PolicyContext): Promise<string | null> => {
    const offered = [...ctx.actions];
    // Nothing to choose from is not a decision this policy can make. playLevel
    // treats null as a voluntary stop, which is the honest answer here.
    if (offered.length === 0) return null;

    const recent = ctx.taken.slice(-historyLength);
    // What the presses DID, when the caller can tell us. A press with no
    // outcome beside it is indistinguishable from a press that did nothing, so
    // without this the model re-derives what every button does on every turn —
    // which is where the completion tokens went. Falls back to the bare list
    // when nothing is watching the grid across turns (`--no-frugal`).
    const outcomes = ctx.outcomes?.slice(-historyLength) ?? [];
    if (outcomes.length > 0) onOutcomes?.(outcomes);
    const history =
      outcomes.length > 0
        ? [`What your last presses did:`, ...outcomes.map((line) => `- ${line}`)].join("\n")
        : recent.length > 0
          ? `Your last presses: ${recent.join(", ")}`
          : "This is your first press.";
    // The description goes ABOVE the cells, and the cells stay. The summary is
    // a reading of the grid and can be wrong about what matters; the grid is
    // the ground truth and the model must always be able to check one against
    // the other.
    const described = scene === false ? null : renderScene(observation.grid, scene ?? {});
    if (described) onScene?.(described);
    // Only when ACTION6 is actually on the table. A shortlist of places to click
    // is noise in a turn where clicking is not offered, and prompt bytes are the
    // one cost that is paid on EVERY call.
    const candidates =
      offerCandidates && ctx.actions.includes(CLICK_ACTION)
        ? renderClickCandidates(observation.grid)
        : null;
    if (candidates) onClickCandidates?.(candidates);
    // Read once per press. Null and empty both mean "nothing to say", and
    // neither may put an empty heading in the prompt.
    const advice = strategy?.() ?? null;
    const turn: PolicyMessage = {
      role: "user",
      content: [
        ...(advice && advice.trim() !== ""
          ? ["What you worked out earlier (advice, not fact — the grid is the truth):", advice.trim(), ""]
          : []),
        ...(described ? ["What is on the grid, as objects:", described, ""] : []),
        renderGrid(observation.grid),
        "",
        ...(candidates ? [candidates, ""] : []),
        `Buttons available now: ${offered.join(", ")}`,
        `Presses remaining: ${Number.isFinite(ctx.remaining) ? ctx.remaining : "no limit"}`,
        history,
        "",
        "Which one button do you press? Answer with the name only.",
      ].join("\n"),
    };
    // The system prompt stays first and identical, so the prefix a gateway can
    // cache is the longest it can be. The conversation sits between it and the
    // turn, oldest first.
    const messages: PolicyMessage[] = [{ role: "system", content: SYSTEM }, ...conversation, turn];

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
    if (chosen === CLICK_ACTION) {
      const point = biggestObjectCentre(observation.grid) ?? centreOf(observation.grid);
      chosen = `${CLICK_ACTION}:${point.x},${point.y}`;
      onCoordinateGuess?.(chosen);
    }
    onExchange?.(messages, reply, chosen);

    // Carry the exchange forward — the model's OWN words, and a one-line stub
    // where its grid used to be.
    //
    // WHAT IS KEPT AND WHY. The mechanism worth having is the model seeing what
    // it already worked out, so it stops re-deriving the buttons from scratch.
    // The mechanism is in the ASSISTANT turns. Keeping the user turns verbatim
    // would re-send a 64x64 grid per remembered press — about 3,100 tokens each,
    // so eight turns is ~25,000 prompt tokens on every call, roughly twice what
    // a whole press costs today. The current grid is in the prompt already, and
    // it is the only one that is still true.
    //
    // ponytail: the stub keeps the turn count and drops the pixels. If a game
    // ever needs the model to compare two frames itself, keep the last ONE grid
    // rather than all of them.
    if (conversationTurns > 0) {
      conversation.push({ role: "user", content: `[grid ${observation.grid.length} rows] I pressed ${chosen}.` });
      conversation.push({ role: "assistant", content: reply });
      // Two messages per turn, and the pair must never be split: a conversation
      // starting on an assistant message is malformed for some gateways.
      while (conversation.length > conversationTurns * 2) conversation.splice(0, 2);
    }
    return chosen;
  };
}
