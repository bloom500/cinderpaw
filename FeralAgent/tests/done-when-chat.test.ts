/**
 * "Done" has to be something the world can confirm, including for the person
 * who typed the task on a phone.
 *
 * This exists because of a real run: the agent reported 563 files counted, a
 * table of the ten largest and a cross-check of three methods — with zero tool
 * calls behind it and no file on disk. The digest said, correctly, "no
 * done_when declared — completion is the agent's own claim, unverified", and
 * nothing else in the system could contradict it.
 */
import { describe, expect, test } from "bun:test";
import { parseDoneWhenFromMessage } from "../src/cron/done-when.ts";

describe("declaring done from a chat message", () => {
  test("the three forms", () => {
    expect(parseDoneWhenFromMessage("write it\ndone_when: exists out/REPORT.md")).toEqual({
      kind: "file_exists",
      path: "out/REPORT.md",
    });
    expect(
      parseDoneWhenFromMessage('do it\ndone_when: contains out/REPORT.md "total: 231"'),
    ).toEqual({ kind: "file_contains", path: "out/REPORT.md", value: "total: 231" });
    expect(parseDoneWhenFromMessage("fix the tests\ndone_when: run bun test")).toEqual({
      kind: "command",
      value: "bun test",
    });
  });

  test("no line, no assertion — and that is not the same as passing", () => {
    expect(parseDoneWhenFromMessage("just have a look at the config")).toBeNull();
  });

  test("an unrecognised verb declares nothing rather than something wrong", () => {
    // A check that silently means something other than what was written is
    // worse than no check: it reports "verified" for the wrong thing.
    expect(parseDoneWhenFromMessage("go\ndone_when: probably works")).toBeNull();
    expect(parseDoneWhenFromMessage("go\ndone_when:")).toBeNull();
  });

  test("the last line wins, because that is how people correct themselves", () => {
    expect(
      parseDoneWhenFromMessage("go\ndone_when: exists a.md\ndone_when: exists b.md"),
    ).toEqual({ kind: "file_exists", path: "b.md" });
  });

  test("case and leading spaces do not matter", () => {
    expect(parseDoneWhenFromMessage("go\n  DONE_WHEN: Exists out/x.md")).toEqual({
      kind: "file_exists",
      path: "out/x.md",
    });
  });
});
