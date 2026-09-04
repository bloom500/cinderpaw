/**
 * connectors_manage — the agent's self-service connector door.
 *
 * Uses CINDERPAW_HOME-independent configPath (~/.cinderpaw/connectors.json is fixed),
 * so these tests intercept at the tool level: list redaction, configure
 * round-trip, unknown id rejection, and reload() being poked after a save.
 *
 * NOTE: configure writes the REAL ~/.cinderpaw/connectors.json. The test restores
 * the previous file content afterward.
 */
import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createConnectorsManageTool } from "../src/tools/builtin/connectors-manage.ts";
import { configPath } from "../src/transports/connectors.ts";

const file = configPath();
const hadFile = existsSync(file);
const previous = hadFile ? readFileSync(file, "utf8") : null;

afterAll(() => {
  if (previous !== null) writeFileSync(file, previous, "utf8");
  else if (existsSync(file)) unlinkSync(file);
});

function makeTool() {
  let reloads = 0;
  const tool = createConnectorsManageTool({
    reload: async () => {
      reloads += 1;
    },
  });
  return { tool, reloads: () => reloads };
}

const ctx = {} as never; // execute() ignores ctx for this tool

test("list returns the catalog with secrets redacted to present/absent", async () => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      connectors: [
        { id: "discord", enabled: true, secrets: { DISCORD_TOKEN: "super-secret-token" } },
      ],
    }),
    "utf8",
  );
  const { tool } = makeTool();
  const res = await tool.execute({ action: "list" }, ctx);
  expect(res.ok).toBe(true);
  expect(res.content).not.toContain("super-secret-token"); // never echoed
  const parsed = JSON.parse(res.content) as Array<{ id: string; enabled: boolean; configured: Array<{ present: boolean }> }>;
  const discord = parsed.find((c) => c.id === "discord")!;
  expect(discord.enabled).toBe(true);
  expect(discord.configured[0]!.present).toBe(true);
  expect(parsed.map((c) => c.id).sort()).toEqual(["discord", "slack", "whatsapp"]);
});

test("configure upserts a row, persists it, and pokes reload()", async () => {
  const { tool, reloads } = makeTool();
  const res = await tool.execute(
    {
      action: "configure",
      id: "discord",
      enabled: true,
      secrets: { DISCORD_TOKEN: "tok-123" },
      allowlist: ["user#1"],
    },
    ctx,
  );
  expect(res.ok).toBe(true);
  expect(res.content).not.toContain("tok-123"); // secret stored, not echoed
  expect(reloads()).toBe(1);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
    connectors: Array<{ id: string; enabled: boolean; secrets: Record<string, string> }>;
  };
  const row = onDisk.connectors.find((r) => r.id === "discord")!;
  expect(row.enabled).toBe(true);
  expect(row.secrets.DISCORD_TOKEN).toBe("tok-123");
});

test("configure with missing secrets reports what's still needed", async () => {
  const { tool } = makeTool();
  const res = await tool.execute({ action: "configure", id: "slack", enabled: true }, ctx);
  expect(res.ok).toBe(true);
  expect(res.content).toContain("SLACK_APP_TOKEN");
  expect(res.content).toContain("SLACK_BOT_TOKEN");
});

test("unknown connector id is rejected", async () => {
  const { tool, reloads } = makeTool();
  const res = await tool.execute({ action: "configure", id: "telegram" }, ctx);
  expect(res.ok).toBe(false);
  expect(reloads()).toBe(0);
});

test("emptying a populated allowlist is refused — empty means NOBODY, not everyone", async () => {
  // The failure this exists for, measured 2026-08-14: the agent was asked to
  // configure a DIFFERENT bot, reached for this tool (the only one shaped like
  // "manage a Discord bot"), cleared its own allowlist, announced that everyone
  // could now talk to it, and went silent for four hours. The gate is
  // `#allow.has(id)` over a Set built from this list — empty answers nobody.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      connectors: [
        { id: "discord", enabled: true, secrets: { DISCORD_TOKEN: "t" }, allowlist: ["195569970095194113"] },
      ],
    }),
    "utf8",
  );
  const { tool, reloads } = makeTool();
  const res = await tool.execute({ action: "configure", id: "discord", allowlist: [] }, ctx);

  expect(res.ok).toBe(false);
  expect(res.error).toBe("would_lock_out");
  // The refusal has to teach, or the next attempt is the same attempt.
  expect(res.content).toContain("does NOT mean");
  // Nothing was written and nothing was reloaded — the bot is still reachable.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { connectors: Array<{ allowlist: string[] }> };
  expect(onDisk.connectors[0]!.allowlist).toEqual(["195569970095194113"]);
  expect(reloads()).toBe(0);
});

