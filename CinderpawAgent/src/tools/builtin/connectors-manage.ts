/**
 * connectors_manage — the agent's self-service door into its own connectors.
 *
 * Lets the agent connect itself to Discord / Slack / WhatsApp when the user
 * asks ("connect to my Discord, here's the token") instead of bouncing the
 * user to the settings UI. Two actions:
 *
 *   list      — supported connectors, what each needs, current state
 *               (secrets REDACTED to present/absent — never echoed back)
 *   configure — upsert one connector's row in ~/.cinderpaw/connectors.json and
 *               hot-reload the ConnectorManager so it takes effect immediately
 *
 * Security posture: this is a deliberate, narrow door through the ~/.cinderpaw
 * deny wall. Generic fs tools can never touch connectors.json (call-time deny
 * in tool-permissions.ts); this tool writes ONLY that one fixed path, through
 * the same row shape the ConnectorManager reads, and every call is audited by
 * the registry like any other tool. Secrets flow one way: in. `list` output
 * and `configure` results never contain secret values.
 */

import { readFile, mkdir } from "node:fs/promises";
import { atomicWriteFile } from "../../atomic-write.ts";
import { dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";
import { configPath, type ConnectorRow } from "../../transports/connectors.ts";

/**
 * What each supported connector needs to come alive, and how a person
 * actually gets it.
 *
 * `steps` exists because "bot token from the Discord Developer Portal"
 * is only useful to someone who has already been there. Without written
 * steps the model improvises the click path from training data, which
 * for a portal that changes its labels is how a user ends up on the
 * wrong page being told they are on the right one. These are checked
 * against the real portal and are the agent's source of truth; when the
 * portal moves, this list is the one place to fix.
 *
 * `consoleUrl` mirrors `crates/cinderpaw-core/src/connectors.rs` — the
 * Rust catalog has the URL for the settings UI, and the agent had no
 * way to read it, so it was guessing the address too.
 */
interface CatalogEntry {
  secrets: string[];
  note: string;
  consoleUrl?: string;
  steps?: string[];
}

const CATALOG: Record<string, CatalogEntry> = {
  discord: {
    secrets: ["DISCORD_TOKEN"],
    note: "Bot token from the Discord Developer Portal (Bot → Reset Token). The bot must be invited to the server with the Message Content intent enabled.",
    consoleUrl: "https://discord.com/developers/applications",
    steps: [
      "Open https://discord.com/developers/applications and sign in with your Discord account.",
      "Click 'New Application', give it a name (this is what the bot will be called), and accept the terms.",
      "Open the 'Bot' tab in the left sidebar.",
      "Under 'Privileged Gateway Intents', turn ON 'Message Content Intent' and save. Without it the bot can see that messages exist but not what they say.",
      "Click 'Reset Token', confirm, then 'Copy'. Discord shows this token exactly once — if you navigate away you have to reset it again.",
      "Paste the token in this chat. It goes straight to your OS keychain and is redacted from memory.",
      "Then open 'OAuth2' → 'URL Generator', tick 'bot', tick the 'Send Messages' and 'Read Message History' permissions, open the generated URL, and pick your server.",
    ],
  },
  slack: {
    secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    note: "Socket-mode app token (xapp-…) + bot token (xoxb-…) from api.slack.com/apps.",
    consoleUrl: "https://api.slack.com/apps",
    steps: [
      "Open https://api.slack.com/apps and click 'Create New App' → 'From scratch'. Name it and pick your workspace.",
      "Open 'Socket Mode' and turn it on. Slack asks for a token name; any name works. Copy the app-level token it gives you — it starts with 'xapp-'.",
      "Open 'OAuth & Permissions' → 'Bot Token Scopes' and add: chat:write, im:history, app_mentions:read.",
      "Scroll up on the same page and click 'Install to Workspace', then approve.",
      "Copy the 'Bot User OAuth Token' — it starts with 'xoxb-'.",
      "Paste both tokens in this chat. They go to your OS keychain and are redacted from memory.",
    ],
  },
  whatsapp: {
    secrets: [],
    note: "No secrets — pairing is QR-based. Enable it, then the user scans the QR code shown in the Cinderpaw app (Connectors page or TUI).",
    steps: [
      "There is nothing to copy and no token to fetch — WhatsApp pairs by QR code.",
      "Say the word and I'll enable it, then open the Connectors page in the Cinderpaw app.",
      "Scan the QR code there with WhatsApp on your phone: Settings → Linked devices → Link a device.",
    ],
  },
};

const redact = (row: ConnectorRow | undefined, id: string) => ({
  id,
  enabled: row?.enabled ?? false,
  configured: CATALOG[id]!.secrets.map((k) => ({
    secret: k,
    present: Boolean(row?.secrets?.[k]?.trim() || (id === "discord" && row?.token?.trim())),
  })),
  allowlist: row?.allowlist ?? [],
  channels: row?.channels ?? [],
  ...(row?.mode ? { mode: row.mode } : {}),
  requires: CATALOG[id]!.secrets,
  note: CATALOG[id]!.note,
  ...(CATALOG[id]!.consoleUrl ? { consoleUrl: CATALOG[id]!.consoleUrl } : {}),
  ...(CATALOG[id]!.steps ? { steps: CATALOG[id]!.steps } : {}),
});

async function readRows(): Promise<ConnectorRow[]> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as {
      connectors?: ConnectorRow[];
    };
    return Array.isArray(parsed.connectors) ? parsed.connectors : [];
  } catch {
    return []; // no file yet
  }
}

