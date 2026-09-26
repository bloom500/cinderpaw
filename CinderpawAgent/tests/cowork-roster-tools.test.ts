/**
 * The roster's other half. A teammate could be created and nothing else: not
 * changed, not removed, and not read back by the agent that sent it work. And
 * a teammate created without a tool list got every tool, running unattended.
 * Real SQLite; the registry is a small map because only has/register/list are
 * touched.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import { HUMAN } from "../src/cowork/runtime.ts";
import { createCoworkCreateTool, TEAMMATE_DEFAULT_TOOLS } from "../src/tools/builtin/cowork-create.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/types.ts";

/** Tools this fake install has, besides whatever gets registered. */
const INSTALLED = ["read_file", "grep", "web_search", "write_file", "shell_exec"];

function harness() {
  const { raw, close } = openDatabase(":memory:");
  const agents = new CoworkAgentRepo(raw);
  const mailbox = new CoworkMailboxRepo(raw);
  const tools = new Map<string, Tool>();
  const registry = {
    has: (n: string) => INSTALLED.includes(n) || tools.has(n),
    register: (t: Tool) => void tools.set(t.manifest.name, t),
    list: () => [...tools.values()],
  } as unknown as ToolRegistry;
  const create = createCoworkCreateTool({ agents, mailbox, registry, log: () => {} });
  const tool = (name: string) => {
    const t = tools.get(name);
    if (!t) throw new Error(`${name} was never registered`);
    return t;
  };
  return { agents, mailbox, create, tool, close };
}

const chat = { sessionId: "chat-1" };

describe("creating a teammate", () => {
  test("without a tool list gets the read-only default, not everything", async () => {
    const h = harness();
    try {
      const r = await h.create.execute({ name: "Atlas", role: "research" }, chat);
      expect(r.ok).toBe(true);
      const atlas = h.agents.get("atlas")!;
      // Only the default tools this install actually has.
      expect(atlas.tools).toEqual(TEAMMATE_DEFAULT_TOOLS.filter((t) => INSTALLED.includes(t)));
      expect(atlas.tools).not.toContain("shell_exec");
      expect(atlas.tools).not.toContain("write_file");
      expect(r.content).toContain("read-only default");
    } finally {
      h.close();
    }
  });

  test("an explicit tool list is kept as given", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Bolt", role: "builds", tools: ["write_file"] }, chat);
      expect(h.agents.get("bolt")!.tools).toEqual(["write_file"]);
    } finally {
      h.close();
    }
  });

  test('refuses "Human", the name the person is addressed by', async () => {
    const h = harness();
    try {
      const r = await h.create.execute({ name: "Human", role: "anything" }, chat);
      expect(r.ok).toBe(false);
      expect(h.agents.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("brings every roster tool with the first teammate", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "research" }, chat);
      for (const n of ["cowork_team", "cowork_send", "cowork_replies", "cowork_update_teammate", "cowork_remove_teammate"]) {
        expect(() => h.tool(n)).not.toThrow();
      }
    } finally {
      h.close();
    }
  });
});

describe("cowork_update_teammate", () => {
  test("changes what was asked and keeps the rest", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "research", instructions: "be brief", model: "m1" }, chat);
      const r = await h.tool("cowork_update_teammate").execute({ teammate: "atlas", role: "deep research", tools: ["grep"] }, chat);
      expect(r.ok).toBe(true);
      const a = h.agents.get("atlas")!;
      expect(a).toMatchObject({ role: "deep research", instructions: "be brief", modelPin: "m1", tools: ["grep"] });
    } finally {
      h.close();
    }
  });

  test('"" for model clears the pin', async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r", model: "m1" }, chat);
      await h.tool("cowork_update_teammate").execute({ teammate: "Atlas", model: "" }, chat);
      expect(h.agents.get("atlas")!.modelPin).toBeUndefined();
    } finally {
      h.close();
    }
  });

  test("refuses an unknown tool and changes nothing", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r" }, chat);
      const before = h.agents.get("atlas")!.tools;
      const r = await h.tool("cowork_update_teammate").execute({ teammate: "Atlas", role: "x", tools: ["grpe"] }, chat);
      expect(r.ok).toBe(false);
      expect(h.agents.get("atlas")!).toMatchObject({ role: "r", tools: before });
    } finally {
      h.close();
    }
  });

  test("refuses a rename onto another teammate's name", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r" }, chat);
      await h.create.execute({ name: "Bolt", role: "r" }, chat);
      const r = await h.tool("cowork_update_teammate").execute({ teammate: "Bolt", name: "atlas" }, chat);
      expect(r.ok).toBe(false);
      expect(h.agents.get("bolt")!.name).toBe("Bolt");
    } finally {
      h.close();
    }
  });
});

describe("cowork_remove_teammate", () => {
  test("removes them and cancels what was still waiting for them", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r" }, chat);
      const waiting = h.mailbox.send({ fromAgentId: HUMAN, toAgentId: "atlas", body: "later" });
      const r = await h.tool("cowork_remove_teammate").execute({ teammate: "Atlas" }, chat);
      expect(r.ok).toBe(true);
      expect(h.agents.get("atlas")).toBeUndefined();
      expect(h.mailbox.get(waiting.id)?.status).toBe("rejected");
    } finally {
      h.close();
    }
  });
});

describe("cowork_replies", () => {
  test("returns a stored answer once, and says who is still working", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r" }, chat);
      await h.create.execute({ name: "Bolt", role: "r" }, chat);
      const q = h.mailbox.send({ fromAgentId: HUMAN, toAgentId: "atlas", threadId: "chat-1", body: "find the bug" });
      h.mailbox.updateStatus(q.id, "processed");
      h.mailbox.send({
        fromAgentId: "atlas", toAgentId: HUMAN, threadId: "chat-1", body: "It is in the parser.",
        payloadJson: JSON.stringify({ coworkHops: 0, replyTo: q.id }),
      });
      h.mailbox.send({ fromAgentId: HUMAN, toAgentId: "bolt", threadId: "chat-1", body: "write the fix" });

      const first = await h.tool("cowork_replies").execute({}, chat);
      expect(first.content).toContain('Atlas (to "find the bug")');
      expect(first.content).toContain("It is in the parser.");
      expect(first.content).toContain("Still working: Bolt.");

      const second = await h.tool("cowork_replies").execute({}, chat);
      expect(second.content).toContain("No new replies.");
      const again = await h.tool("cowork_replies").execute({ all: true }, chat);
      expect(again.content).toContain("It is in the parser.");
    } finally {
      h.close();
    }
  });

  test("shows a failure as a failure", async () => {
    const h = harness();
    try {
      await h.create.execute({ name: "Atlas", role: "r" }, chat);
      const q = h.mailbox.send({ fromAgentId: HUMAN, toAgentId: "atlas", threadId: "chat-1", body: "go" });
      h.mailbox.updateStatus(q.id, "rejected");
      h.mailbox.send({
        fromAgentId: "atlas", toAgentId: HUMAN, threadId: "chat-1", body: "model is down",
        payloadJson: JSON.stringify({ coworkHops: 0, replyTo: q.id, failed: true }),
      });
      const r = await h.tool("cowork_replies").execute({}, chat);
      expect(r.content).toContain("Atlas could not answer");
      expect(r.content).toContain("model is down");
    } finally {
      h.close();
    }
  });
});
