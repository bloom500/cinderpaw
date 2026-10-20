/**
 * design_guide — how to make a poster, flyer or post look made by a designer.
 *
 * 20 Oct: asked for a poster from the Artifacts page's Design tile, the agent
 * made one and said it had no design skill to follow. No skill is seeded on a
 * fresh install, so the guide ships inside the engine, like PRODUCT.md (Bun's
 * text import: `bun --compile` does not bundle loose .md files). Zero
 * permissions, drawered: the agent loads it when artifact_create says to.
 */

// @ts-expect-error: Bun's text import attribute, not typed by @types/bun yet.
import bundledDesign from "../../DESIGN.md" with { type: "text" };
import type { Tool, ToolManifest } from "../../types.ts";

export function createDesignGuideTool(): Tool {
  const manifest: ToolManifest = {
    name: "design_guide",
    description:
      "The design guide for a poster, flyer, invitation, social post, banner, thumbnail, slide or page mockup: " +
      "artboard sizes, layout, type, colour palettes and a checklist. Read it before making any design.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {},
    async execute() {
      return { ok: true, content: bundledDesign as string, data: { bytes: (bundledDesign as string).length } };
    },
  };
}