export function createConnectorsManageTool(
  manager: { reload(): Promise<void> },
): Tool {
  const manifest: ToolManifest = {
    name: "connectors_manage",
    description:
      "Configure YOUR OWN messaging connectors (Discord, Slack, WhatsApp) — the " +
      "accounts you yourself speak through. This does NOT configure any other " +
      "bot: if the user asks you to set up a different bot, this tool changes " +
      "you instead, and the usual result is that you go silent. Use action " +
      "'list' to see what's supported and what each needs; 'configure' with an " +
      "id (and secrets/allowlist if required) to connect or disconnect. Changes " +
      "apply immediately. Secrets are stored, never echoed. " +
      "When a user asks how to connect you to something, call 'list' FIRST and " +
      "walk them through the returned 'steps' verbatim — they are checked " +
      "against the real console and your own recollection of these portals is " +
      "probably out of date. Give the steps a few at a time, wait at the one " +
      "that says to paste a token, and never invent a step that isn't there.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "'list' or 'configure'.",
        required: true,
      },
      id: {
        type: "string",
        description: "Connector id (discord | slack | whatsapp). Required for 'configure'.",
        required: false,
      },
      enabled: {
        type: "boolean",
        description: "Turn the connector on/off (configure).",
        required: false,
      },
      secrets: {
        type: "object",
        description:
          "Secret values keyed by name, e.g. {\"DISCORD_TOKEN\":\"…\"}. Merged into the stored config (configure).",
        required: false,
        schema: { type: "object", additionalProperties: { type: "string" } },
      },
      allowlist: {
        type: "array",
        description:
          "The ONLY user ids this connector answers (configure). Not a filter on " +
          "top of an open door — it IS the door: an id that is not listed gets no " +
          "reply at all. An empty list therefore means NOBODY, not everyone, and " +
          "is refused. Send the full list you want, including yourself.",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      channels: {
        type: "array",
        description: "Channel ids the connector listens on (configure).",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
    },
    async execute(args) {
      const action = typeof args.action === "string" ? args.action : "";

      if (action === "list") {
        const rows = await readRows();
        return {
          ok: true,
          content: JSON.stringify(
            Object.keys(CATALOG).map((id) => redact(rows.find((r) => r.id === id), id)),
            null,
            2,
          ),
        };
      }

      if (action !== "configure") {
        return { ok: false, content: "action must be 'list' or 'configure'.", error: "bad_args" };
      }
      const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
      if (!CATALOG[id]) {
        return {
          ok: false,
          content: `unknown connector "${id}" — supported: ${Object.keys(CATALOG).join(", ")}`,
          error: "bad_args",
        };
      }

      const rows = await readRows();
      const row: ConnectorRow = rows.find((r) => r.id === id) ?? { id };
      if (typeof args.enabled === "boolean") row.enabled = args.enabled;
      if (args.secrets && typeof args.secrets === "object" && !Array.isArray(args.secrets)) {
        row.secrets = { ...row.secrets };
        for (const [k, v] of Object.entries(args.secrets as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) row.secrets[k] = v.trim();
        }
      }
      if (Array.isArray(args.allowlist)) {
        const next = (args.allowlist as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean);
        // An empty allowlist is not "everyone" — it is NOBODY.
        //
        // `ConnectorManager` builds `new Set(allowlist)` and answers only ids in
        // it, so clearing the list makes the connector deaf to every human,
        // including whoever is asking. This is not hypothetical: on 2026-08-14
        // this agent cleared its own Discord allowlist, announced "orice user
        // primește răspuns", and went silent for four hours. The only signal was
        // `(0 allowed)` in a log line nobody reads.
        //
        // Refused rather than corrected, because the two things the caller might
        // have meant — "let everyone in" and "lock it down" — are opposites, and
        // guessing between them is how the bot goes quiet again.
        if (next.length === 0 && (row.allowlist?.length ?? 0) > 0) {
          return {
            ok: false,
            content:
              `Refusing to empty ${id}'s allowlist. Empty does NOT mean "everyone" — ` +
              `the connector answers only ids on the list, so clearing it makes ${id} ` +
              `ignore every message, including yours, with no error anywhere. ` +
              `To keep it open to specific people, pass their ids. To take someone off, ` +
              `pass the list without them. Current list: ${JSON.stringify(row.allowlist)}.`,
            error: "would_lock_out",
          };
        }
        row.allowlist = next;
      }
      if (Array.isArray(args.channels)) {
        row.channels = (args.channels as unknown[]).filter((x): x is string => typeof x === "string");
      }

      const next = [...rows.filter((r) => r.id !== id), row];
      const file = configPath();
      await mkdir(dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ connectors: next }, null, 2));
      await manager.reload();

      const missing = CATALOG[id]!.secrets.filter(
        (k) => !row.secrets?.[k]?.trim() && !(id === "discord" && row.token?.trim()),
      );
      const state = redact(row, id);
      // An enabled connector with nobody on the allowlist is the failure this
      // whole file now guards against, and refusing it outright is not an
      // option: on a first connection the user may not know their own id yet,
      // and blocking here would leave them unable to connect at all. So it
      // saves, and says — in the result the model reads, not only in a log line
      // it never sees — that the bot it just brought online answers no one.
      const deaf = row.enabled && (row.allowlist?.length ?? 0) === 0;
      const hint =
        row.enabled && missing.length > 0
          ? ` Still missing secrets: ${missing.join(", ")} — the connector stays offline until provided.`
          : deaf
            ? ` WARNING: ${id} is online but its allowlist is EMPTY, which means it ` +
              `answers NOBODY — not "everyone". Ask the user for their ${id} user id ` +
              `and call configure again with allowlist:["<their id>"], or the bot will ` +
              `look connected and silently ignore every message, including theirs.`
            : id === "whatsapp" && row.enabled
              ? " WhatsApp pairs via QR — tell the user to scan the code in the Cinderpaw app (Connectors page or TUI)."
              : "";
      return {
        ok: true,
        content: `Saved and reloaded.${hint}\n${JSON.stringify(state, null, 2)}`,
        data: state,
      };
    },
  };
}
