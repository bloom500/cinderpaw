/**
 * install_skill_from_link: a link the person pasted becomes a skill only
 * through the host and the person's yes. What these pin:
 *   - only the URL goes to the host, and installing sends back the host's
 *     token, never content or a URL the agent picked after the question;
 *   - the person sees the source, the scan and the skill's text first;
 *   - a dangerous scan is refused without asking, and a "no" installs nothing.
 */

import { test, expect, describe } from "bun:test";
import { installSkillFromLinkTool } from "../src/tools/builtin/capability.ts";
import type { AskUserAnswer, AskUserQuestion } from "../src/types.ts";

const PREVIEW = {
  token: "t-123",
  meta: { id: "pdf-tools", name: "PDF Tools", description: "Splits and merges PDFs" },
  source: "github.com/acme/skills/pdf-tools/SKILL.md",
  content: "---\nname: PDF Tools\ndescription: Splits and merges PDFs\n---\nUse qpdf.",
  verdict: "safe",
  findings: [] as string[],
  left_out: [] as string[],
};

function bridgeWith(preview: unknown) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      async request(action: string, params: Record<string, unknown>) {
        calls.push({ action, params });
        if (action === "preview_link") return preview;
        if (action === "install_link") return { id: "pdf-tools" };
        return null;
      },
    },
  };
}

function answering(label: string, seen: AskUserQuestion[] = []) {
  return {
    async ask(questions: AskUserQuestion[]): Promise<AskUserAnswer[]> {
      seen.push(...questions);
      return [{ question: questions[0]!.question, selected: [label] }];
    },
    cancel() {},
  };
}

describe("install_skill_from_link", () => {
  test("yes installs the previewed token, and only the URL and the token cross", async () => {
    const { bridge, calls } = bridgeWith(PREVIEW);
    const seen: AskUserQuestion[] = [];
    const res = await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills/tree/main/pdf-tools" },
      { capabilities: bridge, askUser: answering("Install it", seen) } as never,
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { action: "preview_link", params: { url: "https://github.com/acme/skills/tree/main/pdf-tools" } },
      { action: "install_link", params: { token: "t-123" } },
    ]);
    // The person saw where it comes from, the scan, and the text itself.
    expect(seen[0]!.question).toContain(PREVIEW.source);
    expect(seen[0]!.question).toContain("found nothing wrong");
    expect(seen[0]!.preview).toContain("Use qpdf.");
    expect(seen[0]!.forceEscalate).toBe(true);
  });

  test("the person sees every line that is installed, and the agent's words as the agent's", async () => {
    const long = PREVIEW.content + "\n" + Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\nhidden at the end";
    const { bridge } = bridgeWith({ ...PREVIEW, content: long });
    const seen: AskUserQuestion[] = [];
    await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills", reason: "Official skill, verified by Cinderpaw." },
      { capabilities: bridge, askUser: answering("Not now", seen) } as never,
    );
    expect(seen[0]!.preview).toBe(long);
    expect(seen[0]!.question).toContain('The agent says: "Official skill, verified by Cinderpaw."');
  });

  test("no installs nothing", async () => {
    const { bridge, calls } = bridgeWith(PREVIEW);
    const res = await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills" },
      { capabilities: bridge, askUser: answering("Not now") } as never,
    );
    expect(res.error).toBe("declined");
    expect(calls.some((c) => c.action === "install_link")).toBe(false);
  });

  test("a dangerous scan is refused before anyone is asked", async () => {
    const { bridge, calls } = bridgeWith({ ...PREVIEW, verdict: "dangerous", findings: ["sends your SSH key to a server"] });
    const seen: AskUserQuestion[] = [];
    const res = await installSkillFromLinkTool.execute(
      { url: "https://github.com/evil/skill" },
      { capabilities: bridge, askUser: answering("Install it", seen) } as never,
    );
    expect(res.error).toBe("blocked_by_scan");
    expect(res.content).toContain("SSH key");
    expect(seen).toHaveLength(0);
    expect(calls.some((c) => c.action === "install_link")).toBe(false);
  });

  test("a caution scan and left-out files are said in the question", async () => {
    const { bridge } = bridgeWith({ ...PREVIEW, verdict: "caution", findings: ["runs curl"], left_out: ["scripts/run.sh"] });
    const seen: AskUserQuestion[] = [];
    await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills" },
      { capabilities: bridge, askUser: answering("Not now", seen) } as never,
    );
    expect(seen[0]!.question).toContain("Be careful");
    expect(seen[0]!.question).toContain("runs curl");
    // In words a person who has never seen a script still reads: what stays behind, and what that costs.
    expect(seen[0]!.question).toContain("Not installed with it: scripts/run.sh. The steps that need these files will not work here.");
  });

  test("files that come with the skill are named in the question, shown in full, and told to the agent", async () => {
    const files = [{ path: "reference/forms.md", content: "Fill each field by its name." }];
    const { bridge } = bridgeWith({ ...PREVIEW, files });
    const seen: AskUserQuestion[] = [];
    const res = await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills/tree/main/pdf-tools" },
      { capabilities: bridge, askUser: answering("Install it", seen) } as never,
    );
    expect(seen[0]!.question).toContain("1 more file(s) come with it: reference/forms.md");
    // What is installed is what the person read: SKILL.md and every file with it.
    expect(seen[0]!.preview).toContain("Use qpdf.");
    expect(seen[0]!.preview).toContain("--- reference/forms.md ---\nFill each field by its name.");
    expect(res.content).toContain("reference/forms.md");
  });

  test("replacing a skill already installed is said before the yes", async () => {
    const { bridge } = bridgeWith({ ...PREVIEW, replaces: true });
    const seen: AskUserQuestion[] = [];
    await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills" },
      { capabilities: bridge, askUser: answering("Not now", seen) } as never,
    );
    expect(seen[0]!.question).toContain('replaces the "pdf-tools" skill');
  });

  test("the host's reason a link cannot be used reaches the agent as it is", async () => {
    const bridge = {
      async request(): Promise<unknown> {
        throw new Error("This repo has 3 skills: a, b, c. Send the link to the one you want.");
      },
    };
    const res = await installSkillFromLinkTool.execute(
      { url: "https://github.com/acme/skills" },
      { capabilities: bridge, askUser: answering("Install it") } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("3 skills");
  });

  test("no way to ask → fails closed", async () => {
    const { bridge, calls } = bridgeWith(PREVIEW);
    const res = await installSkillFromLinkTool.execute({ url: "https://github.com/acme/skills" }, { capabilities: bridge } as never);
    expect(res.error).toBe("confirmation_unavailable");
    expect(calls.some((c) => c.action === "install_link")).toBe(false);
  });
});
