/**
 * Memory hygiene — the facts extractor must not store junk keys.
 *
 * Observed in production (~/.feral/agent/feral.db, semantic table): the old
 * colon-split parser stored keys like "- language", "1. user shared a link",
 * "we need to produce final answer", and "- the user has a project at `d"
 * (a Windows path split at the drive-letter colon). These polluted the
 * memory graph and made `forget` unusable because keys were unguessable.
 */
import { describe, it, expect } from "bun:test";
import { sanitizeFact } from "../src/memory/extractor.ts";

describe("sanitizeFact", () => {
  it("accepts a clean key: value line", () => {
    expect(sanitizeFact("name", "Darius")).toEqual({ key: "name", value: "Darius" });
    expect(sanitizeFact("preferred_language", "Romanian")).toEqual({
      key: "preferred_language",
      value: "Romanian",
    });
  });

  it("strips list markers from keys instead of storing them", () => {
    expect(sanitizeFact("- language", "Romanian")).toEqual({
      key: "language",
      value: "Romanian",
    });
    expect(sanitizeFact("* os", "Windows")).toEqual({ key: "os", value: "Windows" });
    expect(sanitizeFact("1. location", "Romania")).toEqual({
      key: "location",
      value: "Romania",
    });
  });

  it("rejects sentence-shaped keys (reasoning leakage)", () => {
    expect(sanitizeFact("we need to produce final answer", "either facts or NONE")).toBeNull();
    expect(sanitizeFact("the user's messages", "minimal")).toBeNull();
    expect(sanitizeFact("the user is working with a git repository (path", "D")).toBeNull();
  });

  it("rejects role names as keys", () => {
    for (const role of ["user", "assistant", "model", "bot", "system"]) {
      expect(sanitizeFact(role, "anything")).toBeNull();
    }
  });

  it("rejects drive-letter colon splits (value starts with backslash)", () => {
    expect(
      sanitizeFact("the user has a project at `d", "\\FeralLocalAI`"),
    ).toBeNull();
    expect(sanitizeFact("workspace at c", "\\Users\\Darius\\.feral\\workspace\\")).toBeNull();
  });

  it("rejects keys with quotes or JSON/markup fragments", () => {
    expect(sanitizeFact('paths like "allowedpaths"', "d")).toBeNull();
    expect(sanitizeFact("<think>the user is asking", "x")).toBeNull();
  });

  it("rejects values that contain thinking markup", () => {
    expect(sanitizeFact("assistant_state", "<think>Let me reason")).toBeNull();
  });

  it("rejects overlong keys", () => {
    expect(sanitizeFact("a".repeat(41), "x")).toBeNull();
  });
});
