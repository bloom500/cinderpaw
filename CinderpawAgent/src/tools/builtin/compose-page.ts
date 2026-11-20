/**
 * compose_page (spec 4.14, slice 10): the model writes a page of cards once,
 * as data; Pages checks it and every card then updates from its source with no
 * model call. Owner-only (tiers.ts). The page shows on My day.
 */
import type { CronJob, Tool, ToolResult } from "../../types.ts";
import { checkPage, LIMITS, PIECES, type Pages } from "../../core/pages.ts";

export function createComposePageTool(pages: Pages, jobs: () => CronJob[]): Tool {
  return {
    manifest: {
      name: "compose_page",
      description:
        "Make a small page of cards for the person, shown on their My day page, when they ask for one place to follow " +
        "something (\"help me with my thesis: papers, the deadline, the grades\", \"a page for my shop's prices\"). " +
        `Pieces: number_over_time (a price watch's reads with its limit), before_after (a price watch: first read vs now), ` +
        `countdown (a date, or a task's next run), done_with_proof (a task's last runs), your_numbers (how often you wrote ` +
        `first this week and how often they answered), plain_list (up to ${LIMITS.items} short lines you write once), ` +
        `question (one yes-or-no question in ask; they answer with Yes or Not now, and you read it by calling with no arguments). ` +
        "A source is a watch or task id from tasks_list; it must already exist (a task you only offered with " +
        "suggest_task exists once they accept it). Labels are in the person's words and units, never a field name. " +
        `Up to ${LIMITS.cards} cards. remove: a page id to delete it. With no arguments: their pages, with ids and answers. ` +
        "A recipe someone shares (JSON with \"recipe\": \"cinderpaw-page/1\") has blanks instead of sources: ask the person " +
        "which of their tasks or watches fills each blank, then compose it; a recipe never creates a task by itself.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      title: { type: "string", description: `Page title, up to ${LIMITS.title} characters.`, required: false },
      cards: {
        type: "array",
        description: "The cards, in order: { piece, label, source?: { kind: \"watch\"|\"task\", id }, date?: ISO, items?: string[] }.",
        required: false,
        schema: { type: "array", items: { type: "object", properties: {
          piece: { type: "string", enum: [...PIECES] }, label: { type: "string" },
          source: { type: "object", properties: { kind: { type: "string", enum: ["watch", "task"] }, id: { type: "string" } } },
          date: { type: "string" }, items: { type: "array", items: { type: "string" } }, ask: { type: "string" },
        }, required: ["piece", "label"] } },
      },
      remove: { type: "string", description: "The id of a page to delete.", required: false },
    },
    async execute(args): Promise<ToolResult> {
      if (typeof args.remove === "string") {
        return pages.remove(args.remove) ? { ok: true, content: "Removed the page." } : { ok: false, content: "", error: "No page with that id." };
      }
      if (args.title === undefined && args.cards === undefined) {
        const all = pages.list();
        if (!all.length) return { ok: true, content: "They have no pages yet." };
        return { ok: true, content: JSON.stringify(all.map(({ id, page }) => ({ id, title: page.title,
          cards: page.cards.map((c) => ({ piece: c.piece, label: c.label, ...(c.piece === "question" ? { ask: c.ask, answer: c.answer ?? "not answered yet" } : {}) })) })), null, 2) };
      }
      const r = checkPage({ title: args.title, cards: args.cards }, jobs());
      if ("error" in r) return { ok: false, content: "", error: r.error };
      const id = pages.add(r.page);
      return { ok: true, content: `Made the page "${r.page.title}" (id ${id}) with ${r.page.cards.length} cards. It is on their My day page and updates by itself.` };
    },
  };
}
