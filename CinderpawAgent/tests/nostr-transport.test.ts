/**
 * Nostr: the two places a key can be written, and the default nobody sets.
 *
 * There is no server here to reject a mistake. A Nostr client with a key it
 * misread, or an allowlist in a format the wire never carries, does not fail:
 * it connects, listens, and stays silent forever, which is indistinguishable
 * from nobody having written to it. So the parsing is pure and tested, and the
 * round trip through real signing and real NIP-04 is tested too, because a
 * signature that is merely produced is not a signature that verifies.
 */

import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, verifyEvent } from "nostr-tools";
import {
  decodeSecretKey,
  normalisePubkey,
  parseRelayUrls,
  nostrSessionId,
  parseNostrSession,
} from "../src/transports/nostr.ts";

describe("a private key is read in either form a person can be holding", () => {
  const secret = generateSecretKey();
  const hex = Buffer.from(secret).toString("hex");
  const nsec = nip19.nsecEncode(secret);

  test("nsec1... from a client export", () => {
    expect(decodeSecretKey(nsec)).toEqual(secret);
  });

  test("64 hex characters from an env var", () => {
    expect(decodeSecretKey(hex)).toEqual(secret);
    expect(decodeSecretKey(hex.toUpperCase())).toEqual(secret);
  });

  test("surrounding whitespace, which is what a paste actually contains", () => {
    expect(decodeSecretKey(`  ${nsec}\n`)).toEqual(secret);
  });

  test("an npub is refused by name, not with a generic error", () => {
    const npub = nip19.npubEncode(getPublicKey(secret));
    // The realistic mistake: pasting the PUBLIC key into the private field.
    // Silently accepting it would produce an identity nobody can write to.
    expect(() => decodeSecretKey(npub)).toThrow(/PUBLIC key/);
    expect(() => decodeSecretKey(npub)).toThrow(/not a private key/);
  });

  test("an empty or malformed key says what was expected", () => {
    expect(() => decodeSecretKey("")).toThrow(/no private key/);
    expect(() => decodeSecretKey("hunter2")).toThrow(/nsec1|64 hex/);
    expect(() => decodeSecretKey(hex.slice(0, 63))).toThrow(/nsec1|64 hex/);
  });
});

describe("the allowlist matches what the wire carries", () => {
  const pubkey = getPublicKey(generateSecretKey());
  const npub = nip19.npubEncode(pubkey);

  test("an npub written by a human resolves to the hex the relay sends", () => {
    // Without this the allowlist would never match anything and every message
    // would be dropped as if from a stranger.
    expect(normalisePubkey(npub)).toBe(pubkey);
  });

  test("hex is accepted and lowercased", () => {
    expect(normalisePubkey(pubkey.toUpperCase())).toBe(pubkey);
  });

  test("anything unreadable is null rather than a value that never matches", () => {
    expect(normalisePubkey("")).toBeNull();
    expect(normalisePubkey("   ")).toBeNull();
    expect(normalisePubkey("nostr:alice")).toBeNull();
    expect(normalisePubkey(nip19.nsecEncode(generateSecretKey()))).toBeNull();
    expect(normalisePubkey("npub1notarealkeyatall")).toBeNull();
  });
});

describe("relays: the default is the product", () => {
  test("a fresh install with nothing configured still has relays", () => {
    // The failure this prevents: zero relays is not an error anywhere. The
    // connector reports healthy, connects to nothing, and hears nothing.
    for (const nothing of [undefined, "", "   ", ",, ,"]) {
      const relays = parseRelayUrls(nothing);
      expect(relays.length).toBeGreaterThan(0);
      for (const r of relays) expect(r).toStartWith("wss://");
    }
  });

  test("what the user typed replaces the default, it does not extend it", () => {
    expect(parseRelayUrls("wss://relay.example.com")).toEqual(["wss://relay.example.com"]);
  });

  test("commas, spaces and newlines all separate, because all three get pasted", () => {
    const expected = ["wss://a.example", "wss://b.example", "wss://c.example"];
    expect(parseRelayUrls("wss://a.example,wss://b.example,wss://c.example")).toEqual(expected);
    expect(parseRelayUrls("wss://a.example wss://b.example\nwss://c.example")).toEqual(expected);
    expect(parseRelayUrls(" wss://a.example , wss://b.example ,wss://c.example ")).toEqual(expected);
  });
});

describe("session ids round-trip", () => {
  const pubkey = getPublicKey(generateSecretKey());

  test("id to session and back", () => {
    expect(parseNostrSession(nostrSessionId(pubkey))).toEqual({ pubkey });
  });

  test("another connector's session is not claimed", () => {
    expect(parseNostrSession("telegram:123")).toBeNull();
    expect(parseNostrSession("mattermost:chan:user")).toBeNull();
    expect(parseNostrSession("nostr")).toBeNull();
  });
});

describe("a message actually survives the wire", () => {
  test("signed, verified, encrypted and read back by the other party", () => {
    // Both halves of a real conversation, with no relay involved: us, and the
    // person writing to us. If signing or NIP-04 were wrong, every relay would
    // silently drop the event and nothing here would say why.
    const ours = generateSecretKey();
    const theirs = generateSecretKey();
    const theirPubkey = getPublicKey(theirs);

    const event = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", theirPubkey]],
        content: nip04.encrypt(ours, theirPubkey, "bună, sunt Cinderpaw 🐾"),
      },
      ours,
    );

    // A relay verifies before storing; an event that fails here is never seen.
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(getPublicKey(ours));
    expect(event.tags).toEqual([["p", theirPubkey]]);
    // The point of the encryption: the text is not in the event.
    expect(event.content).not.toContain("Cinderpaw");

    expect(nip04.decrypt(theirs, event.pubkey, event.content)).toBe("bună, sunt Cinderpaw 🐾");
  });

  test("a third party holding neither key cannot read it", () => {
    const ours = generateSecretKey();
    const theirs = generateSecretKey();
    const stranger = generateSecretKey();
    const ciphertext = nip04.encrypt(ours, getPublicKey(theirs), "secret");

    let readable: string | null = null;
    try {
      readable = nip04.decrypt(stranger, getPublicKey(ours), ciphertext);
    } catch {
      readable = null; // the expected outcome
    }
    expect(readable).not.toBe("secret");
  });
});
