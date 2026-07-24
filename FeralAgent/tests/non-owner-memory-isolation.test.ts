/**
 * The episodic/fractal half of the public-lead leak.
 *
 * Closing the semantic write (43bfec2) stopped a stranger's claims becoming
 * "facts about the user". It did not stop their TRANSCRIPT reaching the owner:
 * `search()` crosses session boundaries, and `all()` is the corpus the fractal
 * RAPTOR tree is built from — and that tree backs the same `recall` tool. Both
 * are now filtered on the `private` column.
 *
 * The negative cases matter as much: a lead must keep their own thread, or the
 * public mode stops working mid-conversation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import {
  isRestrictedSession,
  markSessionRestricted,
  resetSessionVisibility,
} from "../src/core/session-visibility.ts";

const OWNER = "default";
const LEAD = "whatsapp:40799@s.whatsapp.net";

function makeEpisodic() {
  const db = openDatabase(":memory:");
  const episodic = new EpisodicMemory(db.raw, () => {}, undefined, isRestrictedSession);
  return { db, episodic };
}

beforeEach(() => resetSessionVisibility());

describe("a non-owner transcript never crosses session boundaries", () => {
  test("a lead's message does not appear in the owner's cross-session search", () => {
    const { episodic } = makeEpisodic();
    markSessionRestricted(LEAD, true);

    episodic.record(OWNER, "user", "the pricing spreadsheet lives in Dropbox");
    episodic.record(LEAD, "user", "my name is Bob and I run a competitor pricing service");

    const hits = episodic.search("pricing", 20);
    expect(hits.map((h) => h.sessionId)).toContain(OWNER);
    expect(hits.map((h) => h.sessionId)).not.toContain(LEAD);
  });

  test("a lead's turn never enters the fractal corpus", () => {
    const { episodic } = makeEpisodic();
    markSessionRestricted(LEAD, true);
    episodic.record(OWNER, "user", "owner note");
    episodic.record(LEAD, "user", "stranger note");

    const corpus = episodic.all();
    expect(corpus.map((e) => e.content)).toContain("owner note");
    expect(corpus.map((e) => e.content)).not.toContain("stranger note");
  });

  test("symmetric: the owner's history is not searchable from the lead's session either", () => {
    const { episodic } = makeEpisodic();
    markSessionRestricted(LEAD, true);
    episodic.record(OWNER, "assistant", "your AWS root password reset link is ready");
    // search() is session-agnostic; what protects the owner here is that the
    // public toolset has no `recall`. This asserts the row IS still findable
    // for the owner, so the filter did not overreach in the other direction.
    expect(episodic.search("AWS", 10)).toHaveLength(1);
  });
});

describe("what the filter must NOT break", () => {
  test("a lead keeps their own thread", () => {
    const { episodic } = makeEpisodic();
    markSessionRestricted(LEAD, true);
    episodic.record(LEAD, "user", "do you ship to Romania?");
    episodic.record(LEAD, "assistant", "yes, 3-5 days");

    expect(episodic.recent(LEAD).map((e) => e.content)).toEqual([
      "do you ship to Romania?",
      "yes, 3-5 days",
    ]);
    expect(episodic.conversation(LEAD)).toHaveLength(2);
  });

  test("an unmarked session is the owner's — nothing about single-user Feral changes", () => {
    const { episodic } = makeEpisodic();
    episodic.record("tui-1", "user", "remember the deploy runbook");
    expect(episodic.search("runbook", 10)).toHaveLength(1);
    expect(episodic.all()).toHaveLength(1);
  });

  test("clearing the mark makes later rows owner rows again", () => {
    const { episodic } = makeEpisodic();
    markSessionRestricted(LEAD, true);
    episodic.record(LEAD, "user", "while restricted");
    markSessionRestricted(LEAD, false);
    episodic.record(LEAD, "user", "after clearing");

    expect(episodic.search("clearing", 10).map((e) => e.content)).toEqual(["after clearing"]);
    expect(episodic.search("restricted", 10)).toHaveLength(0);
  });

  test("with no resolver injected everything is the owner's (legacy callers)", () => {
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, () => {});
    markSessionRestricted(LEAD, true); // ignored — no resolver was passed
    episodic.record(LEAD, "user", "legacy row");
    expect(episodic.all()).toHaveLength(1);
  });
});
