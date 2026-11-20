import { expect, test } from "bun:test";
import { createSetAppearanceTool } from "../src/tools/builtin/set-appearance.ts";

test("'make it dark' hands the app a theme it knows, and refuses one it does not", async () => {
  const tool = createSetAppearanceTool();
  const ok = await tool.execute({ theme: "Dark", chatTextSize: "large" }, {} as never);
  expect(ok.ok).toBe(true);
  expect(ok.data).toEqual({ appearance: { theme: "dark", chatTextSize: "large" } });
  expect((await tool.execute({ theme: "violet" }, {} as never)).ok).toBe(false);
  expect((await tool.execute({}, {} as never)).ok).toBe(false);
});
