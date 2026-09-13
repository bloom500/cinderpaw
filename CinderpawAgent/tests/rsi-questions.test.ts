/**
 * Metacognition slice B: the proposer's bet about itself reaches the ledger,
 * and "I lack X" becomes a persistent question instead of a round.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_HASH, parsePrediction, proposeCodePatch, type ProposerDeps } from "../src/rsi/l3-code/code-proposer.ts";
import { SELECTOR_VERSION, type Attempt } from "../src/rsi/l3-code/experiment-selector.ts";
import { buildSelfModel } from "../src/rsi/l3-code/self-model.ts";
import { QuestionStore } from "../src/rsi/l3-code/questions.ts";

const SOURCE = "line1\nline2\nline3\n";
const EDIT = "<<<<<<< SEARCH\nline2\n=======\nline2-improved\n>>>>>>> REPLACE\n";

const deps = (reply: string, over: Partial<ProposerDeps> = {}): ProposerDeps => ({
  completeLocal: async () => reply,
  listRsiFiles: async () => ["l1-config/mutation.ts"],
  readRsiFile: async () => SOURCE,
  baseCommit: async () => "abc",
  rng: () => 0,
  ...over,
});

describe("parsePrediction", () => {
  test("reads the line, clamps the numbers, checks the vocabulary", () => {
    const p = parsePrediction(
      'RATIONALE: x\nPREDICTION: {"pAccept":1.7,"expectedEffect":-2,"expectedCost":500,"failureClass":"wrong_file","missing":null}\n',
    );
    expect(p).toEqual({
      pAccept: 1,
      expectedEffect: 0,
      expectedCost: 500,
      failureClass: "wrong_file",
      missing: null,
    });
  });

  test("an unknown failure class is dropped; a missing question implies missing_info", () => {
    expect(parsePrediction('PREDICTION: {"pAccept":0.4,"failureClass":"cosmic_rays"}')?.failureClass).toBeNull();
    const p = parsePrediction('PREDICTION: {"pAccept":0.4,"missing":"is the clamp intended?"}');
    expect(p?.failureClass).toBe("missing_info");
    expect(p?.missing).toBe("is the clamp intended?");
  });

  test("no line, or broken JSON, is no prediction", () => {
    expect(parsePrediction("RATIONALE: x\n" + EDIT)).toBeUndefined();
    expect(parsePrediction("PREDICTION: {not json}")).toBeUndefined();
  });
});

describe("proposeCodePatch with predictions", () => {
  test("the bet rides on the candidate", async () => {
    const g = await proposeCodePatch(
      deps('RATIONALE: tighten\nPREDICTION: {"pAccept":0.3,"expectedEffect":1,"expectedCost":800,"failureClass":"wrong_proposal","missing":null}\n' + EDIT),
    );
    expect(g?.proposal.prediction?.pAccept).toBe(0.3);
    expect(g?.proposal.rationale).toBe("tighten");
  });

  test("the receipt's initial state and method version ride on the candidate", async () => {
    const g = await proposeCodePatch(deps("RATIONALE: tighten\n" + EDIT));
    // sha256 of SOURCE as the proposer read it, not of the patched file.
    expect(g?.fileHash).toBe(
      require("node:crypto").createHash("sha256").update(SOURCE).digest("hex"),
    );
    expect(g?.baseCommit).toBe("abc");
    expect(g?.proposal.methodVersion).toEqual({ selector: SELECTOR_VERSION, promptHash: PROMPT_HASH });
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a row from before receipts and a full receipt both feed the self-model", () => {
    const legacy: Attempt = { file: "a.ts", rationale: "r", verdict: "reject", reason: "suite", ts: 1 };
    const full: Attempt = {
      ...legacy,
      ts: 2,
      verdict: "accept",
      reason: "ok",
      predicted: { pAccept: 0.6, expectedEffect: 1, expectedCost: 10, failureClass: null, missing: null },
      observed: { accepted: true, effect: 1, cost: 12, failureClass: null },
      initialState: { baseCommit: "abc", fileHash: "f".repeat(64) },
      methodVersion: { selector: SELECTOR_VERSION, promptHash: PROMPT_HASH },
    };
    const m = buildSelfModel([legacy, full]);
    expect(m.files.get("a.ts")?.observedAccept).toBe(0.5);
    expect(m.files.get("a.ts")?.n).toBe(1);
  });

  test("a candidate without a prediction still runs", async () => {
    const g = await proposeCodePatch(deps("RATIONALE: tighten\n" + EDIT));
    expect(g).not.toBeNull();
    expect(g?.proposal.prediction).toBeUndefined();
  });

  test('"missing" becomes a question and no candidate, even with edit blocks attached', async () => {
    const asked: unknown[] = [];
    const g = await proposeCodePatch(
      deps('RATIONALE: unsure\nPREDICTION: {"pAccept":0.2,"missing":"what is fitness for?"}\n' + EDIT, {
        onQuestion: (q) => asked.push(q),
      }),
    );
    expect(g).toBeNull();
    expect(asked).toEqual([{ file: "l1-config/mutation.ts", question: "what is fitness for?", rationale: "unsure" }]);
  });

  test("a file with an open question is not offered", async () => {
    let called = 0;
    const g = await proposeCodePatch(
      deps("RATIONALE: x\n" + EDIT, {
        blockedFiles: ["l1-config/mutation.ts"],
        completeLocal: async () => {
          called++;
          return "RATIONALE: x\n" + EDIT;
        },
      }),
    );
    expect(g).toBeNull();
    expect(called).toBe(0);
  });

  test("the user's answer is in the prompt, verbatim", async () => {
    let prompt = "";
    await proposeCodePatch(
      deps("SKIP", {
        answersFor: () => [{ question: "what is fitness for?", answer: "it ranks genomes; higher is better" }],
        completeLocal: async ({ user }) => {
          prompt = user;
          return "SKIP";
        },
      }),
    );
    expect(prompt).toContain('You asked: "what is fitness for?"');
    expect(prompt).toContain("it ranks genomes; higher is better");
  });
});

describe("QuestionStore", () => {
  const withStore = (fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-questions-"));
    try {
      fn(join(dir, "questions.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a question survives a restart and blocks its file until resolved", () => {
    withStore((path) => {
      const a = new QuestionStore(path);
      const q = a.ask({ file: "f.ts", question: "why?", rationale: "r" });
      expect(a.blockedFiles()).toEqual(["f.ts"]);
      // Same question twice is one question.
      expect(a.ask({ file: "f.ts", question: "why?", rationale: "r" }).id).toBe(q.id);

      const b = new QuestionStore(path);
      expect(b.list()).toHaveLength(1);
      expect(b.blockedFiles()).toEqual(["f.ts"]);

      b.resolve(q.id, "answer", "because");
      expect(b.blockedFiles()).toEqual([]);
      expect(b.answersFor("f.ts").map((x) => x.answer)).toEqual(["because"]);
      expect(JSON.parse(readFileSync(path, "utf8")).questions[0].status).toBe("answered");
    });
  });

  test("refuse and dismiss free the file and carry no answer; an empty answer is refused", () => {
    withStore((path) => {
      const s = new QuestionStore(path);
      const q1 = s.ask({ file: "a.ts", question: "1?", rationale: "r" });
      const q2 = s.ask({ file: "b.ts", question: "2?", rationale: "r" });
      s.resolve(q1.id, "refuse");
      s.resolve(q2.id, "dismiss");
      expect(s.blockedFiles()).toEqual([]);
      expect(s.answersFor("a.ts")).toEqual([]);
      expect(() => s.resolve(q1.id, "answer", "late")).toThrow(/not open/);
      const q3 = s.ask({ file: "c.ts", question: "3?", rationale: "r" });
      expect(() => s.resolve(q3.id, "answer", "   ")).toThrow(/needs text/);
    });
  });

  test("a corrupt file starts empty instead of crashing boot", () => {
    withStore((path) => {
      require("node:fs").writeFileSync(path, "{not json");
      expect(new QuestionStore(path).list()).toEqual([]);
    });
  });
});

describe("the round stops when there is nothing left to learn", () => {
  const settledRow = (file: string, accepted: boolean, ts: number): Attempt => ({
    file,
    rationale: "r",
    verdict: accepted ? "accept" : "reject",
    reason: accepted ? "ok" : "suite failed",
    ts,
    predicted: { pAccept: 0.5, expectedEffect: 0, expectedCost: 1, failureClass: null, missing: null },
    observed: { accepted, effect: accepted ? 0 : null, cost: 1, failureClass: null },
  });

  test("a settled pool means the model is not asked and the card is told", async () => {
    // Two files, both tried enough to trust, both with nothing to gain: one
    // always accepted at effect 0 (a settled win), one accepted once in
    // three at effect 0 (not struck out, but worth nothing).
    const rows = [
      ...[1, 2, 3, 4].map((t) => settledRow("l1-config/mutation.ts", true, t)),
      settledRow("l1-config/crossover.ts", false, 10),
      settledRow("l1-config/crossover.ts", true, 11),
      settledRow("l1-config/crossover.ts", false, 12),
    ];
    let called = 0;
    let settled: number | null = null;
    const g = await proposeCodePatch(
      deps("RATIONALE: x\n" + EDIT, {
        listRsiFiles: async () => ["l1-config/mutation.ts", "l1-config/crossover.ts"],
        attempts: rows,
        onNothingLeft: (n) => {
          settled = n;
        },
        completeLocal: async () => {
          called++;
          return "RATIONALE: x\n" + EDIT;
        },
      }),
    );
    expect(g).toBeNull();
    expect(called).toBe(0);
    expect(settled).toBe(2);
  });

  test("one under-sampled file keeps the round alive", async () => {
    const rows = [1, 2, 3, 4].map((t) => settledRow("l1-config/mutation.ts", true, t));
    let called = 0;
    await proposeCodePatch(
      deps("SKIP", {
        listRsiFiles: async () => ["l1-config/mutation.ts", "l1-config/crossover.ts"],
        attempts: rows,
        onNothingLeft: () => {
          throw new Error("must not fire: crossover.ts was never tried");
        },
        completeLocal: async () => {
          called++;
          return "SKIP";
        },
      }),
    );
    expect(called).toBe(1);
  });
});

describe("Astra's five decisions as the prediction vocabulary", () => {
  test("the three new classes parse", () => {
    for (const c of ["need_tool", "need_method", "over_mandate"]) {
      expect(parsePrediction(`PREDICTION: {"pAccept":0.5,"failureClass":"${c}"}`)?.failureClass).toBe(c);
    }
  });

  test("over_mandate is a budget question for the user, not a round", async () => {
    const asked: { file: string; question: string }[] = [];
    const g = await proposeCodePatch(
      deps(
        'RATIONALE: split the module\nPREDICTION: {"pAccept":0.6,"expectedEffect":3,"expectedCost":250000,"failureClass":"over_mandate","missing":null}\n' + EDIT,
        { onQuestion: (q) => asked.push(q), roundBudgetTokens: 100_000 },
      ),
    );
    expect(g).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toContain("~250000 tokens");
    expect(asked[0]!.question).toContain("100000-token round budget");
  });

  test("an expectedCost above the budget asks even without the class", async () => {
    const asked: unknown[] = [];
    const g = await proposeCodePatch(
      deps('RATIONALE: x\nPREDICTION: {"pAccept":0.6,"expectedCost":5000}\n' + EDIT, {
        onQuestion: (q) => asked.push(q),
        roundBudgetTokens: 4000,
      }),
    );
    expect(g).toBeNull();
    expect(asked).toHaveLength(1);
  });

  test("need_tool and need_method are recorded and the round still runs", async () => {
    const g = await proposeCodePatch(
      deps('RATIONALE: x\nPREDICTION: {"pAccept":0.3,"expectedCost":100,"failureClass":"need_tool"}\n' + EDIT),
    );
    expect(g?.proposal.prediction?.failureClass).toBe("need_tool");
  });
});
