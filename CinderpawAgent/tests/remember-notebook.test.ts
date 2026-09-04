import { expect, test } from "bun:test";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { createRememberTool, MAX_NOTES, POSITION_KEY } from "../src/tools/builtin/remember.ts";
import { openDatabase } from "../src/db.ts";

function newTool() {
  const db = openDatabase(":memory:").raw;
  const semantic = new SemanticMemory(db, () => {});
  return { tool: createRememberTool(semantic), semantic };
}

test("a note: key is stored like any other fact", async () => {
  const { tool, semantic } = newTool();
  const res = await tool.execute({ key: "note:position", value: "parser, column 3" }, { sessionId: "" });
  expect(res.ok).toBe(true);
  expect(semantic.get("note:position")?.value).toBe("parser, column 3");
});

test("rewriting a note overwrites it rather than adding a second", async () => {
  const { tool, semantic } = newTool();
  await tool.execute({ key: "note:position", value: "first" }, { sessionId: "" });
  await tool.execute({ key: "note:position", value: "second" }, { sessionId: "" });
  expect(semantic.get("note:position")?.value).toBe("second");
  expect(semantic.all().filter((f) => f.key.startsWith("note:"))).toHaveLength(1);
});

test(`the notebook is capped at ${MAX_NOTES} and the refusal says what to do`, async () => {
  const { tool, semantic } = newTool();
  for (let i = 0; i < MAX_NOTES; i++) {
    const res = await tool.execute({ key: `note:k${i}`, value: `v${i}` }, { sessionId: "" });
    expect(res.ok).toBe(true);
  }
  const overflow = await tool.execute({ key: "note:one-too-many", value: "v" }, { sessionId: "" });
  expect(overflow.ok).toBe(false);
  expect(overflow.content).toMatch(/rewrite|drop/i);
  // Nothing was silently evicted to make room.
  expect(semantic.all().filter((f) => f.key.startsWith("note:"))).toHaveLength(MAX_NOTES);
});

test("overwriting an existing note is allowed even at the cap", async () => {
  const { tool } = newTool();
  for (let i = 0; i < MAX_NOTES; i++) {
    await tool.execute({ key: `note:k${i}`, value: `v${i}` }, { sessionId: "" });
  }
  const res = await tool.execute({ key: "note:k0", value: "rewritten" }, { sessionId: "" });
  expect(res.ok).toBe(true);
});

test("the position key is exempt from the cap so the safety net can never be blocked", async () => {
  const { tool, semantic } = newTool();
  for (let i = 0; i < MAX_NOTES; i++) {
    await tool.execute({ key: `note:k${i}`, value: `v${i}` }, { sessionId: "" });
  }
  const res = await tool.execute({ key: POSITION_KEY, value: "still moving" }, { sessionId: "" });
  expect(res.ok).toBe(true);
  expect(semantic.get(POSITION_KEY)?.value).toBe("still moving");
});

test("ordinary facts are unaffected by the notebook cap", async () => {
  const { tool } = newTool();
  for (let i = 0; i < MAX_NOTES; i++) {
    await tool.execute({ key: `note:k${i}`, value: `v${i}` }, { sessionId: "" });
  }
  const res = await tool.execute({ key: "home_city", value: "Sibiu" }, { sessionId: "" });
  expect(res.ok).toBe(true);
});

// The notebook is a scratchpad, not a fact about a person. `all(scope)` folds the
// global rows in on purpose — right for "what the agent knows", wrong for "what
// this session is in the middle of". These two tests pin the difference.

test("a full owner notebook does not consume a Discord member's capacity", async () => {
  const { tool, semantic } = newTool();
  for (let i = 0; i < MAX_NOTES; i++) {
    await tool.execute({ key: `note:k${i}`, value: `v${i}` }, { sessionId: "" });
  }
  // Same tool, a scoped speaker. Counting the owner's rows here left every guest
  // permanently at the cap with nothing of their own to delete.
  const res = await tool.execute(
    { key: "note:mine", value: "my own note" },
    { sessionId: "discord:guild1:user9" },
  );
  expect(res.ok).toBe(true);
  expect(semantic.own("discord/user9").filter((f) => f.key.startsWith("note:"))).toHaveLength(1);
});

test("one member's notebook is invisible to another member and to the owner", async () => {
  const { tool, semantic } = newTool();
  await tool.execute({ key: "note:position", value: "user9 secret" }, { sessionId: "discord:g:user9" });
  await tool.execute({ key: "note:position", value: "owner work" }, { sessionId: "" });

  const notesOf = (scope: string) =>
    semantic.own(scope).filter((f) => f.key.startsWith("note:")).map((f) => f.value);

  expect(notesOf("discord/user9")).toEqual(["user9 secret"]);
  // The other member sees neither. `all()` would hand them the owner's row.
  expect(notesOf("discord/user7")).toEqual([]);
  expect(notesOf("")).toEqual(["owner work"]);
});
