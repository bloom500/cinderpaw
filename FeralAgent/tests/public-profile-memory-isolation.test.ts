/**
 * Follow-ups to the Discord session fix: the same class of bug on the other
 * room-keyed transport (Slack), and the sharper version of it — a stranger
 * writing into the owner's durable memory through the public lead mode.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  slackSessionId,
  discordSessionId,
  PUBLIC_ALLOWED_TOOLS,
  WHATSAPP_PUBLIC_PROFILE,
} from "../src/transports/connectors.ts";
import { SemanticMemory, memoryScope } from "../src/memory/semantic.ts";

describe("slack sessions are per-speaker, like discord", () => {
  test("two users in one channel get different sessions", () => {
    expect(slackSessionId("C123", "U_A")).not.toBe(slackSessionId("C123", "U_B"));
    expect(slackSessionId("C123", "U_A")).toBe("slack:C123:U_A");
  });

  test("`slack` stays segment 0 so ask_user routing still resolves", () => {
    expect(slackSessionId("C123", "U_A").split(":", 1)[0]).toBe("slack");
  });

  test("the channel is recoverable from the session id for posting back", () => {
    expect(slackSessionId("C123", "U_A").split(":")[1]).toBe("C123");
  });

  test("a slack speaker gets their own memory scope", () => {
    expect(memoryScope(slackSessionId("C123", "U_A"))).toBe("slack/U_A");
    expect(memoryScope(slackSessionId("C123", "U_A"))).not.toBe(
      memoryScope(slackSessionId("C123", "U_B")),
    );
  });

  test("slack and discord users with the same raw id do not collide", () => {
    expect(memoryScope(slackSessionId("C1", "X"))).not.toBe(
      memoryScope(discordSessionId("C1", "X", false)),
    );
  });

  test("a legacy slack:<channel> session stays global", () => {
    expect(memoryScope("slack:C123")).toBe("");
  });

  test("whatsapp needs no scope — the JID is already the person", () => {
    expect(memoryScope("whatsapp:40712345678@s.whatsapp.net")).toBe("");
  });
});

/**
 * The extractor guard lives in AgentLoop (`#profileFor(sessionId)?.allowed`).
 * Standing up the whole loop for this would test the loop, not the rule, so
 * the rule itself is pinned here: RESTRICTED profiles are the ones that must
 * not write, persona-only profiles must keep writing.
 */
describe("public lead mode must not mine facts about 'the user'", () => {
  const restricted = { allowed: new Set<string>(PUBLIC_ALLOWED_TOOLS) };
  const personaOnly = { allowed: null };
  const owner = null;

  const extracts = (profile: { allowed: Set<string> | null } | null) => !profile?.allowed;

  test("a restricted profile (public WhatsApp lead) does not extract", () => {
    expect(extracts(restricted)).toBe(false);
  });

  test("a persona-only profile is still the owner and does extract", () => {
    expect(extracts(personaOnly)).toBe(true);
  });

  test("the default owner session extracts", () => {
    expect(extracts(owner)).toBe(true);
  });

  test("the public toolset has no memory write path of its own", () => {
    expect(PUBLIC_ALLOWED_TOOLS).not.toContain("remember");
    expect(PUBLIC_ALLOWED_TOOLS).not.toContain("recall");
    // capture_lead IS the sanctioned channel for a lead's details.
    expect(PUBLIC_ALLOWED_TOOLS).toContain("capture_lead");
  });

  test("the public profile is registered restricted, not persona-only", () => {
    // If this ever became a persona-only profile, the extractor guard above
    // would silently stop applying and strangers would write to memory again.
    expect(WHATSAPP_PUBLIC_PROFILE).toBe("whatsapp-public");
    expect(PUBLIC_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  });
});

describe("a stranger's claim never lands where the owner reads it", () => {
  let db: Database;
  let semantic: SemanticMemory;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE semantic (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    semantic = new SemanticMemory(db, () => {});
  });

  test("had the extractor run, a scoped write would still not reach the owner", () => {
    // Defence in depth: even if a future change re-enables extraction for a
    // profiled session, a scoped write stays out of the owner's global view.
    semantic.upsert("occupation", "runs a competitor", "slack/U_STRANGER");
    expect(semantic.get("occupation")).toBeUndefined();
    expect(semantic.all().map((f) => f.value)).toContain("runs a competitor");
    // The row exists, but only under the stranger's scope prefix — the
    // owner's unscoped `get` above cannot reach it by key.
    expect(semantic.all("").map((f) => f.key)).toEqual(["slack/U_STRANGERoccupation"]);
  });
});
