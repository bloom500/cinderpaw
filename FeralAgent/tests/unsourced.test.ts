/**
 * The three answers that motivated this, verbatim in shape, plus the cases
 * where staying quiet matters more than warning.
 *
 * A warning that fires on ordinary conversation is a warning people switch
 * off, and then it protects nobody. So the bar is: a real path shape, and a
 * turn that opened nothing at all.
 */
import { describe, expect, test } from "bun:test";
import { claimedPath, unsourcedWarning, withOpenFirst } from "../src/core/unsourced.ts";
import { replayedToolNote } from "../src/core/agent-loop.ts";

describe("saying the words the person did not know to say", () => {
  test("a message naming a file carries the instruction", () => {
    // The exact prompt that produced three paragraphs about a module that does
    // not exist, four times running, in a fresh session.
    const asked = withOpenFirst("Read D:\\proj\\src\\core\\quantum-scheduler.ts and summarise it.");
    expect(asked).toContain("quantum-scheduler.ts");
    expect(asked).toContain("Do not answer from memory");
    // The person's own words survive intact — this adds, never rewrites.
    expect(asked.startsWith("Read D:\\proj\\src\\core\\quantum-scheduler.ts and summarise it.")).toBe(
      true,
    );
  });

  test("ordinary conversation is untouched, byte for byte", () => {
    // The failure mode that would matter more than the one being fixed: every
    // turn dragging a nag about files into a chat that is not about files.
    for (const msg of [
      "What's the difference between a mutex and a semaphore?",
      "hey, how's it going?",
      "Version 2026.8.1 is the current release, right?",
      "Check https://example.com/docs/setup.md when you get a chance.",
    ]) {
      expect(withOpenFirst(msg)).toBe(msg);
    }
  });
});

describe("an instruction to look at the world as it is now", () => {
  test("the message that got answered from ten-minute-old results carries it", () => {
    // Verbatim, Discord, 2026-08-11 02:29. Ten minutes into a session that had
    // already read both files, the reply came back with "Am verificat acum" and
    // their exact byte counts — and zero tool calls that turn. Nothing was
    // invented: 1709 bytes and 859 bytes were both correct, and both ten minutes
    // old. Only the freshness was false. No file path in the message, so the
    // path trigger stayed silent and the model answered from what it still had.
    const asked = withOpenFirst("Testeaza si vezi daca merge, tu completezi autonom in scratch pad ?");
    expect(asked).toContain("Check this now with a tool");
    expect(asked.startsWith("Testeaza si vezi daca merge")).toBe(true);
  });

  test("the same intent, however it is phrased", () => {
    for (const msg of [
      "check if the gateway is still up",
      "verifică dacă mai merge conectorul",
      "see if the build passes",
      "încearcă din nou și zi-mi",
      "is it still working?",
    ]) {
      expect(withOpenFirst(msg)).toContain("Check this now with a tool");
    }
  });

  test("a message that names a file keeps the sharper instruction", () => {
    // Both triggers match here. The path one says WHICH file to open, so it wins
    // — a generic "check something" would be a downgrade.
    const asked = withOpenFirst("verifică D:\\proj\\src\\core\\loop.ts");
    expect(asked).toContain("loop.ts");
    expect(asked).not.toContain("Check this now with a tool");
  });

  test("talking about tests is not asking for one to be run", () => {
    // The failure mode worth more than the one being fixed: a nag on every turn
    // of a conversation that happens to use the word "test".
    for (const msg of [
      "What's the difference between a mutex and a semaphore?",
      "write a test for the parser",
      "the test suite is green",
      "de ce e testul ăsta lent?",
      "hey, how's it going?",
    ]) {
      expect(withOpenFirst(msg)).toBe(msg);
    }
  });
});

