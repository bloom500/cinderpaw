import { describe, expect, it } from "bun:test";
import { createDesignGuideTool } from "../src/tools/builtin/design-guide.ts";
import { createArtifactCreateTool } from "../src/tools/builtin/artifact.ts";
import { EXTENDED_TOOLS } from "../src/tools/tiers.ts";

describe("design_guide: what a poster is made from (20 Oct)", () => {
  it("hands the whole guide over, from a fresh install with no skills", async () => {
    const r = await createDesignGuideTool().execute({}, {} as never);
    expect(r.ok).toBe(true);
    const guide = String(r.content);
    expect(guide).toContain("1080 x 1350"); // the artboard table
    expect(guide).toContain("class=\"artboard\""); // the scale-to-fit skeleton
    expect(guide).toContain("Before you save: the checklist");
    expect(guide).not.toMatch(/https?:\/\/(?!www\.w3)/); // nothing it could try to load
  });

  it("is found when a design is asked for, and artifact_create sends the agent to it", () => {
    expect(createDesignGuideTool().manifest.description.split(".")[0]).toMatch(/poster/);
    expect(EXTENDED_TOOLS.has("design_guide")).toBe(true);
    const create = createArtifactCreateTool({ db: {} as never, store: { root: "." } as never, workspaceRoots: [] });
    expect(create.manifest.description).toContain("design_guide");
  });
});
