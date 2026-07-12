/**
 * connectors_manage — the agent's self-service connector door.
 *
 * Uses FERAL_HOME-independent configPath (~/.feral/connectors.json is fixed),
 * so these tests intercept at the tool level: list redaction, configure
 * round-trip, unknown id rejection, and reload() being poked after a save.
 *
 * NOTE: configure writes the REAL ~/.feral/connectors.json. The test restores
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
