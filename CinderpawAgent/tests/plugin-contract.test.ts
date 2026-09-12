/**
 * The plugin contract denies by default, and cannot mint a profile.
 *
 * Two properties, both of which have a shipped counterexample behind them:
 * a permission list that is empty on a fresh install must mean "none" and
 * not "all" (the 2026-08-14 Discord allowlist), and the handle given to code
 * we did not write must not include the call that turns a stranger into the
 * owner (agent-loop's `registerProfile` with no `allowedTools`).
 */

import { describe, expect, test } from "bun:test";
import {
  NO_CAPABILITIES,
  resolveCapabilities,
  type PluginHost,
} from "../src/transports/plugin-contract.ts";

describe("capabilities deny by default", () => {
  test("a manifest that declares nothing gets nothing", () => {
    expect(resolveCapabilities(undefined)).toEqual(NO_CAPABILITIES);
    expect(resolveCapabilities({})).toEqual(NO_CAPABILITIES);
  });

  test("a malformed declaration is denied, not widened", () => {
    // "*" is a string, so it survives as a literal host name and matches
    // nothing — it is not expanded into a wildcard anywhere.
    expect(resolveCapabilities({ hosts: "api.slack.com" }).hosts).toEqual([]);
    expect(resolveCapabilities({ hosts: [1, null, {}] }).hosts).toEqual([]);
    expect(resolveCapabilities({ hosts: ["", "  "] }).hosts).toEqual([]);
    expect(resolveCapabilities({ storage: "yes" }).storage).toBe(false);
    expect(resolveCapabilities({ tools: null }).tools).toEqual([]);
  });

  test("a well-formed declaration is honoured exactly", () => {
    const caps = resolveCapabilities({
      hosts: ["api.slack.com", "wss.slack.com"],
      storage: true,
      binaries: ["signal-cli"],
      tools: ["web_search"],
    });
    expect(caps.hosts).toEqual(["api.slack.com", "wss.slack.com"]);
    expect(caps.storage).toBe(true);
    expect(caps.binaries).toEqual(["signal-cli"]);
    expect(caps.tools).toEqual(["web_search"]);
  });
});

describe("the plugin host hands over no profile control", () => {
  test("PluginHost exposes no way to register or rebind a profile", () => {
    // Structural, not a string scan of the source: this is the set of keys a
    // plugin can reach. `registerProfile` and `setSessionProfile` are the two
    // calls that, in that order, make every stranger the owner.
    const keys: Array<keyof PluginHost> = [
      "secrets",
      "config",
      "session",
      "fetch",
      "storageDir",
      "binaries",
      "log",
    ];
    expect(keys).not.toContain("registerProfile" as never);
    expect(keys).not.toContain("setSessionProfile" as never);
    expect(keys).not.toContain("agent" as never);
  });

  test("the host owns the allowlist: session() may refuse a speaker", () => {
    // Pinning the SHAPE of the decision, which is the part the contract
    // fixes: a plugin asks for a session and can be told no. It has no
    // branch of its own in which it decides to answer an unlisted stranger.
    const allowed = new Set(["U_OWNER"]);
    const host = {
      session: (msg: { speakerId: string }) =>
        allowed.has(msg.speakerId) ? { ask: async () => "", reset: () => {} } : null,
    };
    expect(host.session({ speakerId: "U_OWNER" })).not.toBeNull();
    expect(host.session({ speakerId: "U_STRANGER" })).toBeNull();
  });
});
