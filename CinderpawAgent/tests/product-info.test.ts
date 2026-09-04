/**
 * product_info (2026-07-11) — the agent's bundled PRODUCT.md reference.
 * Guards the fix for "agent invents Cinderpaw features": the tool must exist,
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
    expect(content).toContain("cinderpaw setup");
    expect(content).toContain("/connectors add discord");
    expect(content).toContain("What is Cinderpaw");
    expect(content).toContain("cinderpaw doctor");
    // Bounded: PRODUCT.md must stay a cheap on-demand load, not a book.
    // 17 KiB, not 16: the rename added four characters to every occurrence of
    // the product's name and of every CINDERPAW_* variable, which pushed a file
    // whose CONTENT did not grow past the old cap. Raised once, deliberately —
    // if this needs raising again, something was actually added and the right
    // answer is to cut, not to raise.
    expect(content.length).toBeLessThan(17 * 1024);
  });
});