test("blank entries do not sneak an allowlist to empty", async () => {
  // `[""]` and `["  "]` are the same lockout with a different shape.
  writeFileSync(
    file,
    JSON.stringify({ connectors: [{ id: "discord", enabled: true, allowlist: ["123"] }] }),
    "utf8",
  );
  const { tool } = makeTool();
  const res = await tool.execute({ action: "configure", id: "discord", allowlist: ["", "   "] }, ctx);
  expect(res.ok).toBe(false);
  expect(res.error).toBe("would_lock_out");
});

test("a real allowlist still saves, and ids are trimmed", async () => {
  writeFileSync(
    file,
    JSON.stringify({ connectors: [{ id: "discord", enabled: true, allowlist: ["123"] }] }),
    "utf8",
  );
  const { tool, reloads } = makeTool();
  const res = await tool.execute(
    { action: "configure", id: "discord", allowlist: [" 123 ", "456"] },
    ctx,
  );
  expect(res.ok).toBe(true);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { connectors: Array<{ allowlist: string[] }> };
  expect(onDisk.connectors[0]!.allowlist).toEqual(["123", "456"]);
  expect(reloads()).toBe(1);
});

test("a first-time connector starts with no allowlist, and is TOLD it answers nobody", async () => {
  // Refusing here would make the tool unable to connect anyone: on a first
  // connection the user may not know their own id yet. So it saves — and warns
  // in the result the model actually reads. Without this, a brand-new install
  // gets a bot that shows online in Discord and ignores its owner forever,
  // which is the same catastrophe as the lockout, moved to day one.
  writeFileSync(file, JSON.stringify({ connectors: [] }), "utf8");
  const { tool } = makeTool();
  const res = await tool.execute(
    { action: "configure", id: "discord", enabled: true, secrets: { DISCORD_TOKEN: "t" }, allowlist: [] },
    ctx,
  );
  expect(res.ok).toBe(true);
  expect(res.content).toContain("answers NOBODY");
  expect(res.content).toContain("allowlist:");
});

test("a connector with someone on the list gets no scary warning", async () => {
  writeFileSync(file, JSON.stringify({ connectors: [] }), "utf8");
  const { tool } = makeTool();
  const res = await tool.execute(
    { action: "configure", id: "discord", enabled: true, secrets: { DISCORD_TOKEN: "t" }, allowlist: ["42"] },
    ctx,
  );
  expect(res.ok).toBe(true);
  expect(res.content).not.toContain("answers NOBODY");
});

test("a zero allowlist announces itself at boot instead of reading as healthy", async () => {
  // The connector logs in and shows as online in Discord either way. The only
  // difference between "working" and "deaf to everyone" was this number.
  const { allowSummary } = await import("../src/transports/connectors.ts");
  expect(allowSummary(0)).toContain("NOBODY CAN REACH IT");
  expect(allowSummary(2)).toBe("2 allowed");
});

// ── Guided setup ─────────────────────────────────────────────────────────
//
// "Bot token from the Discord Developer Portal" only helps someone who
// has already been there. `list` now carries written steps so the agent
// walks the user through the real click path instead of improvising it
// from a memory of a portal that has since moved its buttons.

interface ListedConnector {
  id: string;
  requires: string[];
  steps?: string[];
  consoleUrl?: string;
}

async function listConnectors(): Promise<ListedConnector[]> {
  const tool = createConnectorsManageTool({ reload: async () => {} });
  const res = await tool.execute({ action: "list" }, { sessionId: "t" } as never);
  expect(res.ok).toBe(true);
  return JSON.parse(res.content) as ListedConnector[];
}

test("list returns walkable steps, and a console URL wherever a secret is needed", async () => {
  for (const c of await listConnectors()) {
    expect(Array.isArray(c.steps)).toBe(true);
    expect(c.steps!.length).toBeGreaterThanOrEqual(3);
    // A connector that needs a secret must say where to go and get it.
    if (c.requires.length > 0) {
      expect(c.consoleUrl).toMatch(/^https:\/\//);
      expect(c.steps!.some((s) => s.includes(c.consoleUrl!))).toBe(true);
    }
  }
});

test("the Discord steps cover the two things that silently break it", async () => {
  const discord = (await listConnectors()).find((c) => c.id === "discord");
  const steps = (discord?.steps ?? []).join(" ");

  // Without Message Content Intent the bot connects and then appears to
  // ignore every message, which reads to a user as "Cinderpaw is broken".
  expect(steps).toContain("Message Content Intent");
  // Discord shows the token once; navigate away and you must reset it.
  expect(steps.toLowerCase()).toContain("once");
  // And the bot still has to be invited to a server to be reachable.
  expect(steps).toContain("URL Generator");
});

test("no step routes a secret anywhere but this chat", async () => {
  // The point of the guided flow is that the secret reaches the keychain
  // through one door. A step pointing at a dotfile or an env var would
  // quietly route it somewhere nothing redacts.
  for (const c of await listConnectors()) {
    for (const step of c.steps ?? []) {
      expect(step).not.toMatch(/\.env\b|environment variable|connectors\.json/i);
    }
  }
});
