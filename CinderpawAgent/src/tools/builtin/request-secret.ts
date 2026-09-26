/**
 * request_secret (spec 2026-09-24 §6.2): ask the person for a connector
 * secret through a password card instead of the chat.
 *
 * A token pasted into the chat is part of the conversation: it is sent to the
 * AI provider before anything can redact it. With this tool the local web
 * page shows a password field, POSTs the value straight to the engine
 * (/runtime/connectors), and answers only "Saved" or "Cancel". The model gets
 * { field, saved }, checked against what was really stored.
 *
 * Surfaces that cannot show a card (the terminal chat, Discord, a call) get
 * `unsupported_surface`, and the agent falls back to the connector's steps.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.ts";
import { CATALOG, secretPresent } from "./connectors-manage.ts";
import { sessionHasCards } from "../../core/card-surface.ts";

export interface RequestSecretDeps {
  hasCards(sessionId: string): boolean;
  isPresent(connector: string, field: string): Promise<boolean>;
}

const SAVED = "Saved";
const CANCEL = "Cancel";

export function createRequestSecretTool(
  deps: RequestSecretDeps = { hasCards: sessionHasCards, isPresent: secretPresent },
): Tool {
  return {
    manifest: {
      name: "request_secret",
      description:
        "Ask the person for a connector secret (a bot token, an app password) in a secure field " +
        "instead of the chat. Use it every time a connector step says to paste or send a secret, " +
        "BEFORE asking for a paste: a secret typed into the chat reaches the AI service. Returns " +
        "{ field, saved }; you never see the value. If it returns unsupported_surface, this chat " +
        "cannot show the field: follow the connector's steps instead.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      purpose: { type: "string", description: "One short, friendly sentence the person sees above the field.", required: true },
      connector: { type: "string", description: "Connector id, as connectors_manage 'list' returns it.", required: true },
      field: { type: "string", description: "The secret's name from that connector's 'requires' list, e.g. DISCORD_TOKEN.", required: true },
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const connector = String(args.connector ?? "");
      const field = String(args.field ?? "");
      const purpose = String(args.purpose ?? "").trim() || `Your ${field}`;
      const entry = CATALOG[connector];
      if (!entry) return { ok: false, content: `unknown connector '${connector}'` };
      if (!entry.secrets.includes(field)) {
        return { ok: false, content: `'${connector}' has no secret '${field}'. It needs: ${entry.secrets.join(", ")}` };
      }
      if (!ctx.askUser || !deps.hasCards(ctx.sessionId)) {
        return { ok: false, content: "unsupported_surface: this chat cannot show a secure field. Follow the connector's steps." };
      }
      let answer: string | undefined;
      try {
        const [a] = await ctx.askUser.ask(
          [
            {
              question: purpose,
              header: "Secret",
              options: [{ label: SAVED, description: "The page saved it." }, { label: CANCEL, description: "Not now." }],
              multiSelect: false,
              secret: { connector, field },
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
      if (!(await deps.isPresent(connector, field))) {
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
