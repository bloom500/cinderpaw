/**
 * Questions the improvement loop asks the user, and what came back.
 *
 * A proposer that says "I lack X" (`Prediction.missing`) used to have no
 * place to say it: the round ran anyway and the ledger recorded a refusal
 * that looked like a bad idea. Now the round does not run. The question
 * lands here, persistent, and shows in the Dreams panel until the user
 * answers it, refuses it, or dismisses it with the X. The file it is about
 * is out of M0's pool while the question is open, because trying it again
 * without the answer is the same waste.
 *
 * An answer is evidence for the next round on that file: the proposer's
 * prompt carries it verbatim. A refusal or a dismissal frees the file and
 * carries nothing.
 *
 * Same store discipline as `pending-patches.ts`: a small versioned JSON
 * file, atomic writes, corrupt-or-missing means empty. Idempotent per
 * (file, question) so a proposer that asks the same thing twice does not
 * fill the panel twice.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { paths } from "../infra/instance-paths.ts";

export type QuestionStatus = "open" | "answered" | "refused" | "dismissed";

export interface Question {
  id: string;
  /** rsi/-relative file the proposer was looking at. */
  file: string;
  /** What it says it needs to know. */
  question: string;
  /** Its one-line reason for wanting it. */
  rationale: string;
  status: QuestionStatus;
  askedAt: number;
  resolvedAt?: number;
  /** The user's text, when `status` is "answered". */
  answer?: string;
}

export function defaultQuestionsPath(): string {
  return join(paths().root, "questions.json");
}

interface Envelope {
  version: 1;
  questions: Question[];
}

export class QuestionStore {
  #questions: Question[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Envelope;
      if (parsed?.version === 1 && Array.isArray(parsed.questions)) {
        this.#questions = parsed.questions;
      }
    } catch {
      // Missing / corrupt / wrong version: start empty.
    }
  }

  #save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const envelope: Envelope = { version: 1, questions: this.#questions };
    atomicWriteFileSync(this.file, JSON.stringify(envelope, null, 2));
  }

  /** Raise a question. Returns the existing one when the same question is
   *  already open on the same file. */
  ask(args: { file: string; question: string; rationale: string }): Question {
    const dup = this.#questions.find(
      (q) => q.status === "open" && q.file === args.file && q.question === args.question,
    );
    if (dup) return structuredClone(dup);
    const q: Question = {
      id: crypto.randomUUID(),
      file: args.file,
      question: args.question,
      rationale: args.rationale,
      status: "open",
      askedAt: Date.now(),
    };
    this.#questions.push(q);
    this.#save();
    return structuredClone(q);
  }

  list(): Question[] {
    return structuredClone(this.#questions);
  }

  /** Files that must not be tried while a question about them is open. */
  blockedFiles(): string[] {
    return [...new Set(this.#questions.filter((q) => q.status === "open").map((q) => q.file))];
  }

  /** Answers on a file, oldest first: what the proposer gets to read. */
  answersFor(file: string): Question[] {
    return this.#questions
      .filter((q) => q.status === "answered" && q.file === file)
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
      .map((q) => structuredClone(q));
  }

  /** open -> answered / refused / dismissed. Anything else is a caller bug. */
  resolve(id: string, action: "answer" | "refuse" | "dismiss", answer?: string): Question {
    const q = this.#questions.find((x) => x.id === id);
    if (!q) throw new Error(`question '${id}' not found`);
    if (q.status !== "open") throw new Error(`question '${id}' is ${q.status}, not open`);
    if (action === "answer") {
      const text = (answer ?? "").trim();
      if (!text) throw new Error(`question '${id}': an answer needs text`);
      q.answer = text;
      q.status = "answered";
    } else {
      q.status = action === "refuse" ? "refused" : "dismissed";
    }
    q.resolvedAt = Date.now();
    this.#save();
    return structuredClone(q);
  }
}
