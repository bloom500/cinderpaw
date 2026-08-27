/**
 * Connector liveness — "on" must stop meaning "enabled in a file".
 *
 * An invalid Discord token made `conn.start()` throw; the supervisor logged it
 * and swallowed it, and every surface (cinderpaw connectors list, /runtime/connectors,
 * the desktop) went on reporting the bot as on, because all three read
 * connectors.json and nothing else. The supervisor is the only code that knows
 * what actually connected, so it writes it down.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConnectorManager, configPath, connectorHealthPath } from "../src/transports/connectors.ts";

const cfg = configPath();
const health = connectorHealthPath();
const hadCfg = existsSync(cfg);
const prevCfg = hadCfg ? readFileSync(cfg, "utf8") : null;
const hadHealth = existsSync(health);
const prevHealth = hadHealth ? readFileSync(health, "utf8") : null;

const restore = (file: string, prev: string | null) => {
  if (prev !== null) writeFileSync(file, prev, "utf8");
  else if (existsSync(file)) unlinkSync(file);
};

afterAll(() => {
  restore(cfg, prevCfg);
  restore(health, prevHealth);
});

const agent = { registerProfile: () => {} } as never;

beforeEach(() => {
  mkdirSync(dirname(cfg), { recursive: true });
  if (existsSync(health)) unlinkSync(health);
});

const readHealth = () =>
  JSON.parse(readFileSync(health, "utf8")) as {
    updatedAt: number;
    connectors: Record<string, { live: boolean; error?: string }>;
  };

test("a connector that cannot start is published as NOT live, with the reason", async () => {
  // A syntactically plausible but invalid token: discord.js rejects it during
  // start(), which is the exact shape that used to be swallowed.
  writeFileSync(
    cfg,
    JSON.stringify({
      connectors: [
        { id: "discord", enabled: true, secrets: { DISCORD_TOKEN: "not-a-real-token" }, allowlist: [], channels: [] },
      ],
    }),
    "utf8",
  );

  await new ConnectorManager(agent, () => {}).reload();

  const h = readHealth();
  expect(h.connectors.discord).toBeDefined();
  expect(h.connectors.discord!.live).toBe(false);
  // The reason has to travel — "it didn't work" sends you to the log file we
  // are trying to stop making people read.
  expect(h.connectors.discord!.error!.length).toBeGreaterThan(0);
  expect(h.updatedAt).toBeGreaterThan(0);
}, 30_000);

test("a connector switched off is absent, not reported as broken", async () => {
  writeFileSync(
    cfg,
    JSON.stringify({ connectors: [{ id: "discord", enabled: false, secrets: {}, allowlist: [], channels: [] }] }),
    "utf8",
  );

  await new ConnectorManager(agent, () => {}).reload();

  // Off by choice is not a failure: claiming otherwise trains people to ignore
  // the warning that matters.
  expect(readHealth().connectors.discord).toBeUndefined();
}, 30_000);
