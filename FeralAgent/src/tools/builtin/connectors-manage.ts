/**
 * connectors_manage — the agent's self-service door into its own connectors.
 *
 * Lets the agent connect itself to Discord / Slack / WhatsApp when the user
 * asks ("connect to my Discord, here's the token") instead of bouncing the
 * user to the settings UI. Two actions:
 *
 *   list      — supported connectors, what each needs, current state
 *               (secrets REDACTED to present/absent — never echoed back)
 *   configure — upsert one connector's row in ~/.feral/connectors.json and
 *               hot-reload the ConnectorManager so it takes effect immediately
 *
 * Security posture: this is a deliberate, narrow door through the ~/.feral
 * deny wall. Generic fs tools can never touch connectors.json (call-time deny
 * in tool-permissions.ts); this tool writes ONLY that one fixed path, through
 * the same row shape the ConnectorManager reads, and every call is audited by
 * the registry like any other tool. Secrets flow one way: in. `list` output
 * and `configure` results never contain secret values.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";
import { configPath, type ConnectorRow } from "../../transports/connectors.ts";

/** What each supported connector needs to come alive. */
const CATALOG: Record<string, { secrets: string[]; note: string }> = {
  discord: {
    secrets: ["DISCORD_TOKEN"],
    note: "Bot token from the Discord Developer Portal (Bot → Reset Token). The bot must be invited to the server with the Message Content intent enabled.",
  },
  slack: {
    secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    note: "Socket-mode app token (xapp-…) + bot token (xoxb-…) from api.slack.com/apps.",
  },
  whatsapp: {
    secrets: [],
    note: "No secrets — pairing is QR-based. Enable it, then the user scans the QR code shown in the Feral app (Connectors page or TUI).",
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
      "List or configure Feral's messaging connectors (Discord, Slack, WhatsApp). " +
      "Use action 'list' to see what's supported and what each needs; use " +
      "'configure' with an id (and secrets/allowlist if required) to connect or " +
      "disconnect. Changes apply immediately. Secrets are stored, never echoed.",
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
        description: "User ids/handles allowed to talk to the agent (configure). Empty = owner-only defaults per connector.",
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
        row.allowlist = (args.allowlist as unknown[]).filter((x): x is string => typeof x === "string");
      }
      if (Array.isArray(args.channels)) {
        row.channels = (args.channels as unknown[]).filter((x): x is string => typeof x === "string");
      }

      const next = [...rows.filter((r) => r.id !== id), row];
      const file = configPath();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ connectors: next }, null, 2), "utf8");
      await manager.reload();

      const missing = CATALOG[id]!.secrets.filter(
        (k) => !row.secrets?.[k]?.trim() && !(id === "discord" && row.token?.trim()),
      );
      const state = redact(row, id);
      const hint =
        row.enabled && missing.length > 0
          ? ` Still missing secrets: ${missing.join(", ")} — the connector stays offline until provided.`
          : id === "whatsapp" && row.enabled
            ? " WhatsApp pairs via QR — tell the user to scan the code in the Feral app (Connectors page or TUI)."
            : "";
      return {
        ok: true,
        content: `Saved and reloaded.${hint}\n${JSON.stringify(state, null, 2)}`,
        data: state,
      };
    },
  };
}
