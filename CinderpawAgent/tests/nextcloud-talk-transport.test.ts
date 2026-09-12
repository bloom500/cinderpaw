/**
 * Nextcloud Talk: the address people actually paste, and the envelope every
 * OCS response is wrapped in.
 *
 * Both are pure functions because both fail silently otherwise. A base URL
 * with the web UI path still on it produces a 404 that reads like the server
 * is down, and an OCS body read without unwrapping produces an empty list that
 * reads like a quiet room. Neither says anything to the person waiting.
 */

import { describe, expect, test } from "bun:test";
import {
  normaliseBaseUrl,
  ocsData,
  nextcloudTalkSessionId,
  parseNextcloudTalkSession,
} from "../src/transports/nextcloud-talk.ts";

describe("the address a person pastes becomes the address the API needs", () => {
  test("a clean base URL is left alone", () => {
    expect(normaliseBaseUrl("https://cloud.example.com")).toBe("https://cloud.example.com");
  });

  test("a trailing slash and stray whitespace go", () => {
    expect(normaliseBaseUrl("  https://cloud.example.com/  ")).toBe("https://cloud.example.com");
  });

  test("what the browser bar actually shows is accepted", () => {
    // These are copied out of a real Nextcloud session. Rejecting them, or
    // calling the API underneath them, is a 404 the user cannot diagnose.
    expect(normaliseBaseUrl("https://cloud.example.com/index.php/apps/files/")).toBe(
      "https://cloud.example.com",
    );
    expect(normaliseBaseUrl("https://cloud.example.com/apps/spreed/")).toBe(
      "https://cloud.example.com",
    );
    expect(normaliseBaseUrl("https://cloud.example.com/settings/user/security")).toBe(
      "https://cloud.example.com",
    );
  });

  test("a Nextcloud living in a subdirectory keeps its subdirectory", () => {
    // Self-hosters very often mount it at /nextcloud. Stripping that would
    // break exactly the audience this connector exists for.
    expect(normaliseBaseUrl("https://example.com/nextcloud")).toBe("https://example.com/nextcloud");
    expect(normaliseBaseUrl("https://example.com/nextcloud/index.php/apps/files")).toBe(
      "https://example.com/nextcloud",
    );
  });

  test("a bare hostname is assumed to be https, not http", () => {
    // An app password sent over http is an app password given away.
    expect(normaliseBaseUrl("cloud.example.com")).toBe("https://cloud.example.com");
  });

  test("http is honoured when it is asked for explicitly", () => {
    // A LAN address with no certificate is a real self-hosting case; it is the
    // default that must be safe, not the explicit choice that must be refused.
    expect(normaliseBaseUrl("http://192.168.1.10:8080")).toBe("http://192.168.1.10:8080");
  });

  test("an empty or unusable address says what was expected", () => {
    expect(() => normaliseBaseUrl("")).toThrow(/no server address/);
    expect(() => normaliseBaseUrl("   ")).toThrow(/no server address/);
    expect(() => normaliseBaseUrl("http://")).toThrow(/not a web address/);
  });
});

describe("the OCS envelope is unwrapped, not assumed", () => {
  test("the payload comes out of ocs.data", () => {
    expect(ocsData<{ id: string }>({ ocs: { meta: { status: "ok" }, data: { id: "alice" } } })).toEqual({
      id: "alice",
    });
    expect(ocsData<number[]>({ ocs: { data: [1, 2, 3] } })).toEqual([1, 2, 3]);
  });

  test("a body that is not an OCS envelope is null, not an empty list", () => {
    // The distinction that matters: null means "this was not an answer we
    // understand", and the caller treats that as an error rather than as a
    // room where nobody spoke.
    expect(ocsData([1, 2, 3])).toBeNull();
    expect(ocsData({ error: "nope" })).toBeNull();
    expect(ocsData(null)).toBeNull();
    expect(ocsData("<html>maintenance</html>")).toBeNull();
    expect(ocsData({ ocs: {} })).toBeNull();
  });
});

describe("session ids round-trip", () => {
  test("room and actor survive both directions", () => {
    expect(parseNextcloudTalkSession(nextcloudTalkSessionId("abc123", "alice"))).toEqual({
      roomToken: "abc123",
      actorId: "alice",
    });
  });

  test("another connector's session is not claimed", () => {
    expect(parseNextcloudTalkSession("mattermost:chan:user")).toBeNull();
    expect(parseNextcloudTalkSession("nostr:deadbeef")).toBeNull();
    expect(parseNextcloudTalkSession("nextcloud-talk:only-two")).toBeNull();
  });
});
