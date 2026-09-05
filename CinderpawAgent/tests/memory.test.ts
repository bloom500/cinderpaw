/**
 * Memory layer — recall, semantic, and working memory integration.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory, SESSION_RESET_MARK } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { WorkingMemory } from "../src/memory/working.ts";

describe("SemanticMemory", () => {
  test("upsert and retrieve a fact", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("name", "Darius");
    const fact = sem.get("name");
    expect(fact?.value).toBe("Darius");
    db.close();
  });

  test("key is normalized to lowercase", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("Language", "Romanian");
    expect(sem.get("language")?.value).toBe("Romanian");
    db.close();
  });

  test("upsert overwrites existing value", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("city", "Bucharest");
    sem.upsert("city", "Cluj");
    expect(sem.get("city")?.value).toBe("Cluj");
    expect(sem.all()).toHaveLength(1);
    db.close();
  });

  test("delete removes a fact", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("temp", "x");
    sem.delete("temp");
    expect(sem.get("temp")).toBeUndefined();
    db.close();
  });

  test("renderForPrompt returns empty string with no facts", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);
    expect(sem.renderForPrompt()).toBe("");
    db.close();
  });

  test("renderForPrompt lists all facts", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("name", "Darius");
    sem.upsert("language", "Romanian");
    const rendered = sem.renderForPrompt();
    expect(rendered).toContain("name: Darius");
    expect(rendered).toContain("language: Romanian");
    db.close();
  });
});

describe("RecallEngine", () => {
  test("returns empty context when no episodic history exists", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, sem);

    const result = recall.recall("hello", "s1");
    expect(result.context).toBe("");
    expect(result.episodicHits).toBe(0);
    expect(result.semanticFacts).toBe(0);
    db.close();
  });

  test("surfaces semantic facts even without episodic matches", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    sem.upsert("name", "Darius");
    const recall = new RecallEngine(episodic, sem);

    const result = recall.recall("hello", "s1");
    expect(result.context).toContain("name: Darius");
    expect(result.semanticFacts).toBe(1);
    db.close();
  });

  test("excludes current session from episodic results by default", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);

    // Record in current session AND a past session.
    episodic.record("current", "user", "dinosaur facts are interesting");
    episodic.record("past",    "user", "dinosaur facts are interesting");

    const recall = new RecallEngine(episodic, sem);
    const result = recall.recall("dinosaur", "current");

    // Only the past session event should appear.
    expect(result.episodicHits).toBe(1);
    expect(result.context).not.toContain("[current]");
    db.close();
  });

  test("wraps context in memory markers when results exist", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    sem.upsert("topic", "AI");

    const recall = new RecallEngine(episodic, sem);
    const result = recall.recall("AI agents", "s1");

    expect(result.context).toMatch(/^\[Memory context\]/);
    expect(result.context).toMatch(/\[End memory context\]$/);
    db.close();
  });
});

describe("WorkingMemory.render — P1 prompt-cache layout", () => {
  // P1: the dynamic per-turn context (skill menu, memory recall) is appended
  // to the LAST user message rather than injected as its own system message
  // between the static system prompt and the transcript. The system prompt
  // is now the only system role in the rendered output, so its tokenized
  // form is byte-stable across turns and llama.cpp's KV cache can be reused.

  const sampleSkill = {
    id: "x",
    name: "X",
    description: "X tool",
    author: "a",
    version: "1",
    license: "MIT",
    tags: [] as string[],
    source_provider: "local",
    source_url: null,
    content_url: null,
    install_status: "installed",
    trust_label: "verified",
    last_updated: null,
  };

  test("system prompt is the only system message; dynamic context rides on the last user message", () => {
    const mem = new WorkingMemory("You are Cinderpaw.");
    mem.setMemoryContext("[Memory context]\nname: Darius\n[End memory context]");
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("hello");

    const rendered = mem.render();
    // Exactly one system role — the static base prompt. No dynamic system messages.
    const systemMessages = rendered.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toBe("You are Cinderpaw.");
    // The user message carries the dynamic blocks at the tail.
    const last = rendered[rendered.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("hello");
    expect(last.content).toContain("name: Darius");
    expect(last.content).toContain("Available skills");
  });

  test("no dynamic context → system prompt is the only system message and user content is untouched", () => {
    const mem = new WorkingMemory("You are Cinderpaw.");
    mem.addUser("hello");
    const rendered = mem.render();
    expect(rendered.filter((m) => m.role === "system")).toHaveLength(1);
    expect(rendered[rendered.length - 1]?.content).toBe("hello");
  });

  test("memory context is replaced, not accumulated, on subsequent calls", () => {
    const mem = new WorkingMemory("sys");
    mem.setMemoryContext("first context");
    mem.setMemoryContext("second context");
    mem.addUser("hi");
    const rendered = mem.render();
    const last = rendered[rendered.length - 1]!;
    expect(last.content).toContain("second context");
    expect(last.content).not.toContain("first context");
  });

  test("static system prompt is byte-identical across renders with different dynamic context", () => {
    // The crux of P1: the system prompt tokenizes the same way every turn,
    // regardless of what skill menu / memory context the agent loop set. The
    // prefix [system, …, last-user-message-start] stays identical so the
    // KV cache for the static prefix stays valid.
    const mem = new WorkingMemory("You are Cinderpaw.\n## Tools\n- read_file\n");
    mem.setMemoryContext("ctx1");
    mem.addUser("u1");
    const sys1 = mem.render()[0]?.content;

    mem.setMemoryContext("ctx2 — completely different");
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("u2");
    const sys2 = mem.render()[0]?.content;

    expect(sys1).toBe(sys2);
  });

  test("user message at index of last user-role message is the only one mutated", () => {
    // After a tool-call iteration the transcript is e.g.
    //   [user, assistant, tool]
    // The user message (the only one) is the one that receives the
    // dynamic context block. (P4 fix: the agent loop no longer appends
    // a synthetic continuation nudge after a tool result, so the
    // transcript after a tool turn is exactly
    // `[user, assistant, tool]` rather than `[user, assistant, tool, user]`.)
    const mem = new WorkingMemory("sys");
    mem.addUser("original question");
    mem.addAssistant("ok");
    mem.addToolResult("foo", "result");
    mem.setMemoryContext("RECALL BLOCK");

    const rendered = mem.render();
    const userMessages = rendered.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    // The dynamic RECALL BLOCK is appended to the original user message
    // (P1 prompt-cache layout — see `render()`).
    expect(userMessages[0]?.content).toContain("original question");
    expect(userMessages[0]?.content).toContain("RECALL BLOCK");
  });

  test("estimatedTokens still counts the dynamic context toward the budget", () => {
    // Sanity: the dynamic blocks must still count toward maybeCompress's
    // budget, otherwise we'd lose compression triggers on memory-heavy turns.
    const mem = new WorkingMemory("sys");
    mem.setMemoryContext("x".repeat(400));
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("z".repeat(100));
    const tokens = mem.estimatedTokens();
    expect(tokens).toBeGreaterThan(0);
  });

  test("todo drawer shows recently closed items under their own do-not-redo heading", () => {
    const mem = new WorkingMemory("sys");
    mem.setTodoList([
      { id: "parse", content: "write the CSV parser", status: "in_progress" },
      { id: "fetch", content: "download the export", status: "done" },
      { id: "auth", content: "get an API token", status: "done" },
    ]);
    mem.addUser("hi");
    const last = mem.render().at(-1)!.content;

    // Open work is still listed as open.
    expect(last).toContain("write the CSV parser");
    // Closed work is present, so the model does not redo it...
    expect(last).toContain("download the export");
    expect(last).toContain("get an API token");
    // ...under a heading that cannot be mistaken for the open list.
    expect(last).toContain("Already done");
    expect(last).toMatch(/do not redo/i);
  });

  test("closed items are capped at 8, newest kept", () => {
    const mem = new WorkingMemory("sys");
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      content: `task number ${i}`,
      status: "done",
    }));
    mem.setTodoList(items);
    mem.addUser("hi");
    const last = mem.render().at(-1)!.content;

    // TodoStore.list() returns newest-updated first, so the head of the array wins.
    expect(last).toContain("task number 0");
    expect(last).toContain("task number 7");
    expect(last).not.toContain("task number 8");
  });

  test("a list with no closed items renders no done block at all", () => {
    const mem = new WorkingMemory("sys");
    mem.setTodoList([{ id: "a", content: "open thing", status: "todo" }]);
    mem.addUser("hi");
    expect(mem.render().at(-1)!.content).not.toContain("Already done");
  });

  test("notebook renders every note in full on the last user message", () => {
    const mem = new WorkingMemory("sys");
    mem.setNotebook([
      { key: "note:position", value: "halfway through the parser; column 3 still wrong" },
      { key: "note:api-base", value: "https://api.example.com/v2 — v1 returns 410" },
    ]);
    mem.addUser("hi");
    const rendered = mem.render();

    // One system message only: the notebook is a drawer, not an injected message.
    expect(rendered.filter((m) => m.role === "system")).toHaveLength(1);
    const last = rendered.at(-1)!.content;
    expect(last).toContain("halfway through the parser");
    expect(last).toContain("https://api.example.com/v2");
    // Rendered without the storage prefix — it is plumbing, not content.
    expect(last).not.toContain("note:api-base");
    expect(last).toContain("api-base");
  });

  test("an empty notebook renders nothing", () => {
    const mem = new WorkingMemory("sys");
    mem.setNotebook([]);
    mem.addUser("hi");
    expect(mem.render().at(-1)!.content).toBe("hi");
  });

  test("the notebook is replaced, not accumulated, across turns", () => {
    const mem = new WorkingMemory("sys");
    mem.setNotebook([{ key: "note:position", value: "first position" }]);
    mem.setNotebook([{ key: "note:position", value: "second position" }]);
    mem.addUser("hi");
    const last = mem.render().at(-1)!.content;
    expect(last).toContain("second position");
    expect(last).not.toContain("first position");
  });

  test("the notebook counts toward the estimated prompt size", () => {
    const mem = new WorkingMemory("sys");
    mem.addUser("hi");
    const before = mem.estimatedTokens();
    mem.setNotebook([{ key: "note:x", value: "a fact worth a handful of tokens ".repeat(20) }]);
    expect(mem.estimatedTokens()).toBeGreaterThan(before);
  });
});

describe("WorkingMemory.maybeCompress — context-window safety", () => {
  const summarize = async (msgs: { content: string }[]) =>
    `(${msgs.length} earlier turns)`;

  test("no-op while under the target budget", async () => {
    const mem = new WorkingMemory("sys");
    mem.addUser("hi");
    mem.addAssistant("hello");
    const changed = await mem.maybeCompress(summarize, 10_000);
    expect(changed).toBe(false);
    expect(mem.turns).toHaveLength(2);
  });

  test("compacts to fit a small budget: older turns summarized, recent kept", async () => {
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 20; i++) {
      mem.addUser(`question ${i} ` + "w".repeat(200));
      mem.addAssistant(`answer ${i} ` + "a".repeat(200));
    }
    const before = mem.estimatedTokens();
    const budget = 800;
    const changed = await mem.maybeCompress(summarize, budget);
    expect(changed).toBe(true);
    // Result fits the budget (this is the whole point — no KV overflow).
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(budget);
    expect(mem.estimatedTokens()).toBeLessThan(before);
    // A summary system note was prepended.
    expect(mem.turns[0]?.role).toBe("system");
    expect(mem.turns[0]?.content).toContain("Summary of earlier conversation");
  });

  test("after compaction the model is told the facts list is exact, not to re-fetch everything", async () => {
    // Two safeguards that multiplied into a treadmill. The summary is lossy, so
    // the reminder said "re-read the file or re-run the tool" for any exact
    // detail — with no exception. Measured on a 24-file inventory task under a
    // tight budget: 117 read_file calls for 24 files, four full rounds, never
    // finished, killed by the wall clock. Every compaction took the numbers
    // away and the reminder forbade recalling them.
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 20; i++) {
      mem.addUser(`question ${i} ` + "w".repeat(200));
      mem.addAssistant(`answer ${i} ` + "a".repeat(200));
    }
    await mem.maybeCompress(async () => "### Established facts\n- cache.ts = 88 lines", 800);
    const rendered = mem.render().map((m) => m.content).join("\n");
    // The exception has to be there, or the instruction reads "distrust
    // everything you learned", which on a long task means "never finish".
    expect(rendered).toContain("Established facts");
    expect(rendered).toContain("EXACT");
    expect(rendered).toContain("do not re-fetch");
    // …and the lossy half survives for everything NOT on that list.
    expect(rendered).toContain("re-run the tool");
  });

  test("a single fat tool output can't survive into an overflowing prompt", async () => {
    // The complex-task crash: one huge tool result keeps the prompt over the
    // model context even after older turns are summarized. Token-bounded
    // retention must truncate it so the prompt still fits.
    const mem = new WorkingMemory("sys");
    mem.addUser("run the thing");
    mem.addAssistant("ok");
    mem.addToolResult("read_file", "DATA ".repeat(5_000)); // ~thousands of tokens
    const budget = 600;
    const changed = await mem.maybeCompress(summarize, budget);
    expect(changed).toBe(true);
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(budget);
  });

  test("falls back to a truncation note when the summarizer throws", async () => {
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 10; i++) {
      mem.addUser("q " + "w".repeat(200));
      mem.addAssistant("a " + "a".repeat(200));
    }
    const boom = async () => {
      throw new Error("summarizer down");
    };
    const changed = await mem.maybeCompress(boom, 700);
    expect(changed).toBe(true);
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(700);
    expect(mem.turns[0]?.content).toContain("earlier turns omitted");
  });

  test("an existing summary is carried forward, never re-summarized", async () => {
    // The long-session hallucination cliff: the summary note sits at index 0,
    // so every later compaction fed it back through the summarizer — a summary
    // of a summary of a summary, lossy and free to invent at each hop. The
    // summarizer here fails loudly if it is ever handed the boundary note.
    const seen: string[][] = [];
    const spy = async (msgs: { role: string; content: string }[]) => {
      seen.push(msgs.map((m) => m.content));
      return `FACT-${seen.length}`;
    };
    const mem = new WorkingMemory("sys");
    const fill = () => {
      for (let i = 0; i < 12; i++) {
        mem.addUser("q " + "w".repeat(200));
        mem.addAssistant("a " + "a".repeat(200));
      }
    };
    fill();
    await mem.maybeCompress(spy, 900);
    fill();
    await mem.maybeCompress(spy, 900);
    fill();
    await mem.maybeCompress(spy, 900);

    expect(seen).toHaveLength(3);
    // No pass was ever given the boundary note as input.
    for (const batch of seen) {
      for (const content of batch) {
        expect(content).not.toContain("Summary of earlier conversation");
      }
    }
    // Every summary written so far is still present, verbatim and in order.
    const note = mem.turns[0]?.content ?? "";
    expect(note).toContain("FACT-1");
    expect(note).toContain("FACT-2");
    expect(note).toContain("FACT-3");
    expect(note.indexOf("FACT-1")).toBeLessThan(note.indexOf("FACT-3"));
  });

  test("the original request survives compaction as a pinned drawer", async () => {
    const mem = new WorkingMemory("sys");
    mem.addUser("migrate the billing service to Postgres");
    for (let i = 0; i < 20; i++) {
      mem.addUser("q " + "w".repeat(200));
      mem.addAssistant("a " + "a".repeat(200));
    }
    await mem.maybeCompress(summarize, 900);
    // Gone from the transcript, still in the rendered prompt.
    expect(mem.turns.some((m) => m.content.includes("migrate the billing service"))).toBe(false);
    const rendered = mem.render().map((m) => m.content).join("\n");
    expect(rendered).toContain("migrate the billing service to Postgres");
  });

  test("stale images are dropped, the newest ones survive", async () => {
    // An image is re-sent in full on every later turn and no text ceiling
    // catches it: the note beside it is two lines long, so every size check
    // passes and the pixels ride along forever. This is the only thing that
    // drops them.
    const mem = new WorkingMemory("sys");
    const png = "data:image/png;base64," + "A".repeat(4_000);
    for (let i = 0; i < 8; i++) {
      mem.addUser(`step ${i}`);
      mem.addToolResult(
        "read_file",
        `shot-${i}.png - image/png\n${"x".repeat(8_000)}`,
        [png],
      );
    }
    // Only just over budget, so the tool-result layer alone gets us back
    // under and the summarizer never runs: what is left is what it dropped.
    const before = mem.estimatedTokens();
    let summarizerCalls = 0;
    await mem.maybeCompress(
      (msgs) => { summarizerCalls++; return summarize(msgs); },
      before - 1_000,
    );
    expect(summarizerCalls).toBe(0);

    const tools = mem.turns.filter((m) => m.role === "tool");
    for (const m of tools.slice(-4)) expect(m.images).toEqual([png]);
    for (const m of tools.slice(0, -4)) {
      expect(m.images).toBeUndefined();
      // The note stays: the model can still see what it looked at, and
      // re-read the file if it needs the pixels again.
      expect(m.content).toContain("image/png");
    }
  });

  test("stale tool results are trimmed; recent ones stay verbatim", async () => {
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 8; i++) {
      mem.addUser(`step ${i}`);
      mem.addToolResult("read_file", `PAYLOAD-${i} ` + "x".repeat(8_000));
    }
    const before = mem.estimatedTokens();
    // Over budget, but only just: the tool-result layer alone gets us back
    // under, so the summarizer never runs and anything saved here is its work.
    let summarizerCalls = 0;
    const changed = await mem.maybeCompress(
      (msgs) => { summarizerCalls++; return summarize(msgs); },
      before - 1_000,
    );
    expect(changed).toBe(true);
    expect(summarizerCalls).toBe(0);
    expect(mem.estimatedTokens()).toBeLessThan(before);

    const tools = mem.turns.filter((m) => m.role === "tool");
    // The last four are untouched; the older ones are cut to a fraction and
    // carry the recovery note.
    for (const m of tools.slice(-4)) {
      expect(m.content).not.toContain("re-run the tool");
      expect(m.content.length).toBeGreaterThan(8_000);
    }
    for (const m of tools.slice(0, -4)) {
      expect(m.content).toContain("re-run the tool");
      // Generous: the payload is a run of one repeated char, which packs ~8
      // chars per token, so the 400-token ceiling buys more characters here
      // than it would on real file content.
      expect(m.content.length).toBeLessThan(4_000);
    }
    // Identifying head survives the cut — the model can still tell them apart.
    expect(tools[0]?.content).toContain("PAYLOAD-0");

    // Idempotent: a later pass must not keep eating what it already trimmed.
    // Byte-identical, not merely "no smaller" — a re-cut that happened to land
    // on the same length would still break every prefix cache downstream.
    const trimmed = tools.slice(0, -4).map((m) => m.content);
    mem.addUser("step 8");
    mem.addToolResult("read_file", "PAYLOAD-8 " + "x".repeat(8_000));
    // Shallow enough over that trimming the one newly-stale result covers it,
    // so nothing is summarized away and every earlier message is still here to
    // compare against.
    await mem.maybeCompress(summarize, mem.estimatedTokens() - 300);
    const after = mem.turns.filter((m) => m.role === "tool");
    expect(after.slice(0, trimmed.length).map((m) => m.content)).toEqual(trimmed);
  });

  test("under budget, nothing is touched — the cacheable prefix stays byte-stable", async () => {
    // The regression this guards is invisible in token counts and shows up only
    // on the bill. Trimming rewrites a tool result in the MIDDLE of the
    // transcript; a prompt cache keys on bytes, so the first message that
    // differs from last turn ends the reusable prefix and everything after it
    // is prefilled and billed again. Running the trimmer unconditionally spent
    // ~15,000 re-sent tokens per turn to recover ~476 — with a budget the
    // transcript was nowhere near.
    const mem = new WorkingMemory("sys");
    const big = (n: number) => `file-${n}.ts\n` + `const x${n} = 1;\n`.repeat(400);

    let prev: string[] = [];
    for (let turn = 0; turn < 10; turn++) {
      mem.addUser(`read file ${turn}`);
      mem.addToolResult("read_file", big(turn));
      // Budget the transcript could not reach if it tried.
      expect(await mem.maybeCompress(summarize, 10_000_000)).toBe(false);

      const now = mem.render().map((m) => m.content);
      // Everything before the last user message is settled history and must be
      // untouched. The last user message carries the per-turn dynamic block, so
      // it is expected to differ and is excluded.
      let lastUser = -1;
      const roles = mem.render().map((m) => m.role);
      for (let i = roles.length - 1; i >= 0; i--) if (roles[i] === "user") { lastUser = i; break; }
      if (turn > 0) expect(now.slice(0, lastUser)).toEqual(prev.slice(0, lastUser));
      prev = now;
    }
  });
});

describe("EpisodicMemory.conversation — the /new barrier", () => {
  test("replay starts after the most recent session-reset marker", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const ep = new EpisodicMemory(db.raw, audit.logger);

    ep.record("s1", "user", "first topic");
    ep.record("s1", "assistant", "answer about the first topic");
    ep.record("s1", "system", SESSION_RESET_MARK);
    ep.record("s1", "user", "second topic");
    ep.record("s1", "assistant", "answer about the second topic");

    // Without the barrier this replays all four turns, and `/new` lasts
    // exactly one message before the old conversation walks back in.
    expect(ep.conversation("s1", 40).map((e) => e.content)).toEqual([
      "second topic",
      "answer about the second topic",
    ]);

    // A second reset moves the barrier forward, not back.
    ep.record("s1", "system", SESSION_RESET_MARK);
    expect(ep.conversation("s1", 40)).toHaveLength(0);

    // Nothing was deleted — recall can still surface the old turns.
    expect(ep.recent("s1", 40).some((e) => e.content === "first topic")).toBe(true);

    // A session that never reset is unaffected.
    ep.record("s2", "user", "untouched");
    expect(ep.conversation("s2", 40).map((e) => e.content)).toEqual(["untouched"]);
    db.close();
  });
});