describe("an answer about a file nothing opened", () => {
  test("the answer that never names the file is still flagged", () => {
    // The case that slipped through twice: asked to summarise a named file, the
    // model described it at length and never repeated the path, so an
    // answer-only check found nothing to object to while the whole reply was
    // invented. What the person named is the claim.
    const answer =
      "QuantumScheduler is the central dispatcher for microtasks — it picks when " +
      "a task runs and which worker thread it lands on.";
    const prompt = "Read D:\proj\src\core\quantum-scheduler.ts and summarise it.";
    expect(unsourcedWarning(answer, 0)).toBeNull(); // answer alone says nothing
    expect(unsourcedWarning(answer, 0, prompt)).toContain("quantum-scheduler.ts");
    // Evidence exists → still silent, whatever was asked.
    expect(unsourcedWarning(answer, 2, prompt)).toBeNull();
  });

  test("a question with no file in it is never flagged", () => {
    expect(
      unsourcedWarning(
        "A mutex is one key, one door; a semaphore is a counter on a door.",
        0,
        "What's the difference between a mutex and a semaphore?",
      ),
    ).toBeNull();
  });

  test("the fabricated module summary is flagged", () => {
    const answer =
      "QuantumScheduler, in plain terms: it decides when and on which thread a " +
      "microtask runs. See D:\\FeralLocalAI\\FeralAgent\\src\\core\\quantum-scheduler.ts.";
    expect(unsourcedWarning(answer, 0)).toContain("quantum-scheduler.ts");
    expect(unsourcedWarning(answer, 0)).toContain("no file was opened");
  });

  test("the fabricated write is flagged", () => {
    expect(unsourcedWarning("2026.8.1 written to walkaway-demo6/VERSION.md.", 0)).toBeTruthy();
  });

  test("a fabricated directory listing is flagged", () => {
    const answer = "The actual core/ contents I can see are quantum-scheduler.ts, dispatcher.ts.";
    expect(unsourcedWarning(answer, 0)).toBeTruthy();
  });

  test("a turn that actually used tools is never flagged", () => {
    // The whole point: evidence exists, so the reader needs no footnote.
    const answer = "I read D:\\FeralLocalAI\\FeralAgent\\package.json — the version is 2026.8.1.";
    expect(unsourcedWarning(answer, 1)).toBeNull();
    expect(unsourcedWarning(answer, 12)).toBeNull();
  });

  test("ordinary conversation is left alone", () => {
    expect(unsourcedWarning("Hey — what would you like me to look at?", 0)).toBeNull();
    expect(unsourcedWarning("Sure, I can help with the deployment config.", 0)).toBeNull();
    expect(unsourcedWarning("Version 2026.8.1 is the current release.", 0)).toBeNull();
  });

  test("a URL is not a file on this machine", () => {
    expect(unsourcedWarning("See https://example.com/docs/setup.md for details.", 0)).toBeNull();
  });

  test("a path in backticks is still a claim — models write them that way", () => {
    // The reason the detector stayed silent through a whole round of fabricated
    // answers: paths arrive as `src/core/x.ts` far more often than bare.
    expect(
      unsourcedWarning("2026.8.1 written to `D:\proj\walkaway-demo6\VERSION.md`.", 0),
    ).toBeTruthy();
    expect(unsourcedWarning("I checked `src/core/loop.ts` and it looks fine.", 0)).toBeTruthy();
  });

  test("code the agent is proposing is not a claim about having read it", () => {
    // Writing an example that mentions a filename must not read as evidence of
    // having opened one.
    const answer = "Here is what I would write:\n```ts\n// src/index.ts\nexport const x = 1;\n```";
    expect(unsourcedWarning(answer, 0)).toBeNull();
  });
});

describe("what counts as a path", () => {
  test("the shapes that matter", () => {
    expect(claimedPath("look at D:\\proj\\a.ts")).toBe("D:\\proj\\a.ts");
    expect(claimedPath("check /etc/nginx/nginx.conf please")).toBe("/etc/nginx/nginx.conf");
    expect(claimedPath("it lives in src/core/loop.ts")).toBe("src/core/loop.ts");
    expect(claimedPath("REPORT.md has the table")).toBe("REPORT.md");
  });

  test("prose about files in general is not a path", () => {
    expect(claimedPath("I checked the configuration and the tests")).toBeNull();
    expect(claimedPath("version 2026.8.1")).toBeNull();
  });
});

describe("a replayed answer carries the work that produced it", () => {
  test("tools are named and counted, once", () => {
    expect(replayedToolNote(["read_file", "read_file", "shell_exec"])).toBe(
      "read_file ×2, shell_exec",
    );
    expect(replayedToolNote(["list_dir"])).toBe("list_dir");
  });

  test("the note is not written in the assistant's voice", () => {
    // It used to return `[used …]\n` for prefixing onto the answer. The model
    // copied the prefix and fabricated the answer under it. Anything that looks
    // like the opening of a reply belongs nowhere near this string — the note
    // travels as a tool row now, see the replay loop in agent-loop.ts.
    expect(replayedToolNote(["read_file"])).not.toContain("[");
    expect(replayedToolNote(["read_file"])).not.toContain("\n");
  });

  test("a turn that used nothing is left alone", () => {
    // The whole value of the note is that its absence means something. Stamping
    // every turn with it would make it invisible again.
    expect(replayedToolNote([])).toBe("");
  });
});
