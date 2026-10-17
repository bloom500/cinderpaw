import { describe, expect, it } from "bun:test";
import {
  createArtifactDraftTracker,
  readPartialJson,
  type DraftUpdate,
} from "../src/core/artifact-draft.ts";

describe("readPartialJson", () => {
  it("keeps an unterminated string", () => {
    expect(readPartialJson('{"title":"Pl')).toEqual({ title: "Pl" });
  });

  it("drops an escape that has not finished arriving", () => {
    expect(readPartialJson('{"content":"a\\')).toEqual({ content: "a" });
    expect(readPartialJson('{"content":"\\u00')).toEqual({ content: "" });
  });

  it("drops half of a surrogate pair until the other half arrives", () => {
    expect(readPartialJson('{"content":"\\ud83d')).toEqual({ content: "" });
    expect(readPartialJson('{"content":"\\ud83d\\ude00')).toEqual({ content: "😀" });
  });

  it("drops an unfinished number, literal or key", () => {
    expect(readPartialJson('{"a":1,"b":tr')).toEqual({ a: 1 });
    expect(readPartialJson('{"a":12')).toEqual({});
    expect(readPartialJson('{"a":"x","ti')).toEqual({ a: "x" });
  });

  it("reads a complete value and ignores what follows it", () => {
    expect(readPartialJson('{"name":"x","args":{"t":"y"}}\n</tool_call>')).toEqual({
      name: "x",
      args: { t: "y" },
    });
  });

  it("decodes escapes and keeps Romanian letters", () => {
    expect(readPartialJson('{"c":"a\\nb \\"q\\" ăîșț"}')).toEqual({ c: 'a\nb "q" ăîșț' });
  });

  it("reads through nested arrays and objects it does not need", () => {
    expect(readPartialJson('{"x":[1,{"y":"z"}],"title":"T"')).toEqual({ x: [1, { y: "z" }], title: "T" });
  });
});

function collect(): { updates: DraftUpdate[]; tracker: ReturnType<typeof createArtifactDraftTracker> } {
  const updates: DraftUpdate[] = [];
  return { updates, tracker: createArtifactDraftTracker("0", (u) => updates.push(u)) };
}

describe("createArtifactDraftTracker", () => {
  it("opens on first sight, then sends only what was added", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", "");
    tracker.fromArgs(0, "artifact_create", '{"kind":"markdown","title":"Plan","content":"Hel');
    tracker.fromArgs(0, "artifact_create", '{"kind":"markdown","title":"Plan","content":"Hello"}');
    expect(updates[0]).toEqual({ draft: "0:0", append: "" });
    expect(updates[1]).toEqual({ draft: "0:0", kind: "markdown", title: "Plan", append: "Hel" });
    expect(updates[2]).toEqual({ draft: "0:0", kind: "markdown", title: "Plan", append: "lo" });
    expect(updates.map((u) => u.append).join("")).toBe("Hello");
  });

  it("says nothing when nothing changed", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", '{"title":"T","content":"ab');
    tracker.fromArgs(0, "artifact_create", '{"title":"T","content":"ab');
    expect(updates).toHaveLength(1);
  });

  it("ignores every other tool", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "web_search", '{"query":"x"}');
    tracker.fromText('<tool_call>\n{"name": "web_search", "args": {"query": "x"');
    expect(updates).toEqual([]);
  });

  it("works when the content comes before the title", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(1, "artifact_create", '{"content":"Body","title":"La');
    tracker.fromArgs(1, "artifact_create", '{"content":"Body","title":"Later","kind":"app"}');
    expect(updates[0]).toEqual({ draft: "0:1", title: "La", append: "Body" });
    expect(updates[1]).toEqual({ draft: "0:1", kind: "app", title: "Later", append: "" });
  });

  it("never sends a backslash from an escape split across two deltas", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", '{"content":"a\\');
    tracker.fromArgs(0, "artifact_create", '{"content":"a\\nb');
    expect(updates.map((u) => u.append).join("")).toBe("a\nb");
  });

  it("reads a tool call the model wrote as text", () => {
    const { updates, tracker } = collect();
    tracker.fromText('Sure.<tool_call>\n{"name": "artifact_create", "args": {"kind":"markdown","title":"T","content":"ab');
    tracker.fromText('Sure.<tool_call>\n{"name": "artifact_create", "args": {"kind":"markdown","title":"T","content":"abc"}}\n</tool_call>');
    expect(updates[0]).toEqual({ draft: "0:t0", kind: "markdown", title: "T", append: "ab" });
    expect(updates[1]).toEqual({ draft: "0:t0", kind: "markdown", title: "T", append: "c" });
  });

  it("still opens for a tool-call shape it cannot read", () => {
    const { updates, tracker } = collect();
    tracker.fromText('<invoke name="artifact_create"><parameter name="content">Hel');
    expect(updates).toEqual([{ draft: "0:t0", append: "" }]);
  });
});
