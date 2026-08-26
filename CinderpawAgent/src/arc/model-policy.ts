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
}

const SYSTEM = [
  "You are playing an interactive grid game by pressing buttons.",
  "Each turn you see the current grid and the buttons that are available right now.",
  "Reply with exactly one button name and nothing else.",
  "A button that needs coordinates is written NAME:x,y with two integers from 0 to 63.",
  "",
  "Pressing a button is the only thing that costs anything, and the score is",
  "(a skilled human's presses / your presses) squared. Thinking is free; a press",
  "is not. Prefer the press that tells you the most or advances you the furthest.",
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

export function createModelPolicy(options: ModelPolicyOptions): ArcPolicy {
  const { complete, historyLength = 8, onExchange, onUnparsed } = options;

  return async (observation: ArcObservation, ctx: PolicyContext): Promise<string | null> => {
    const offered = [...ctx.actions];
    // Nothing to choose from is not a decision this policy can make. playLevel
    // treats null as a voluntary stop, which is the honest answer here.
    if (offered.length === 0) return null;

    const recent = ctx.taken.slice(-historyLength);
    const messages: PolicyMessage[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
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
    const chosen = parsed ?? offered[0]!;
    if (parsed === null) onUnparsed?.(reply, chosen);
    onExchange?.(messages, reply, chosen);
    return chosen;
  };
}
