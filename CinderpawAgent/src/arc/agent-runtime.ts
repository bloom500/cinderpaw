/**
 * agent-runtime.ts — the Cinderpaw agent stack, wired into the ARC bench.
 *
 * This is the `--arm agent` arm. It is deliberately NOT `boot()`: booting
 * brings transport, cron, tools and connectors the bench does not need, and it
 * buries model calls where `complete.usage()` cannot see them. The whole reason
 * the ARC trace is worth reading is that every model call is counted, so the
 * primitives are wired one at a time instead, each taking its dependencies by
 * injection — which is what they were already built for.
 *
 * WHAT IS HERE
 *
 *  - A SUPERVISOR. Every N presses, a second model call reads what the presses
 *    actually did and writes one short strategy note, which the press policy is
 *    handed as advice. It runs on the real `CoworkWorkerLoop`: the player posts
 *    to the supervisor's mailbox, the loop drains it, the handler answers. Not
 *    a reimplementation — the same mailbox, the same statuses, the same events.
 *  - LESSONS ACROSS GAMES. What the presses proved about the buttons, carried
 *    out of one game and into the next. This is the cheap half of memory: it
 *    costs no model call, because the frugal policy already measured it.
 *  - A LEVEL BOUNDARY. `environment_boundary` — the moment a level clears is
 *    the only quiet point in a run that never goes idle, and it is where a
 *    consolidation pass belongs.
 *
 * ACCOUNTING. The supervisor spends money, so it is counted separately and
 * loudly. The run's invariant used to be `model calls == actions`; with a
 * supervisor it becomes `policy calls == actions` and `supervisor calls` is its
 * own number. `stats()` reports both so the two can be added back up and
 * checked against `complete.usage().calls`. An arm that quietly spent extra
 * calls inside the same counter would make the cost per action a fiction.
 */
import type { Database } from "bun:sqlite";

import { CoworkMailboxRepo } from "../cowork/mailbox.ts";
import { CoworkHandoffService } from "../cowork/handoff.ts";
import { CoworkWorkerLoop } from "../cowork/worker-loop.ts";
import type { PolicyMessage } from "./model-policy.ts";

/** The player and the supervisor, as cowork agents. Ids, not names. */
const PLAYER = "arc-player";
const SUPERVISOR = "arc-supervisor";

const SUPERVISOR_SYSTEM = [
  "You are watching someone play a game one button at a time. You cannot press anything.",
  "You are given what they pressed and whether the board actually moved.",
  "",
  "Answer in at most four short sentences, as instructions to the player:",
  "which buttons appear to do nothing, which appear to do something, and what to try next.",
  "Say only what the record supports. If it supports nothing yet, say so in one sentence.",
].join("\n");

export interface ArcAgentRuntimeOptions {
  /** The SAME completer the policy uses, so one usage counter sees every call. */
  complete: (messages: PolicyMessage[]) => Promise<string>;
  /** A database with the cowork tables. `openDatabase(":memory:").raw` is enough. */
  db: Database;
  /**
   * Presses between supervisor reviews. Every review is a paid model call, so
   * this is the cost knob: at 12 it adds roughly 8% to a game's calls.
   */
  reviewEvery?: number;
  /** What earlier games proved. Shown to the supervisor, never invented here. */
  priorLessons?: readonly string[];
  /** Told when a review lands, for the run log. */
  onReview?: (note: string, atPress: number) => void;
  /** Told when a review fails. A supervisor that cannot answer must not stop play. */
  onReviewFailed?: (reason: string, atPress: number) => void;
  /** Told when a level boundary is consolidated. */
  onBoundary?: (trigger: "environment_boundary", levelsCompleted: number) => void;
}

export interface ArcAgentRuntime {
  /** Hand to `createModelPolicy({ strategy })`. The standing note, or null. */
  strategy: () => string | null;
  /** Hand to `createFrugalPolicy({ onOutcome })`. Drives the review cadence. */
  onOutcome: (info: { action: string; changed: boolean; presses: number }) => void;
  /** Run any review the presses have earned. Awaited between presses. */
  tick: () => Promise<void>;
  /** A level cleared: the one quiet point in a run that never goes idle. */
  levelBoundary: (levelsCompleted: number) => Promise<void>;
  /** What this game proved, for the next one. Plain sentences, no model call. */
  lessons: () => string[];
  stats: () => {
    supervisorCalls: number;
    supervisorFailures: number;
    reviews: number;
    boundaries: number;
    pressesSeen: number;
  };
}

