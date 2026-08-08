/**
 * Task 2 — one Discord channel, many people, separate memories.
 *
 * The old key was `discord:${channelId}`, so every member of a channel shared
 * one session: one working-memory transcript and one set of semantic facts.
 * "call me Alex" from user A renamed user B.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { discordSessionId, parseDiscordSession, runChatCommand } from "../src/transports/connectors.ts";
import { SemanticMemory, memoryScope } from "../src/memory/semantic.ts";

describe("discord session ids", () => {
  test("two users in the same channel get different sessions", () => {
    const a = discordSessionId("chan1", "userA", false);
    const b = discordSessionId("chan1", "userB", false);
    expect(a).not.toBe(b);
    expect(a).toBe("discord:chan1:userA");
  });

  test("a DM is keyed on the person, not the DM channel", () => {
    expect(discordSessionId("dmchan", "userA", true)).toBe("discord:dm:userA");
  });

  test("the same user in two channels is two sessions (channel context)", () => {
    expect(discordSessionId("chan1", "userA", false)).not.toBe(
      discordSessionId("chan2", "userA", false),
    );
  });

  test("`discord` stays the first segment, so ask_user routing still resolves", () => {
    for (const s of [
      discordSessionId("c", "u", false),
      discordSessionId("c", "u", true),
    ]) {
      expect(s.split(":", 1)[0]).toBe("discord");
    }
  });

  test("round-trips to a send target", () => {
    expect(parseDiscordSession("discord:chan1:userA")).toEqual({
      dm: false,
      target: "chan1",
      userId: "userA",
    });
    expect(parseDiscordSession("discord:dm:userA")).toEqual({
      dm: true,
      target: "userA",
      userId: "userA",
    });
  });

  test("a legacy discord:<channelId> session still parses (it must keep loading)", () => {
    expect(parseDiscordSession("discord:chan1")).toEqual({
      dm: false,
      target: "chan1",
      userId: null,
    });
  });

  test("other connectors are not Discord sessions", () => {
    expect(parseDiscordSession("whatsapp:40712@s.whatsapp.net")).toBeNull();
    expect(parseDiscordSession("slack:C123")).toBeNull();
  });
});

describe("memoryScope", () => {
  test("single-user surfaces stay global — nothing about desktop/TUI changes", () => {
    for (const s of ["default", "tui-1", "cron:job7", "slack:C123", "whatsapp:4071@s"]) {
      expect(memoryScope(s)).toBe("");
    }
  });

  test("a Discord speaker gets their own scope", () => {
    expect(memoryScope("discord:chan1:userA")).toBe("discord/userA");
    expect(memoryScope("discord:dm:userA")).toBe("discord/userA");
  });

  test("the same user is one identity across channels and DMs", () => {
    expect(memoryScope("discord:chan1:userA")).toBe(memoryScope("discord:chan2:userA"));
    expect(memoryScope("discord:chan1:userA")).toBe(memoryScope("discord:dm:userA"));
  });

  test("a legacy channel-only session is global (it predates scoping)", () => {
    expect(memoryScope("discord:chan1")).toBe("");
  });
});

describe("semantic facts do not leak between Discord users", () => {
  let db: Database;
  let semantic: SemanticMemory;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE semantic (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    semantic = new SemanticMemory(db, () => {});
  });

  const scopeA = memoryScope("discord:chan1:userA");
  const scopeB = memoryScope("discord:chan1:userB");

  test('"call me Alex" from user A does not rename user B', () => {
    semantic.upsert("name", "Alex", scopeA);
    expect(semantic.get("name", scopeA)?.value).toBe("Alex");
    expect(semantic.get("name", scopeB)).toBeUndefined();
    expect(semantic.all(scopeB).map((f) => f.key)).not.toContain("name");
  });

  test("each user sees only their own value for the same key", () => {
    semantic.upsert("name", "Alex", scopeA);
    semantic.upsert("name", "Bea", scopeB);
    expect(semantic.get("name", scopeA)?.value).toBe("Alex");
    expect(semantic.get("name", scopeB)?.value).toBe("Bea");
  });

  test("the owner's global facts are still visible to everyone", () => {
    semantic.upsert("product_name", "Feral"); // written from the desktop app
    expect(semantic.get("product_name", scopeA)?.value).toBe("Feral");
    expect(semantic.all(scopeA).map((f) => f.key)).toContain("product_name");
  });

  test("a user's own fact shadows the global one of the same key", () => {
    semantic.upsert("timezone", "Europe/Bucharest");
    semantic.upsert("timezone", "America/New_York", scopeA);
    expect(semantic.get("timezone", scopeA)?.value).toBe("America/New_York");
    expect(semantic.get("timezone")?.value).toBe("Europe/Bucharest");
    // …and only once in the rendered list, not twice.
    const keys = semantic.all(scopeA).filter((f) => f.key === "timezone");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.value).toBe("America/New_York");
  });

  test("keys come back unprefixed — the storage encoding never reaches the model", () => {
    semantic.upsert("name", "Alex", scopeA);
    expect(semantic.all(scopeA).map((f) => f.key)).toEqual(["name"]);
    expect(semantic.renderForPrompt(scopeA)).toContain("- name: Alex");
    expect(semantic.renderForPrompt(scopeA)).not.toContain("discord/");
  });

  test("a scoped user cannot delete the owner's fact by guessing the key", () => {
    semantic.upsert("api_key_hint", "in 1password");
    semantic.delete("api_key_hint", scopeA);
    expect(semantic.get("api_key_hint")?.value).toBe("in 1password");
  });

  test("unscoped reads still see everything (boot cleanup / fractal migration)", () => {
    semantic.upsert("global_fact", "g");
    semantic.upsert("name", "Alex", scopeA);
    expect(semantic.all()).toHaveLength(2);
  });
});

describe("connector chat commands", () => {
  const fakeAgent = () => {
    const reset: string[] = [];
    const compacted: string[] = [];
    return {
      reset,
      compacted,
      agent: {
        handle: async () => "should not be reached",
        resetSession(id: string) {
          reset.push(id);
        },
        async compactSession(id: string) {
          compacted.push(id);
          return "compacted" as const;
        },
        costReport: () => "## Where the tokens went\n\n**Completions:** 3",
      },
    };
  };

  test("/new resets the session and never reaches the agent", async () => {
    const { agent, reset } = fakeAgent();
    // "!" forms are not a convenience: on Discord and Slack the "/" never
    // reaches us at all — the client turns it into its own command picker, so
    // the reset was unreachable on both. Found the only way it could be, by a
    // person trying to type it.
    for (const cmd of ["/new", "/reset", "/clear", " /NEW ", "!new", "!reset", " !CLEAR "]) {
      const reply = await runChatCommand(agent, "discord:dm:u1", cmd);
      expect(reply).toContain("Fresh start");
    }
    expect(reset).toEqual(Array(7).fill("discord:dm:u1"));
  });

  test("!compact folds too", async () => {
    const { agent, compacted } = fakeAgent();
    expect(await runChatCommand(agent, "slack:c1:u1", "!compact")).toContain("Compacted");
    expect(compacted).toEqual(["slack:c1:u1"]);
  });

  test("/compact folds without resetting", async () => {
    const { agent, reset, compacted } = fakeAgent();
    const reply = await runChatCommand(agent, "slack:c1:u1", "/compact");
    expect(reply).toContain("Compacted");
    expect(compacted).toEqual(["slack:c1:u1"]);
    expect(reset).toEqual([]);
  });

  test("!cost and !tokens report on demand, under both prefixes", async () => {
    const { agent, reset, compacted } = fakeAgent();
    for (const cmd of ["/cost", "!cost", " !COST ", "/tokens", "!tokens"]) {
      expect(await runChatCommand(agent, "discord:dm:u1", cmd)).toContain("Where the tokens went");
    }
    // Reporting must not disturb the conversation it is reporting on.
    expect(reset).toEqual([]);
    expect(compacted).toEqual([]);
  });

  test("a build with no accounting says so instead of throwing", async () => {
    const bare = { handle: async () => "unused" };
    expect(await runChatCommand(bare, "discord:dm:u1", "!cost")).toContain("No accounting yet");
  });

  test("ordinary text is not a command", async () => {
    const { agent, reset } = fakeAgent();
    for (const text of ["what is new?", "/newsletter", "tell me about /new"]) {
      expect(await runChatCommand(agent, "whatsapp:x", text)).toBeNull();
    }
    expect(reset).toEqual([]);
  });
});
