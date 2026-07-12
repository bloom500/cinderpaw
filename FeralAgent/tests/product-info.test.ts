/**
 * product_info (2026-07-11) — the agent's bundled PRODUCT.md reference.
 * Guards the fix for "agent invents Feral features": the tool must exist,
 * carry zero permissions, and return the real document with the sections
 * the agent needs to answer end-user questions (connectors, setup, commands).
 */
import { describe, expect, test } from "bun:test";
import { createProductInfoTool } from "../src/tools/builtin/product-info";
import { isCoreTool } from "../src/tools/tiers";

describe("product_info", () => {
  const tool = createProductInfoTool();

  test("manifest: zero permissions, no network, core tier", () => {
    expect(tool.manifest.name).toBe("product_info");
    expect(tool.manifest.permissions).toEqual([]);
    expect(tool.manifest.networkAccess).toBe(false);
    expect(isCoreTool("product_info")).toBe(true);
  });

  test("returns the bundled PRODUCT.md with the key sections", async () => {
    const res = await tool.execute({}, {
      manifest: tool.manifest,
      sessionId: "test",
    } as never);
    expect(res.ok).toBe(true);
    const content = res.content;
    // Anchor sections the agent needs for the observed failure cases:
    // "help me with onboarding" and "connect me to Discord".
    expect(content).toContain("feral setup");
    expect(content).toContain("/connectors add discord");
    expect(content).toContain("What is Feral");
    expect(content).toContain("feral doctor");
    // Bounded: PRODUCT.md must stay a cheap on-demand load, not a book.
    expect(content.length).toBeLessThan(16 * 1024);
  });
});
