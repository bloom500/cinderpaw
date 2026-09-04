import { describe, expect, test } from "vitest";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import {
  createCoworkSendTool,
  createCoworkTeamTool,
} from "../src/tools/builtin/cowork.ts";

function setup() {
  const db = openDatabase(":memory:");
  const agents = new CoworkAgentRepo(db.raw);
  const mailbox = new CoworkMailboxRepo(db.raw);
  return {
    agents,
    mailbox,
    team: createCoworkTeamTool(agents),
    send: createCoworkSendTool(agents, mailbox),
  };
}

const humanCtx = { sessionId: "s-123" };

describe("cowork_team", () => {
  test("empty roster is a friendly empty answer, not an error", async () => {
    const { team } = setup();
    const r = await team.execute({}, humanCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No teammates");
  });

  test("lists names and roles", async () => {
    const { agents, team } = setup();
    agents.upsert({ name: "Bob", role: "bug fixes" });
    const r = await team.execute({}, humanCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('"Bob"');
    expect(r.content).toContain("bug fixes");
  });
});

describe("cowork_send", () => {
  test("delivers a pending mailbox row addressed to the teammate, sender=human", async () => {
    const { agents, mailbox, send } = setup();
    const bob = agents.upsert({ name: "Bob" });
    const r = await send.execute({ to: "Bob", message: "count the files" }, humanCtx);
    expect(r.ok).toBe(true);
    const inbox = mailbox.inbox(bob.id, "pending");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].fromAgentId).toBe("human");
    expect(inbox[0].body).toBe("count the files");
  });

  test("resolves case-insensitively by NAME, persists the agent id", async () => {
    const { agents, mailbox, send } = setup();
    const bob = agents.upsert({ name: "Bob" });
    const r = await send.execute({ to: "bob", message: "hi" }, humanCtx);
    expect(r.ok).toBe(true);
    expect(mailbox.inbox(bob.id)).toHaveLength(1);
  });

  test("inside a cowork session the sender is that agent, not human", async () => {
    const { agents, mailbox, send } = setup();
    const alice = agents.upsert({ name: "Alice" });
    const bob = agents.upsert({ name: "Bob" });
    const r = await send.execute(
      { to: "Bob", message: "take this task" },
      { sessionId: `cowork:${alice.id}` },
    );
    expect(r.ok).toBe(true);
    expect(mailbox.inbox(bob.id)[0].fromAgentId).toBe(alice.id);
  });

  test("unknown teammate fails WITH the roster in the message", async () => {
    const { agents, send } = setup();
    agents.upsert({ name: "Alice" });
    agents.upsert({ name: "Bob" });
    const r = await send.execute({ to: "Carol", message: "x" }, humanCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain('"Alice"');
    expect(r.content).toContain('"Bob"');
    expect((r as { error?: string }).error).toBe("unknown_teammate");
  });

  test("missing args are refused", async () => {
    const { send } = setup();
    expect((await send.execute({ to: "", message: "" }, humanCtx)).ok).toBe(false);
  });

  test("thread_id flows through so follow-ups stay together", async () => {
    const { agents, mailbox, send } = setup();
    const bob = agents.upsert({ name: "Bob" });
    await send.execute({ to: "Bob", message: "a", thread_id: "t-9" }, humanCtx);
    expect(mailbox.inbox(bob.id)[0].threadId).toBe("t-9");
  });
});
