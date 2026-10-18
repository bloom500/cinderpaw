import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ingestImports } from "../src/memory/import-inbox.ts";
import { ObservationStore } from "../src/memory/observations.ts";

const NOW = Date.UTC(2026, 9, 18, 12);

function setup(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cp-import-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const db = openDatabase(":memory:");
  return { dir, db, s: new ObservationStore(db.raw) };
}

const line = (o: object) => JSON.stringify(o) + "\n";

describe("ingestImports", () => {
  test("notes and the card land in memory and the file moves to done/", () => {
    const { dir, db, s } = setup({
      "openclaw/MEMORY.jsonl": line({ kind: "note", text: "Ships on Windows first.", priority: "high" }),
      "openclaw/daily.jsonl":
        line({ kind: "note", text: "Fixed the installer.", date: "2026-07-01", priority: "med" }) + "not json\n",
      "openclaw/USER.jsonl": line({ kind: "card", text: "- Name: Darius", priority: "high" }),
    });
    expect(ingestImports(dir, s, NOW)).toBe(3);
    const list = s.list("");
    expect(list.map((n) => [n.text, n.refDate, n.priority, n.source]).sort()).toEqual([
      ["Fixed the installer.", "2026-07-01", "med", "import"],
      ["Ships on Windows first.", null, "high", "import"],
    ]);
    expect(s.card("")?.text).toBe("- Name: Darius");
    expect(readdirSync(join(dir, "openclaw"))).toEqual([]);
    expect(readdirSync(join(dir, "done", "openclaw")).length).toBe(3);
    db.close();
  });

  test("bringing the same setup over twice adds nothing new", () => {
    const { dir, db, s } = setup({ "hermes/MEMORY.jsonl": line({ kind: "note", text: "Uses Bun." }) });
    ingestImports(dir, s, NOW);
    writeFileSync(join(dir, "hermes", "MEMORY.jsonl"), line({ kind: "note", text: "Uses Bun." }));
    expect(ingestImports(dir, s, NOW + 1)).toBe(0);
    expect(s.list("").length).toBe(1);
    db.close();
  });

  test("a person who already has a card keeps it; the imported one becomes notes", () => {
    const { dir, db, s } = setup({ "hermes/USER.jsonl": line({ kind: "card", text: "- Name is Ana.\n- Likes tea." }) });
    s.setCard("", "Ana, a designer in Cluj.", NOW - 1);
    expect(ingestImports(dir, s, NOW)).toBe(2);
    expect(s.card("")?.text).toBe("Ana, a designer in Cluj.");
    expect(s.list("").map((n) => [n.text, n.priority]).sort()).toEqual([["Likes tea.", "high"], ["Name is Ana.", "high"]]);
    db.close();
  });

  test("no import folder is a no-op", () => {
    const db = openDatabase(":memory:");
    expect(ingestImports(join(tmpdir(), "cp-no-such-import-dir"), new ObservationStore(db.raw), NOW)).toBe(0);
    expect(existsSync(join(tmpdir(), "cp-no-such-import-dir"))).toBe(false);
    db.close();
  });
});
