/**
 * The owner on Discord or Slack is the owner, not a guest.
 *
 * Facts from a Discord or Slack session are scoped to the speaker, so members
 * of one server never rename each other. That rule also caught the owner: what
 * they said on Discord lived under `discord/<id>`, and a scoped fact SHADOWS the
 * global one. "I live in Cluj" on Discord, then "I moved to Bucharest" on the
 * desktop, and Discord kept answering Cluj.
 *
 * The rule chosen on 17 Sep: when a connector's allowlist names exactly one
 * person, that person is the owner, with no setting. With several, everyone
 * stays scoped, because guessing wrong there brings "call me Alex" back.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateForTests } from "../src/db.ts";
import { SemanticMemory, memoryScope, setChatOwner, ROOM_KEYED_TRANSPORTS } from "../src/memory/semantic.ts";
import { ConnectorManager, soleAllowlisted, type AgentLike } from "../src/transports/connectors.ts";

let db: Database;
let semantic: SemanticMemory;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE semantic (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  migrateForTests(db);
  semantic = new SemanticMemory(db, () => {});
  setChatOwner("discord", null);
  setChatOwner("slack", null);
});

describe("memoryScope with a known owner", () => {
  test("the owner's Discord session writes to the owner's memory", () => {
    setChatOwner("discord", "me");
    expect(memoryScope("discord:chan:me")).toBe("");
    expect(memoryScope("discord:dm:me")).toBe("");
  });

  test("anyone else in the same channel stays a guest", () => {
    setChatOwner("discord", "me");
    expect(memoryScope("discord:chan:friend")).toBe("discord/friend");
  });

  test("an owner on Discord is not an owner on Slack", () => {
    setChatOwner("discord", "me");
    expect(memoryScope("slack:chan:me")).toBe("slack/me");
  });
});

describe("promoting the owner's old scoped facts", () => {
  test("a newer thing said on the desktop wins over an older one said on Discord", () => {
    semantic.upsert("city", "Cluj", "discord/me", "fact", 1_000);
    semantic.upsert("city", "Bucharest", "", "fact", 2_000);
    semantic.promoteScope("discord/me");
    setChatOwner("discord", "me");
    expect(semantic.get("city", memoryScope("discord:dm:me"))?.value).toBe("Bucharest");
    expect(semantic.all("").map((f) => f.key)).toEqual(["city"]);
  });

  test("a newer thing said on Discord wins over an older global one", () => {
    semantic.upsert("city", "Bucharest", "", "fact", 1_000);
    semantic.upsert("city", "Cluj", "discord/me", "fact", 2_000);
    semantic.promoteScope("discord/me");
    expect(semantic.get("city", "")?.value).toBe("Cluj");
  });

  test("a fact only ever said on Discord becomes the owner's", () => {
    semantic.upsert("pet", "a cat", "discord/me", "fact", 1_000);
    semantic.promoteScope("discord/me");
    expect(semantic.get("pet", "")?.value).toBe("a cat");
    // Its past comes with it, so "what did I used to say" still has an answer.
    expect(semantic.history("pet", "").map((v) => v.value)).toContain("a cat");
  });

  test("a guest's facts are not touched", () => {
    semantic.upsert("name", "Alex", "discord/friend", "fact", 1_000);
    semantic.promoteScope("discord/me");
    expect(semantic.get("name", "discord/friend")?.value).toBe("Alex");
    expect(semantic.get("name", "")).toBeUndefined();
  });

  test("an empty scope is refused, never read as everything", () => {
    semantic.upsert("name", "Alex", "discord/friend", "fact", 1_000);
    semantic.promoteScope("");
    expect(semantic.get("name", "discord/friend")?.value).toBe("Alex");
  });
});

describe("who the owner is", () => {
  test("exactly one allowlisted person is the owner", () => {
    expect(soleAllowlisted({ id: "discord", allowlist: [" 42 "] })).toBe("42");
  });

  test("two or more, or none, is nobody", () => {
    expect(soleAllowlisted({ id: "discord", allowlist: ["1", "2"] })).toBeNull();
    expect(soleAllowlisted({ id: "discord", allowlist: [] })).toBeNull();
    expect(soleAllowlisted({ id: "discord" })).toBeNull();
    expect(soleAllowlisted({ id: "discord", allowlist: ["", "  "] })).toBeNull();
  });

  test("the manager reports it on every reload, and clears it when it stops being true", async () => {
    const seen: Array<[string, string | null]> = [];
    const mgr = new ConnectorManager({ registerProfile: () => {} } as unknown as AgentLike, () => {});
    mgr.onChatOwner = (transport, userId) => seen.push([transport, userId]);
    // Disabled rows: no transport starts, but the owner is still a fact about the config.
    await mgr.applyRows([{ id: "discord", enabled: false, allowlist: ["42"] }]);
    await mgr.applyRows([{ id: "discord", enabled: false, allowlist: ["42", "7"] }]);
    expect(seen).toContainEqual(["discord", "42"]);
    // The second reload reports every room-keyed transport, discord cleared.
    const last = seen.slice(-ROOM_KEYED_TRANSPORTS.size);
    expect(last).toContainEqual(["discord", null]);
    expect(last).toContainEqual(["slack", null]);
    expect(last).toContainEqual(["telegram", null]);
  });
});
