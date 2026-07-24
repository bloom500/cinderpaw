/**
 * Task 1 — the forged tool's child process is behind the egress proxy.
 *
 * Before this, `networkAccess: false` in the custom-tool manifest described
 * only "we didn't hand it a ctx.fetch"; the child called `fetch` directly and
 * reached anything. These tests pin the three properties that make the field
 * mean what it says: no declared domains → refused, undeclared host → refused,
 * declared host → allowed, and loopback stays blocked even under "*".
 */

import { describe, expect, test, afterEach } from "bun:test";
import { installEgressFetch, TOOL_DOMAINS_ENV } from "../src/tools/custom-tool-runner.ts";
import { createCustomTool, validateCustomTool } from "../src/tools/custom-tools.ts";
import type { CustomToolRecord } from "../src/tools/custom-tools.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install the guard with a given whitelist and return the guarded fetch. */
function guarded(domains: string): typeof fetch {
  installEgressFetch({ [TOOL_DOMAINS_ENV]: domains } as NodeJS.ProcessEnv);
  return globalThis.fetch;
}

describe("child egress guard", () => {
  test("no declared domains → every request is refused", async () => {
    const f = guarded("");
    await expect(f("https://api.github.com/")).rejects.toThrow(/no network access/i);
  });

  test("a host that was not declared is refused", async () => {
    const f = guarded("api.github.com");
    await expect(f("https://evil.com/steal")).rejects.toThrow(/not in allowedDomains/i);
  });

  test("loopback stays blocked even under the open-egress wildcard", async () => {
    const f = guarded("*");
    // The inference engine's port is the case that must never be reachable
    // from agent-written code.
    await expect(f("http://127.0.0.1:11435/v1/models")).rejects.toThrow(
      /loopback|private|link-local/i,
    );
    await expect(f("http://localhost:11435/")).rejects.toThrow(/loopback|private|link-local/i);
  });

  test("non-http schemes are refused (no file:// exfiltration)", async () => {
    const f = guarded("*");
    await expect(f("file:///etc/passwd")).rejects.toThrow(/scheme/i);
  });

  test("a declared host is allowed through to the network layer", async () => {
    // We assert the guard does not BLOCK it — the request itself is a real
    // socket, so we only care that the failure (if any) is a network error and
    // not an egress block.
    const f = guarded("example.com");
    try {
      const res = await f("https://example.com/");
      expect(res.status).toBeGreaterThan(0);
    } catch (e) {
      expect(String(e)).not.toMatch(/allowedDomains|no network access/i);
    }
  });

  // Pins the KNOWN HOLE so nobody later reads the guard as containment. If a
  // future Bun makes this property writable, this test fails and the ceiling
  // note in custom-tool-runner.ts should be revisited — that is the point.
  test("Bun.fetch is a documented, unpatchable bypass", () => {
    guarded("");
    const d = Object.getOwnPropertyDescriptor(Bun, "fetch");
    expect(d?.writable).toBe(false);
    expect(d?.configurable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(globalThis, "Bun")?.writable).toBe(false);
  });
});

describe("custom tool manifest reflects the declared domains", () => {
  const base: CustomToolRecord = {
    version: 1,
    name: "probe_tool",
    description: "d",
    parameters: {},
    code: "export default async () => ({ ok: true, content: '' });",
    createdAt: 0,
    updatedAt: 0,
  };
  const runtime = { executable: "/bin/echo", prefix: [] };

  test("no allowedDomains → networkAccess false", () => {
    const tool = createCustomTool(base, "/tmp/d", ["/tmp/w"], runtime);
    expect(tool.manifest.networkAccess).toBe(false);
    expect(tool.manifest.allowedDomains).toBeUndefined();
  });

  test("declared allowedDomains → networkAccess true and the list is carried", () => {
    const tool = createCustomTool(
      { ...base, allowedDomains: ["api.github.com"] },
      "/tmp/d",
      ["/tmp/w"],
      runtime,
    );
    expect(tool.manifest.networkAccess).toBe(true);
    expect(tool.manifest.allowedDomains).toEqual(["api.github.com"]);
  });

  test("a URL (rather than a hostname) is rejected — it would never match", () => {
    const err = validateCustomTool({
      ...base,
      allowedDomains: ["https://api.github.com/"],
    });
    expect(err).toMatch(/allowed_domains/);
  });

  test("hostnames and wildcards validate", () => {
    expect(
      validateCustomTool({ ...base, allowedDomains: ["api.github.com", "*.example.com", "*"] }),
    ).toBeNull();
  });
});
