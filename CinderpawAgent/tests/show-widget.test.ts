import { describe, expect, test } from "bun:test";
import { createShowWidgetTool, validateWidget } from "../src/tools/builtin/show-widget.ts";

const tool = createShowWidgetTool();
const run = (args: Record<string, unknown>) => tool.execute(args, {} as never);

describe("show_widget", () => {
  test("a valid widget comes back as data, normalised", async () => {
    const r = await run({
      kind: "facts", title: "Trip",
      items: [{ label: "Days", value: 5, icon: "calendar" }, { label: "Budget", value: "€900", icon: "rocket" }],
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      kind: "facts", title: "Trip",
      items: [{ label: "Days", value: "5", icon: "calendar" }, { label: "Budget", value: "€900" }],
    });
  });

  test("invalid data returns the text fallback, not an error", async () => {
    const r = await run({ kind: "table", title: "Laptops", columns: [{ title: "A" }], rows: [{ label: "RAM", cells: ["16 GB"] }] });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual({ kind: "list", title: "Laptops", lines: ["A", "RAM · 16 GB"] });
  });

  test("an unknown kind is a fallback too", async () => {
    const r = await run({ kind: "map", text: "Lisbon" });
    expect(r.ok).toBe(true);
    expect((r.data as { kind: string }).kind).toBe("list");
  });

  test("each kind keeps to its shape", () => {
    expect(validateWidget({ kind: "progress", done: 3, total: 4, label: "Booked" })).not.toBeNull();
    expect(validateWidget({ kind: "progress", done: 5, total: 4, label: "Booked" })).toBeNull();
    expect(validateWidget({ kind: "checklist", items: [{ text: "Flights", done: true }] })).not.toBeNull();
    expect(validateWidget({ kind: "checklist", items: [{ text: "Flights", done: "yes" }] })).toBeNull();
    expect(validateWidget({ kind: "breakdown", items: [{ label: "Rent", value: -1 }] })).toBeNull();
    expect(validateWidget({ kind: "verdict", text: "Take the Air." })).toEqual({ kind: "verdict", title: undefined, text: "Take the Air." });
    const cards = validateWidget({ kind: "cards", items: [{ title: "A", image: "http://x/a.png" }, { title: "B", url: "https://b.example" }] });
    // Only https reaches the app; a plain http image is dropped, the card stays.
    expect(cards).toEqual({ kind: "cards", title: undefined, items: [{ title: "A" }, { title: "B", url: "https://b.example" }] });
  });
});
