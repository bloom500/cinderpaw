import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { redactPII } from "../src/memory/privacy.ts";

describe("redactPII (M-2)", () => {
  test("redacts email", () => {
    const r = redactPII("contact me at ana.pop@example.com please");
    expect(r.text).toBe("contact me at [REDACTED:email] please");
    expect(r.kinds).toContain("email");
    expect(r.redactions).toBe(1);
  });

  test("redacts a Luhn-valid credit card with separators", () => {
    const r = redactPII("card 4111 1111 1111 1111 expires soon");
    expect(r.text).toContain("[REDACTED:card]");
    expect(r.text).not.toContain("4111");
    expect(r.kinds).toContain("card");
  });

  test("does NOT redact a non-Luhn digit run (low false positives)", () => {
    const r = redactPII("order number 1234567890123456 confirmed");
    expect(r.text).toContain("1234567890123456");
    expect(r.redactions).toBe(0);
  });

  test("redacts IBAN", () => {
    const r = redactPII("transfer to DE89370400440532013000 today");
    expect(r.text).toContain("[REDACTED:iban]");
    expect(r.kinds).toContain("iban");
  });

  test("redacts Romanian CNP", () => {
    const r = redactPII("CNP 1960101223344 on file");
    expect(r.text).toContain("[REDACTED:cnp]");
    expect(r.kinds).toContain("cnp");
  });

  test("redacts phone numbers", () => {
    expect(redactPII("call +40 721 234 567").text).toContain("[REDACTED:phone]");
    expect(redactPII("mobile 0721234567").text).toContain("[REDACTED:phone]");
  });

  test("handles multiple distinct kinds in one string", () => {
    const r = redactPII("email x@y.io, card 4111111111111111");
    expect(r.redactions).toBe(2);
    expect(r.kinds.sort()).toEqual(["card", "email"]);
  });

  test("leaves clean text untouched", () => {
    const r = redactPII("the user prefers concise answers and dark mode");
    expect(r.redactions).toBe(0);
    expect(r.text).toBe("the user prefers concise answers and dark mode");
  });
});

describe("SemanticMemory PII redaction at write (M-2)", () => {
  test("persists the redacted value, not the raw PII", () => {
    const db = openDatabase(":memory:");
    const mem = new SemanticMemory(db.raw, () => {});
    mem.upsert("billing", "his card is 4111 1111 1111 1111");

    const fact = mem.get("billing");
    expect(fact?.value).toContain("[REDACTED:card]");
    expect(fact?.value).not.toContain("4111");
    db.close();
  });
});
