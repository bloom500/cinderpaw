import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { redactPII, redactSecrets } from "../src/memory/privacy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── Credential redaction ─────────────────────────────────────────────────
//
// The guided connector setup tells the user, in plain words, to paste a
// bot token into the chat. Before this, that token went verbatim into
// episodic memory: `stripPrivate` only removes what the user explicitly
// wrapped, and nobody wraps a secret they were just told to paste.

describe("redactSecrets", () => {
  test("redacts a Discord bot token", () => {
    const token = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GxYzAb.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678";
    const r = redactSecrets(`here you go: ${token}`);
    expect(r.text).not.toContain(token);
    expect(r.text).toContain("[REDACTED:token]");
    expect(r.redactions).toBe(1);
  });

  test("redacts Slack bot and app tokens", () => {
    const r = redactSecrets("xoxb-123456789012-abcdefghijklmno and xapp-1-A012BCDEF-98765-abcdef");
    expect(r.text).not.toContain("xoxb-");
    expect(r.text).not.toContain("xapp-");
    expect(r.kinds).toContain("slack_token");
    expect(r.redactions).toBe(2);
  });

  test("redacts provider API keys", () => {
    expect(redactSecrets("key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa").text).toContain("[REDACTED:api_key]");
    expect(redactSecrets("key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa").text).toContain("[REDACTED:api_key]");
    expect(redactSecrets("key AIzaSyAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").text).toContain("[REDACTED:api_key]");
  });

  test("redacts GitHub and AWS credentials", () => {
    expect(redactSecrets(`token ghp_${"a".repeat(36)}`).text).toContain("[REDACTED:github_token]");
    expect(redactSecrets("id AKIAIOSFODNN7EXAMPLE").text).toContain("[REDACTED:aws_key]");
  });

  test("redacts a whole PEM private key block, not just its first line", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`saved:\n${pem}\ndone`);
    expect(r.text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(r.text).toContain("[REDACTED:private_key]");
    expect(r.text).toContain("done");
  });

  test("redacts a bearer header pasted into prose", () => {
    const r = redactSecrets("send Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(r.text).toContain("[REDACTED:bearer]");
  });

  test("leaves ordinary text alone", () => {
    // A redactor that mangles normal prose is one the user turns off.
    const prose =
      "connect to discord please, my server is called the-lab and I am on version 2.1.0 " +
      "with commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const r = redactSecrets(prose);
    expect(r.text).toBe(prose);
    expect(r.redactions).toBe(0);
  });

  test("does not eat a plain base64 payload or a UUID", () => {
    const text = "data aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgcGF5bG9hZA== id 550e8400-e29b-41d4-a716-446655440000";
    expect(redactSecrets(text).redactions).toBe(0);
  });

  test("reports every distinct kind it found", () => {
    const r = redactSecrets(`xoxb-123456789012-abcdefghijklmno and ghp_${"b".repeat(36)}`);
    expect(new Set(r.kinds)).toEqual(new Set(["slack_token", "github_token"]));
  });
});

describe("redactPII covers credentials too", () => {
  test("redacts an API key in a durable fact", () => {
    // Semantic memory is the store that keeps things forever. A fact
    // that quietly records a key is worse than one recording a phone.
    const r = redactPII("the user's key is sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa and email a@b.io");
    expect(r.text).toContain("[REDACTED:api_key]");
    expect(r.text).toContain("[REDACTED:email]");
    expect(r.redactions).toBe(2);
  });
});

// ── Parity with the Rust redactor ────────────────────────────────────────
//
// Credentials are redacted twice, by two separate implementations in two
// separate processes: this one keeps them out of memory, and
// `crates/cinderpaw-core/src/secret_redact.rs` keeps them out of the
// saved conversation. A format one catches and the other misses is still
// a leaked secret — it just leaks into the other store.
//
// Both sides read this same fixture. Add a format there and whichever
// side has not learned it yet fails.

const parityFixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "secret-redaction-cases.json"), "utf8"),
) as {
  secrets: { kind: string; text: string; note: string }[];
  innocent: { text: string; note: string }[];
};

describe("parity with the Rust transcript redactor", () => {
  test("every shared secret is redacted here too", () => {
    expect(parityFixture.secrets.length).toBeGreaterThan(0);
    for (const { kind, text, note } of parityFixture.secrets) {
      // In isolation, and in a sentence — a value only caught when it
      // stands alone would miss every real paste.
      for (const input of [text, `here it is: ${text} — use it`]) {
        const r = redactSecrets(input);
        expect(r.text, `${note}: the secret survived`).not.toContain(text);
        expect(r.text, `${note}: expected kind '${kind}'`).toContain(`[REDACTED:${kind}]`);
      }
    }
  });

  test("nothing innocent is touched", () => {
    for (const { text, note } of parityFixture.innocent) {
      const r = redactSecrets(text);
      expect(r.redactions, `${note}: ordinary text was redacted`).toBe(0);
      expect(r.text, `${note}: ordinary text was altered`).toBe(text);
    }
  });
});