export function createArcAgentRuntime(options: ArcAgentRuntimeOptions): ArcAgentRuntime {
  const { complete, db, reviewEvery = 12, priorLessons = [], onReview, onReviewFailed, onBoundary } = options;
  if (!Number.isInteger(reviewEvery) || reviewEvery < 1) {
    throw new Error(`createArcAgentRuntime: reviewEvery must be an integer >= 1, got ${String(reviewEvery)}`);
  }

  const mailbox = new CoworkMailboxRepo(db);
  const handoffs = new CoworkHandoffService(db);

  /** Every press this game, oldest first: what was pressed and whether it mattered. */
  const record: { action: string; changed: boolean }[] = [];
  let note: string | null = null;
  let pressesSeen = 0;
  let dueAt = reviewEvery;
  let supervisorCalls = 0;
  let supervisorFailures = 0;
  let reviews = 0;
  let boundaries = 0;

  /**
   * What the record proves about each button, in the order it was first seen.
   * Derived, never remembered: recomputing from the record cannot drift from
   * it, and the record is the only thing that was actually measured.
   */
  const buttonFacts = (): string[] => {
    const kinds = new Map<string, { moved: number; inert: number }>();
    for (const { action, changed } of record) {
      // ACTION6:21,3 and ACTION6:40,9 are the same button at different places.
      // Rolling them up is the only way a count reaches a size worth reading.
      const kind = action.split(":")[0]!;
      const tally = kinds.get(kind) ?? { moved: 0, inert: 0 };
      changed ? tally.moved++ : tally.inert++;
      kinds.set(kind, tally);
    }
    const facts: string[] = [];
    for (const [kind, { moved, inert }] of kinds) {
      const tried = moved + inert;
      if (moved === 0) facts.push(`${kind} did nothing in all ${tried} presses.`);
      else if (inert === 0) facts.push(`${kind} changed the board in all ${tried} presses.`);
      else facts.push(`${kind} changed the board in ${moved} of ${tried} presses.`);
    }
    return facts;
  };

  /** The supervisor's turn. One model call. Never throws at the caller. */
  async function review(): Promise<void> {
    const facts = buttonFacts();
    const recent = record.slice(-reviewEvery).map((r) => `- ${r.action} -> ${r.changed ? "board moved" : "nothing"}`);
    const messages: PolicyMessage[] = [
      { role: "system", content: SUPERVISOR_SYSTEM },
      {
        role: "user",
        content: [
          ...(priorLessons.length > 0 ? ["What earlier games showed:", ...priorLessons.map((l) => `- ${l}`), ""] : []),
          `After ${pressesSeen} presses:`,
          ...facts.map((f) => `- ${f}`),
          "",
          "The last few presses, in order:",
          ...recent,
          "",
          "What should the player do next?",
        ].join("\n"),
      },
    ];
    supervisorCalls++;
    const reply = await complete(messages);
    const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // A reply that is only reasoning, or empty, is not advice. Keeping the old
    // note beats replacing good advice with a blank heading.
    if (text === "") throw new Error("the supervisor answered with nothing usable");
    note = text;
    reviews++;
    onReview?.(text, pressesSeen);
  }

  // The real cowork loop, with one worker. `onHandoff` is never exercised here
  // — there is no second worker to hand to — but the loop requires it, and a
  // handler that lies about succeeding would corrupt the handoff table if one
  // ever arrived.
  const loop = new CoworkWorkerLoop(
    {
      mailbox,
      handoffs,
      onMessage: async () => {
        try {
          await review();
          return { ok: true, output: note ?? "" };
        } catch (err) {
          supervisorFailures++;
          const reason = err instanceof Error ? err.message : String(err);
          onReviewFailed?.(reason, pressesSeen);
          // Rejected, not thrown: a supervisor that cannot answer is a worse
          // prompt, never a lost game. The message is marked rejected by the
          // loop and the run carries on with whatever note it already had.
          return { ok: false, output: reason };
        }
      },
      onHandoff: async () => ({ ok: false, output: "the ARC supervisor accepts no handoffs" }),
      nameOf: (id) => (id === SUPERVISOR ? "Supervisor" : "Player"),
    },
    // The bench has no transport. Events are dropped here rather than being
    // made optional in the loop — that is the app's seam, not ours to widen.
    () => {},
  );

  return {
    strategy: () => note,

    onOutcome: ({ action, changed, presses }) => {
      record.push({ action, changed });
      pressesSeen = presses;
    },

    async tick() {
      if (pressesSeen < dueAt) return;
      dueAt = pressesSeen + reviewEvery;
      mailbox.send({
        fromAgentId: PLAYER,
        toAgentId: SUPERVISOR,
        threadId: `arc-review-${pressesSeen}`,
        body: `review after ${pressesSeen} presses`,
      });
      await loop.tick(SUPERVISOR);
    },

    async levelBoundary(levelsCompleted) {
      boundaries++;
      onBoundary?.("environment_boundary", levelsCompleted);
      // A cleared level is the strongest evidence a run produces, and the next
      // level starts from a board the note was never about. Force a review
      // rather than waiting for the cadence to come round.
      dueAt = pressesSeen;
      await this.tick();
    },

    lessons: () => buttonFacts(),

    stats: () => ({ supervisorCalls, supervisorFailures, reviews, boundaries, pressesSeen }),
  };
}
