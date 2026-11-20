import type { Tool } from "../../types.ts";
import type { CoworkAgentInput } from "../../cowork/agent-store.ts";
import { TEAMMATE_DEFAULT_TOOLS } from "./cowork-create.ts";

type ProposedTeammate = Required<Pick<CoworkAgentInput, "name" | "role" | "instructions" | "tools">>;

interface SuggestTeamDeps {
  latestUserText: (sessionId: string) => string | undefined;
  isOwner: (sessionId: string) => boolean;
  hasTeammates: () => boolean;
  create: (team: ProposedTeammate[]) => void;
}

export function statesTeamNeed(text: string): boolean {
  const normalized = text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (/\b(?:i (?:use|plan to use|want to use|would use|mostly need|mainly need)|my (?:daily|weekly) work|folosesc)\b/u.test(normalized)) return true;

  // Recognize a request to investigate a topic, rather than a mention of research.
  const task = normalized.replace(/^(?:please|te rog)[, ]+/u, "")
    .replace(/^(?:can you|could you|i want(?: you to)?|i'd like(?: you to)?|poti sa|vreau(?: sa)?|sa)\s+/u, "");
  const request = task.match(/^(?:(?:do|conduct|run|make|faci|fa)\s+)?(?:(?:some|a|an|un|o)\s+)?(?:in-depth\s+|detailed\s+)?(?:research|investigate|investigation|cerceteaza|cercetare|analiza detaliata)\s+(.+)$/su);
  if (request?.[1] && !/^(?:is|was|shows|means|says|suggests|papers?\b|studies\b)/u.test(request[1])) {
    return request[1].split(/\s+/u).length >= 4;
  }
  // A comparison with explicit evidence or criteria also gives a colleague a concrete job.
  return /^(?:compare|compara|find|gaseste)\s+/u.test(task)
    && /\b(?:sources?|citations?|evidence|surse|dovezi|pricing|reviews?|revenue|venituri|preturi)\b/u.test(normalized)
    && normalized.split(/\s+/u).length >= 8;
}

function readTeammate(value: unknown): ProposedTeammate | null {
  if (!value || typeof value !== "object") return null;
  const { name, role, instructions, tools } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.length > 32 || /[\r\n]/.test(name)) return null;
  if (typeof role !== "string" || !role.trim() || role.length > 80 || /[\r\n]/.test(role)) return null;
  if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 600) return null;
  if (!Array.isArray(tools) || tools.length > 4 || tools.some((tool) => !TEAMMATE_DEFAULT_TOOLS.includes(tool))) return null;
  return { name: name.trim(), role: role.trim(), instructions: instructions.trim(), tools: [...new Set(tools)] };
}

export function createSuggestTeamTool(deps: SuggestTeamDeps): Tool {
  // One proposal at a time, including when the same owner has a chat app open.
  let pending = false;
  const offered = new Set<string>();
  return {
    manifest: {
      name: "suggest_team",
      description: "Offer a named colleague for a concrete research job, or one or two teammates for the person's stated ongoing work, when the roster is empty. Give each a role tied to the task and quote the person's latest request exactly. Ask through this tool before creating anyone. If they choose Not now, continue the task yourself.",
      permissions: [],
      networkAccess: false,
      timeoutMs: 10 * 60_000,
    },
    parameters: {
      need: { type: "string", required: true, description: "Exact quote from the latest user message requesting the research or describing ongoing work." },
      teammates: { type: "array", required: true, description: "One or two teammates. Each has name, role, instructions, and tools (up to four read-only tool names, or [] to just answer).", schema: {
        type: "array", minItems: 1, maxItems: 2, items: {
          type: "object", required: ["name", "role", "instructions", "tools"], additionalProperties: false,
          properties: {
            name: { type: "string" }, role: { type: "string" }, instructions: { type: "string" },
            tools: { type: "array", maxItems: 4, items: { type: "string", enum: TEAMMATE_DEFAULT_TOOLS } },
          },
        },
      } },
    },
    async execute(args, ctx) {
      const sessionId = ctx.sessionId;
      const source = deps.latestUserText(sessionId);
      const need = typeof args.need === "string" ? args.need.trim() : "";
      if (!deps.isOwner(sessionId) || !ctx.askUser || !source?.includes(need) || !statesTeamNeed(need) || need.split(/\s+/).length < 4) {
        return { ok: false, content: "Offer teammates only for research the person requested or ongoing work they described." };
      }
      if (pending || offered.has(sessionId) || deps.hasTeammates()) {
        return { ok: false, content: "No team offer is needed here." };
      }
      if (!Array.isArray(args.teammates) || args.teammates.length < 1 || args.teammates.length > 2) {
        return { ok: false, content: "Offer one or two teammates." };
      }
      const team = args.teammates.map(readTeammate).filter((item): item is ProposedTeammate => item !== null);
      if (team.length !== args.teammates.length) return { ok: false, content: "Each teammate needs a name, a role, instructions, and up to four read-only tools." };

      const question = `I can make ${team.map((item) => `${item.name} (${item.role})`).join(" and ")}. Make ${team.length === 1 ? "this teammate" : "them"}?`;
      pending = true;
      offered.add(sessionId);
      if (offered.size > 128) offered.delete(offered.values().next().value!);
      try {
        const [answer] = await ctx.askUser.ask([{
          question, options: [{ label: "Yes" }, { label: "Not now" }], multiSelect: false,
          forceEscalate: true, fixedOptions: true,
        }], sessionId);
        if (ctx.signal?.aborted || !deps.isOwner(sessionId) || deps.hasTeammates()
          || answer?.question !== question || answer.selected.length !== 1 || answer.selected[0] !== "Yes" || answer.customText) {
          return { ok: true, content: "No teammates were made. Keep helping the person." };
        }
        deps.create(team);
        return { ok: true, content: `Made ${team.map(({ name }) => name).join(" and ")}. You can talk to them in the sidebar.`, data: { teamCreated: true } };
      } catch {
        return { ok: false, content: "No teammates were made." };
      } finally {
        pending = false;
      }
    },
  };
}
