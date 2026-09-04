/**
 * Owner-only tools, and the hole they were added to close.
 *
 * `notebook` is a persistent JavaScript interpreter with every other tool bound
 * as a function. Its sandbox is real — verified by running it: no `fetch`, no
 * `process`, no `require`, every capability still through the registry's
 * permission checks — but the config's own words are "a hardened context, not
 * a jail against hostile input". Someone messaging a Discord bot IS hostile
 * input by default.
 *
 * THE HOLE. A connector persona with no `personaTools` compiles to
 * `allowed = null`, and both checks in the agent loop read `profile?.allowed
 * && …`. A null allow-list is falsy, so the check was skipped entirely and the
 * session ran with the owner's full surface. connectors.ts logs it plainly:
 * "persona profile registered (full toolset)".
 *
 * So the rule enforced here is the PRESENCE of a profile, not the contents of
 * its allow-list. Any profile means not the owner.
 */

import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_TOOLS,
  OWNER_ONLY_TOOLS,
  isConnectorTool,
  isCoreTool,
  isOwnerOnlyTool,
} from "../src/tools/tiers.ts";

describe("OWNER_ONLY_TOOLS", () => {
  test("notebook is owner-only", () => {
    expect(isOwnerOnlyTool("notebook")).toBe(true);
    expect(OWNER_ONLY_TOOLS.has("notebook")).toBe(true);
  });

  test("an ordinary tool is not", () => {
    expect(isOwnerOnlyTool("web_search")).toBe(false);
    expect(isOwnerOnlyTool("read_file")).toBe(false);
  });

  test("it is the OPPOSITE direction from CONNECTOR_TOOLS, not a synonym", () => {
    // CONNECTOR_TOOLS = only connectors get these.
    // OWNER_ONLY_TOOLS = connectors never get these.
    for (const name of OWNER_ONLY_TOOLS) expect(isConnectorTool(name)).toBe(false);
    for (const name of CONNECTOR_TOOLS) expect(isOwnerOnlyTool(name)).toBe(false);
  });

  test("owner-only does not mean hidden from the owner", () => {
    // The owner has no profile, so the gate never fires for them; notebook
    // still has to be advertised or enabling it by default buys nothing.
    expect(isCoreTool("notebook")).toBe(true);
  });
});

/**
 * The gate itself, as both call sites express it. Kept as a local mirror of
 * the two conditions rather than booting an AgentLoop: what is worth pinning
 * is the SHAPE of the test — profile presence, not allow-list contents — and
 * that is exactly what a null allow-list used to slip past.
 */
describe("the profile gate refuses on presence, not on contents", () => {
  const advertise = (name: string, profile: { allowed: Set<string> | null } | undefined) => {
    if (profile && isOwnerOnlyTool(name)) return false;
    return profile?.allowed ? profile.allowed.has(name) : isCoreTool(name);
  };
  const canExecute = (name: string, profile: { allowed: Set<string> | null } | undefined) =>
    !((profile && isOwnerOnlyTool(name)) || (profile?.allowed && !profile.allowed.has(name)));

  test("the owner (no profile) gets it", () => {
    expect(advertise("notebook", undefined)).toBe(true);
    expect(canExecute("notebook", undefined)).toBe(true);
  });

  test("a persona-only profile (allowed = null) is refused — the actual bug", () => {
    // This is the case that used to pass both checks: `profile?.allowed &&`
    // is falsy when allowed is null, so nothing was tested at all.
    const persona = { allowed: null };
    expect(advertise("notebook", persona)).toBe(false);
    expect(canExecute("notebook", persona)).toBe(false);
  });

  test("a profile that explicitly lists it is STILL refused", () => {
    // Fail-closed: a connector operator cannot opt their session back in.
    const sneaky = { allowed: new Set(["notebook", "web_search"]) };
    expect(advertise("notebook", sneaky)).toBe(false);
    expect(canExecute("notebook", sneaky)).toBe(false);
  });

  test("a profiled session keeps every other tool it was granted", () => {
    const p = { allowed: new Set(["web_search"]) };
    expect(advertise("web_search", p)).toBe(true);
    expect(canExecute("web_search", p)).toBe(true);
  });

  test("advertising is not enforcement — an unadvertised call is still denied", () => {
    // A model can name a tool it was never shown, which is why the exec gate
    // repeats the check rather than trusting the schema list.
    const p = { allowed: new Set(["web_search"]) };
    expect(advertise("read_file", p)).toBe(false);
    expect(canExecute("read_file", p)).toBe(false);
  });
});
