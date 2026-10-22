/**
 * request_secret (spec 2026-09-24 §6.2): ask the person for a secret through a
 * password card instead of the chat.
 *
 * A token pasted into the chat is part of the conversation: it is sent to the
 * AI provider before anything can redact it. With this tool the card shows a
 * password field, saves the value itself (the web page POSTs it to the engine,
 * the desktop app stores it through the host), and answers only "Saved" or
 * "Cancel". The model gets { field, saved }, checked against what was really
 * stored.
 *
 * Two kinds of secret: a connector's (Discord token, ...), and the key of a
 * service added by its link for AI assistants (Publora, ...). Saving the
 * second one connects the service; only the desktop app can do that.
 *
 * Surfaces that cannot show a card (the terminal chat, Discord, a call) get
 * `unsupported_surface`, and the agent falls back to the connector's steps.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.ts";
import { CATALOG, secretPresent } from "./connectors-manage.ts";
import { sessionCardSurface, type CardSurface } from "../../core/card-surface.ts";
import { loadMcpConfig } from "../../egress/mcp-manager.ts";

export interface RequestSecretDeps {
  cardSurface(sessionId: string): CardSurface | undefined;
  isPresent(connector: string, field: string): Promise<boolean>;
  extensionHasKey(url: string): boolean;
}

const SAVED = "Saved";
const CANCEL = "Cancel";

/** Did the host save a key for this link? Compared as the host stores it. */
function extensionHasKey(url: string): boolean {
  return loadMcpConfig().some((s) => !!s.url && s.url === url && !!s.headers?.Authorization);
}

export function createRequestSecretTool(
  deps: RequestSecretDeps = { cardSurface: sessionCardSurface, isPresent: secretPresent, extensionHasKey },
): Tool {
  return {
    manifest: {
      name: "request_secret",
      description:
        "Ask the person for a secret in a secure field instead of the chat. Use it every time a step says " +
        "to paste or send a secret, BEFORE asking for a paste: a secret typed into the chat reaches the AI " +
        "service. Two uses: (1) a connector's secret: pass connector + field; (2) connecting a service that " +
        "gave the person a link for AI assistants (an MCP server link) and a key: pass extension_url (and " +
        "extension_name); saving it connects the service and its abilities appear as your mcp_ tools. " +
        "Returns { field, saved }; you never see the value. If it returns unsupported_surface, this chat " +
        "cannot show the field: follow the connector's steps, or for a service, tell the person to add it " +
        "in Capabilities > Add your own.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      purpose: { type: "string", description: "One short, friendly sentence the person sees above the field.", required: true },
      connector: { type: "string", description: "Connector id, as connectors_manage 'list' returns it. Not with extension_url.", required: false },
      field: { type: "string", description: "The secret's name from that connector's 'requires' list, e.g. DISCORD_TOKEN.", required: false },
      extension_url: { type: "string", description: "The service's link for AI assistants, exactly as the person or the service's docs give it (https://...).", required: false },
      extension_name: { type: "string", description: "The service's name, e.g. Publora.", required: false },
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const extensionRaw = String(args.extension_url ?? "").trim();
      const connector = String(args.connector ?? "");
      let field = String(args.field ?? "");
      let secret: { connector: string; field: string } | { extensionUrl: string; extensionName?: string };
      let present: () => Promise<boolean>;
      const surface = deps.cardSurface(ctx.sessionId);

      if (extensionRaw) {
        let url: URL;
        try {
          url = new URL(extensionRaw);
        } catch {
          return { ok: false, content: `'${extensionRaw}' is not a link. Ask the person for the whole link, starting with https://` };
        }
        if (!ctx.askUser || surface !== "text") {
          return {
            ok: false,
            content:
              "unsupported_surface: this chat cannot keep the key out of the conversation. Let the person " +
              "choose: paste the key here and you call extension_connect with it, or add the service " +
              "themselves in Capabilities > Add your own.",
          };
        }
        field = "key";
        const name = String(args.extension_name ?? "").trim();
        secret = { extensionUrl: url.href, ...(name ? { extensionName: name } : {}) };
        present = async () => deps.extensionHasKey(url.href);
      } else {
        const entry = CATALOG[connector];
        if (!entry) {
          return {
            ok: false,
            content:
              `unknown connector '${connector}'. If this is a service with a link for AI assistants, ` +
              "call request_secret again with extension_url instead.",
          };
        }
        if (!entry.secrets.includes(field)) {
          return { ok: false, content: `'${connector}' has no secret '${field}'. It needs: ${entry.secrets.join(", ")}` };
        }
        if (!ctx.askUser || !surface) {
          return { ok: false, content: "unsupported_surface: this chat cannot show a secure field. Follow the connector's steps." };
        }
        secret = { connector, field };
        present = () => deps.isPresent(connector, field);
      }

      const purpose = String(args.purpose ?? "").trim() || `Your ${field}`;
      let answer: string | undefined;
      try {
        const [a] = await ctx.askUser.ask(
          [
            {
              question: purpose,
              header: "Secret",
              options: [{ label: SAVED, description: "The page saved it." }, { label: CANCEL, description: "Not now." }],
              multiSelect: false,
              secret,
            },
          ],
          ctx.sessionId,
        );
        answer = a?.selected?.[0];
      } catch {
        answer = undefined; // dismissed, cancelled, or the page went away
      }
      if (answer !== SAVED) {
        // Seen live: on a bare { saved: false } the agent decided the field was
        // broken and asked for the token in the chat instead. Say what happened.
        return {
          ok: true,
          content: JSON.stringify({
            field,
            saved: false,
            reason: "person_declined",
            next: "The person chose not to enter it now. Do not ask for it in the chat. Say it is fine, and offer the secure field again when they are ready.",
          }),
        };
      }
      if (!(await present())) {
        return {
          ok: true,
          content: JSON.stringify({
            field,
            saved: false,
            reason: "not_stored",
            next: "The page said it saved, but nothing is stored. Call request_secret again. Do not ask for it in the chat.",
          }),
        };
      }
      return { ok: true, content: JSON.stringify({ field, saved: true }) };
    },
  };
}
