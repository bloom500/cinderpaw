import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LearnedWays } from "./learned-ways.ts";

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE audit_log (timestamp INTEGER, session_id TEXT, action_type TEXT, tool_name TEXT, result TEXT)`);
  const tool = (ts: number, name: string, result = "success") =>
    db.query(`INSERT INTO audit_log VALUES (?, 's1', 'tool_call', ?, ?)`).run(ts, name, result);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ways-")), "learned-ways.jsonl");
  return { db, tool, file, ways: new LearnedWays(db, file) };
}

const ASK = "fa-mi un raport PDF despre vanzarile din septembrie";

describe("learned ways", () => {
  test("a thumbs up teaches the steps, a similar request gets them, an unrelated one does not", () => {
    const { tool, ways, file, db } = setup();
    ways.turnStarted("m1", "s1", ASK, 1000);
    tool(1100, "web_search");
    tool(1200, "web_search");
    tool(1300, "todo_write");
    tool(1400, "write_file", "error");
    tool(1500, "export_pdf");
    ways.turnStarted("m2", "s1", "multumesc", 2000);
    tool(2100, "read_file"); // the next turn's work is not this turn's way

    expect(ways.feedback("m1", "up")).toBe("learned");
    expect(ways.list()[0]!.steps).toEqual(["web_search", "export_pdf"]);
    expect(ways.match("fa-mi un raport PDF despre vanzarile din octombrie")?.id).toBe("m1");
    expect(ways.match("ce vreme va fi maine la Cluj")).toBeNull();
    // Survives a restart.
    expect(new LearnedWays(db, file).match(ASK)?.id).toBe("m1");
  });

  test("the same vote twice counts once; a reply with no tools teaches nothing", () => {
    const { tool, ways } = setup();
    ways.turnStarted("m1", "s1", ASK, 1000);
    expect(ways.feedback("m1", "up")).toBeNull(); // nothing was done
    ways.turnStarted("m2", "s1", ASK, 2000);
    tool(2100, "export_pdf");
    expect(ways.feedback("m2", "up")).toBe("learned");
    expect(ways.feedback("m2", "up")).toBeNull();
  });

  test("two thumbs down after use retire the way, and it is never offered again", () => {
    const { tool, ways } = setup();
    ways.turnStarted("m1", "s1", ASK, 1000);
    tool(1100, "export_pdf");
    ways.feedback("m1", "up");

    expect(ways.turnStarted("m2", "s1", ASK, 2000)?.id).toBe("m1");
    expect(ways.feedback("m2", "down")).toBe("counted");
    expect(ways.turnStarted("m3", "s1", ASK, 3000)?.id).toBe("m1");
    expect(ways.feedback("m3", "down")).toBe("retired");
    expect(ways.turnStarted("m4", "s1", ASK, 4000)).toBeNull();
  });

  test("taking back the thumbs up that taught a way takes the way back", () => {
    const { tool, ways } = setup();
    ways.turnStarted("m1", "s1", ASK, 1000);
    tool(1100, "export_pdf");
    ways.feedback("m1", "up");
    expect(ways.feedback("m1", "down")).toBe("retired");
    expect(ways.match(ASK)).toBeNull();
  });
});
