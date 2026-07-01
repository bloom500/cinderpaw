import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog, recentToolCalls } from "../src/sandbox/audit-log.ts";
import type { AuditEntry } from "../src/types.ts";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: 1_700_000_000_000,
    sessionId: "s1",
    actionType: "tool_call",
    toolName: "read_file",
    argsJson: JSON.stringify({ path: "a.txt" }),
    result: "success",
    durationMs: 12,
    ...over,
  };
}

describe("audit log hash chain (H-2)", () => {
  test("an untampered chain verifies", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    audit.record(entry());
    audit.record(entry({ toolName: "write_file", result: "success" }));
    audit.record(entry({ actionType: "blocked", result: "blocked", blockedReason: "no perms" }));

    const r = audit.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toBe(3);
    db.close();
  });

  test("altering a row's content is detected", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    audit.record(entry());
    audit.record(entry({ result: "success" }));

    // Tamper: flip a stored result without recomputing its hash.
    db.raw.exec("UPDATE audit_log SET result = 'blocked' WHERE id = 1");

    const r = audit.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAtId).toBe(1);
      expect(r.reason).toContain("altered");
    }
    db.close();
  });

  test("deleting a row breaks the linkage", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    audit.record(entry());
    audit.record(entry());
    audit.record(entry());

    db.raw.exec("DELETE FROM audit_log WHERE id = 2");

    const r = audit.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/linkage|deleted/);
    db.close();
  });

  test("legacy rows (NULL entry_hash) before the chain are skipped", () => {
    const db = openDatabase(":memory:");
    // Simulate a row written before the hash-chain columns existed.
    db.raw.exec(`
      INSERT INTO audit_log (timestamp, session_id, action_type, result)
      VALUES (1, 'legacy', 'tool_call', 'success')
    `);
    const audit = new AuditLog(db.raw);
    audit.record(entry());
    audit.record(entry());

    const r = audit.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toBe(2); // legacy row not counted
    db.close();
  });

  test("chain survives a reopen (head seeded from DB)", () => {
    const db = openDatabase(":memory:");
    const a1 = new AuditLog(db.raw);
    a1.record(entry());
    a1.record(entry());

    // A second logger over the same DB must continue the same chain.
    const a2 = new AuditLog(db.raw);
    a2.record(entry());

    const r = a2.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toBe(3);
    db.close();
  });
});

describe("recentToolCalls (§2.10 personal-fitness reader)", () => {
  test("returns recent tool_call rows only, windowed and capped", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const now = Date.now();
    audit.record(entry({ timestamp: now - 1_000, toolName: "fresh_ok", result: "success" }));
    audit.record(entry({ timestamp: now - 2_000, toolName: "fresh_err", result: "error" }));
    // Not a tool_call → excluded.
    audit.record(entry({ timestamp: now - 3_000, actionType: "memory_write", toolName: "mem" }));
    // Older than the window → excluded.
    audit.record(entry({ timestamp: now - 8 * 24 * 60 * 60 * 1000, toolName: "stale" }));

    const rows = recentToolCalls(db.raw);
    expect(rows.map((r) => r.toolName)).toEqual(["fresh_ok", "fresh_err"]);
    expect(rows[0]!.actionType).toBe("tool_call");
    expect(rows[1]!.result).toBe("error");

    // limit caps the result set (newest first).
    expect(recentToolCalls(db.raw, undefined, 1).map((r) => r.toolName)).toEqual(["fresh_ok"]);
    db.close();
  });

  test("soft-fails to [] when the table is missing", () => {
    const db = openDatabase(":memory:");
    db.raw.exec("DROP TABLE audit_log");
    expect(recentToolCalls(db.raw)).toEqual([]);
    db.close();
  });
});
