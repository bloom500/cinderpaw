/**
 * extension_connect: the agent connects a service the person names, from any
 * chat, with no trip to Capabilities. The service gives a link for AI
 * assistants (an MCP server link) and usually a key; the agent passes both,
 * the person confirms on a card, and the service's tools appear as mcp_*.
 *
 * Asked 21 Oct: "if I give the agent everything in the chat, it should do it
 * itself; adding it by hand must be optional". Capabilities > Add your own
 * stays as the manual door; both write the same entry (customServer).
 *
 * Confirmation is not optional. A web page the agent read can say "connect
 * https://evil/mcp", and a connected server's tools describe themselves to
 * the model and receive whatever it sends them. Only an explicit "Connect"
 * from the person connects; no card, a timeout or anything else does not.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.ts";
import { customServer, type McpServerConfig } from "../../egress/mcp-manager.ts";

export interface ExtensionConnectDeps {
  addServer(entry: McpServerConfig): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }>;
}

const CONNECT = "Connect";

/** What to tell the person, from the status the service answered with. */
function nextStep(error: string): string {
  const e = error.toLowerCase();
  if (e.includes("http 401") || e.includes("http 403")) {
    return "The service refused the key. Ask the person to check it is complete, and that their plan with the service includes connecting AI assistants.";
  }
  if (e.includes("http 404") || e.includes("http 405")) {
    return "Nothing at that link answers AI assistants. Ask for the link the service's docs give for connecting one (it often ends in /mcp or /sse).";
  }
  return "The service could not be reached. Ask the person to check the link and their internet connection.";
}

export function createExtensionConnectTool(deps: ExtensionConnectDeps): Tool {
  return {
    manifest: {
      name: "extension_connect",
      description:
        "Connect a service the person asks for (Publora, Zapier, Notion...) by its link for AI assistants " +
        "(an MCP server link, from the service's docs or the person) and its key if it has one. The person " +
        "confirms on a card; then the service's abilities are your mcp_ tools. If the person already put the " +
        "key in the chat, pass it as key. If not, and request_secret with extension_url is available, use that " +
        "instead so the key never enters the chat; otherwise ask for it. Returns { connected, tools } or the reason.",
      permissions: [],
      networkAccess: true,
    },
    parameters: {
      url: { type: "string", description: "The service's link for AI assistants, https://...", required: true },
      name: { type: "string", description: "The service's name, e.g. Publora.", required: false },
      key: { type: "string", description: "The service's key or token, when the person gave it. Without 'Bearer'.", required: false },
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const entry = customServer(String(args.url ?? ""), String(args.key ?? ""), String(args.name ?? ""));
      if (typeof entry === "string") return { ok: false, content: entry };
      const host = new URL(entry.url!).hostname;
      if (!ctx.askUser) {
        return {
          ok: false,
          content: "needs_confirmation: this chat cannot ask the person to confirm. Tell them to add it in Capabilities > Add your own.",
        };
      }
      let answer: string | undefined;
      try {
        const [a] = await ctx.askUser.ask(
          [
            {
              question: `Connect ${entry.name} (${host})? Your assistant will be able to use what it offers, and send it what you ask it to do there.`,
              header: "Connect",
              options: [
                { label: CONNECT, description: `Add ${host} to your extensions.` },
                { label: "Not now", description: "Nothing is added." },
              ],
              multiSelect: false,
            },
          ],
          ctx.sessionId,
        );
        answer = a?.selected?.[0];
      } catch {
        answer = undefined;
      }
      if (answer !== CONNECT) {
        return {
          ok: true,
          content: JSON.stringify({ connected: false, reason: "person_declined", next: "Nothing was added. Do not retry unless the person asks again." }),
        };
      }
      const res = await deps.addServer(entry);
      if (!res.ok) {
        return { ok: true, content: JSON.stringify({ connected: false, reason: res.error.slice(0, 300), next: nextStep(res.error) }) };
      }
      return {
        ok: true,
        content: JSON.stringify({
          connected: true,
          tools: res.tools,
          next: "Tell the person it is connected and what it can now do. It also shows in Capabilities, where they can turn it off.",
        }),
      };
    },
  };
}
