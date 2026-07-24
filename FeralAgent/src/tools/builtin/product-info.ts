/**
 * product_info — the agent's factual reference about Feral itself.
 *
 * End users ask the agent "what can you do?", "how do I connect Discord?",
 * "how does onboarding work?" — before this tool the model guessed (and
 * invented ConnectorManager APIs, sandbox walls, etc.). The knowledge lives
 * in PRODUCT.md, bundled into the binary at build time via Bun's text-import
 * attribute (same pattern as SOUL.md — bun --compile does NOT bundle loose
 * .md files, see soul-loader.ts).
 *
 * Core-tier tool (always advertised) with zero permissions: no fs, no
 * network — the content is a compile-time string.
 */

// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import bundledProduct from "../../PRODUCT.md" with { type: "text" };
import type { Tool, ToolManifest } from "../../types.ts";

export function createProductInfoTool(): Tool {
  const manifest: ToolManifest = {
    name: "product_info",
    description:
      "Load Feral's product documentation: what Feral is, setup/onboarding, " +
      // Telegram is NOT implemented (connectors.ts has Discord, Slack and
      // WhatsApp only; PRODUCT.md says "coming soon"). Listing it here made the
      // agent promise users a connector that does not exist.
      "connectors (Discord/WhatsApp/Slack), models & providers, " +
      "memory/dreams/LoRA, slash commands, CLI commands, troubleshooting. " +
      "ALWAYS call this before answering questions about Feral itself — " +
      "answer from the document, never from guesses.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {},
    async execute() {
      return {
        ok: true,
        content: bundledProduct as string,
        data: { bytes: (bundledProduct as string).length },
      };
    },
  };
}
