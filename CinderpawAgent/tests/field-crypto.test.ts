import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  encryptField,
  decryptField,
  fieldEncryptionEnabled,
} from "../src/egress/field-crypto.ts";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";

const KEY_B64 = randomBytes(32).toString("base64");
const prevKey = process.env.CINDERPAW_DB_KEY;

afterEach(() => {
  if (prevKey === undefined) delete process.env.CINDERPAW_DB_KEY;
  else process.env.CINDERPAW_DB_KEY = prevKey;
});

describe("field-crypto (H-1)", () => {
  test("with a key: round-trips and the envelope hides the plaintext", () => {
    process.env.CINDERPAW_DB_KEY = KEY_B64;
    expect(fieldEncryptionEnabled()).toBe(true);

    const secret = "the user's address is 12 Oak St, employer ACME";
    const enc = encryptField(secret);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("Oak St");
    expect(decryptField(enc)).toBe(secret);
  });

  test("without a key: stores plaintext (graceful no-op)", () => {
    delete process.env.CINDERPAW_DB_KEY;
    expect(fieldEncryptionEnabled()).toBe(false);
    const v = "plain value";
    expect(encryptField(v)).toBe(v);
    expect(decryptField(v)).toBe(v); // legacy plaintext passes through
  });

  test("an enveloped value written with a key is unreadable once the key is gone", () => {
    process.env.CINDERPAW_DB_KEY = KEY_B64;
    const enc = encryptField("secret");
    delete process.env.CINDERPAW_DB_KEY;
    // No key: returns the envelope unchanged rather than throwing.
    expect(decryptField(enc)).toBe(enc);
  });

  test("tampered ciphertext does not throw on read", () => {
    process.env.CINDERPAW_DB_KEY = KEY_B64;
    const enc = encryptField("sensitive");
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(() => decryptField(tampered)).not.toThrow();
  });
});

describe("SemanticMemory at-rest encryption (H-1)", () => {
  test("the raw DB cell is ciphertext, but reads return plaintext", () => {
    process.env.CINDERPAW_DB_KEY = KEY_B64;
    const db = openDatabase(":memory:");
    const mem = new SemanticMemory(db.raw, () => {});

    mem.upsert("employer", "works at Globex Corp");

    const raw = db.raw
      .query("SELECT value FROM semantic WHERE key = 'employer'")
      .get() as { value: string };
    expect(raw.value.startsWith("enc:v1:")).toBe(true);
    expect(raw.value).not.toContain("Globex");

    expect(mem.get("employer")?.value).toBe("works at Globex Corp");
    db.close();
  });
});
