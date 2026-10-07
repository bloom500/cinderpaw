/**
 * Learned ways (learning, beta): a reply the person marked 👍 teaches the
 * steps that produced it, and a later request like it gets those steps as a
 * hint.
 *
 * Until 6 Oct 2026 only a run with a `done_when` could teach anything
 * (core/run-receipt.ts): one procedure on the owner's machine in a month,
 * none on a stranger's. Ordinary chats are where the work happens, and the
 * thumbs under every reply were already being recorded (dispatch.ts
 * "feedback") and read by nothing that changes behaviour. The owner chose the
 * strict signal: only a 👍 teaches. An unrated finished task does not, because
 * nobody checked it.
 *
 * Visible both ways: the hint shows under the reply in Memory Peek as
 * "Learned way (beta)", and a way that earns two 👎 when it was used, more
 * 👎 than 👍, is retired and never offered again.
 *
 * Storage: append-only JSONL beside the skill library, last line per id wins,
 * torn lines skipped. Matching is word overlap, so it works on a fresh install
 * with no embedding model.
 */
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { cinderpawHome } from "../config.ts";

export interface LearnedWay {
  id: string;
  /** The request that earned the 👍, cut to 300 chars. Matched against. */
  request: string;
  /** Tool names in call order, consecutive repeats collapsed. */
  steps: string[];
  up: number;
  down: number;
  learnedAt: number;
  retired?: { at: number; reason: string };
}

interface Turn {
  sessionId: string;
  request: string;
  at: number;
  wayId: string | null;
  vote: "up" | "down" | null;
}

export function defaultLearnedWaysPath(): string {
  return path.join(cinderpawHome(), "agent", "skills", "learned-ways.jsonl");
}

/** Bookkeeping, not work: a way made of these teaches nothing. */
const NOT_A_STEP = new Set(["todo_write", "suggest_skill", "list_skills", "read_skill", "recall", "ask_user"]);
const MAX_STEPS = 12;
// ponytail: plain Jaccard over words of 3+ letters. Embeddings when a fresh
// install is guaranteed one; until then this is the matcher that always runs.
const MIN_SIMILARITY = 0.5;
const MIN_SHARED_WORDS = 2;
// ponytail: turns live in memory, so a 👍 given after the engine restarted
// teaches nothing. The thumbs are in-memory on the page too.
const MAX_TURNS = 200;

const words = (s: string): Set<string> =>
  new Set(
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  if (shared < MIN_SHARED_WORDS) return 0;
  return shared / (a.size + b.size - shared);
}

export class LearnedWays {
  #ways = new Map<string, LearnedWay>();
  #turns = new Map<string, Turn>();

  constructor(
    private readonly db: Database | null,
    private readonly file: string = defaultLearnedWaysPath(),
  ) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const w = JSON.parse(line) as LearnedWay;
        if (typeof w.id === "string" && Array.isArray(w.steps)) this.#ways.set(w.id, w);
      } catch {
        // torn line: skipped, never thrown
      }
    }
  }

  #save(w: LearnedWay): void {
    this.#ways.set(w.id, w);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(w) + "\n");
  }

  /** The live way closest to `request`, or null. */
  match(request: string): LearnedWay | null {
    const q = words(request);
    let best: LearnedWay | null = null;
    let bestScore = MIN_SIMILARITY;
    for (const w of this.#ways.values()) {
      if (w.retired) continue;
      const score = similarity(q, words(w.request));
      if (score >= bestScore) [best, bestScore] = [w, score];
    }
    return best;
  }

  /** A turn begins: remember what was asked, return the way to offer. */
  turnStarted(messageId: string, sessionId: string, request: string, now = Date.now()): LearnedWay | null {
    const way = this.match(request);
    this.#turns.set(messageId, { sessionId, request: request.slice(0, 300), at: now, wayId: way?.id ?? null, vote: null });
    if (this.#turns.size > MAX_TURNS) this.#turns.delete(this.#turns.keys().next().value!);
    return way;
  }

  /** The successful tools of a turn: from its start to the next turn of the same session. */
  #stepsOf(messageId: string, turn: Turn): string[] {
    if (!this.db) return [];
    let until = Number.MAX_SAFE_INTEGER;
    for (const [id, t] of this.#turns) if (id !== messageId && t.sessionId === turn.sessionId && t.at > turn.at) until = Math.min(until, t.at);
    try {
      const rows = this.db
        .query(
          `SELECT tool_name AS toolName FROM audit_log
           WHERE action_type = 'tool_call' AND result = 'success' AND session_id = ? AND timestamp >= ? AND timestamp < ?
           ORDER BY timestamp ASC`,
        )
        .all(turn.sessionId, turn.at, until) as Array<{ toolName: string | null }>;
      const steps: string[] = [];
      for (const r of rows) {
        if (!r.toolName || NOT_A_STEP.has(r.toolName) || steps.at(-1) === r.toolName) continue;
        steps.push(r.toolName);
      }
      return steps.slice(0, MAX_STEPS);
    } catch {
      return [];
    }
  }

  /**
   * A 👍 or 👎 on a reply. Returns what it changed, for the log.
   * A repeated vote on the same reply counts once.
   */
  feedback(messageId: string, value: "up" | "down", now = Date.now()): "learned" | "confirmed" | "retired" | "counted" | null {
    const turn = this.#turns.get(messageId);
    // The page sends the same vote again when a thumb is clicked off.
    if (!turn || turn.vote === value) return null;
    turn.vote = value;
    // A 👍 taken back as 👎 on the reply that taught a way takes the way back.
    const taught = this.#ways.get(messageId);
    if (taught && !taught.retired && value === "down") {
      this.#save({ ...taught, retired: { at: now, reason: "the thumbs up that taught it was changed to thumbs down" } });
      return "retired";
    }
    const used = turn.wayId ? this.#ways.get(turn.wayId) : undefined;
    if (used && !used.retired) {
      const next = { ...used, up: used.up + (value === "up" ? 1 : 0), down: used.down + (value === "down" ? 1 : 0) };
      if (next.down >= 2 && next.down > next.up) {
        this.#save({ ...next, retired: { at: now, reason: `${next.down} thumbs down after it was used` } });
        return "retired";
      }
      this.#save(next);
      return value === "up" ? "confirmed" : "counted";
    }
    if (value !== "up") return null;
    const steps = this.#stepsOf(messageId, turn);
    if (steps.length === 0) return null; // an answer with nothing done is not a way of doing
    this.#save({ id: messageId, request: turn.request, steps, up: 1, down: 0, learnedAt: now });
    return "learned";
  }

  list(): LearnedWay[] {
    return [...this.#ways.values()];
  }
}

/** What the model reads. Advice, never an order: the request may differ. */
export function learnedWayHint(w: LearnedWay): string {
  return (
    "## A way that worked before (the user marked it 👍)\n" +
    `For a similar request ("${w.request}"), these steps worked: ${w.steps.join(" → ")}. ` +
    "Follow them if they fit this request; if they do not, do what this request needs."
  );
}
