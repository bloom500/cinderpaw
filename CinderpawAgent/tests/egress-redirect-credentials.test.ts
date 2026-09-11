/**
 * A redirect must not carry credentials to a different ORIGIN — not just to a
 * different hostname.
 *
 * The guard in egress-proxy compared `next.hostname !== currentHost` while its
 * own comment said "drop credentials when the origin changes". Scheme and port
 * are part of an origin and were not part of the comparison, so
 * `https://host/...` → `http://host/...` kept the Authorization header and put
 * the key on the wire in clear. The same held for a port change, which is a
 * different service on the same machine.
 *
 * These tests pin all three directions: downgrade, port change, and the
 * same-origin case that must KEEP the header, so the fix cannot be "strip
 * always", which would break every API that redirects /v1 to /v1/.
 */

import { describe, expect, test } from "bun:test";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import type { AuditEntry, ToolManifest } from "../src/types.ts";

const MANIFEST: ToolManifest = {
  name: "redirect_probe",
  description: "test tool",
  permissions: ["network"],
  networkAccess: true,
  allowedDomains: ["localhost"],
};

/**
 * One hop recorded exactly as the proxy sent it.
 *
 * Loopback origins are used deliberately: declared in `trustedLocalOrigins`
 * they skip the private-address guard and, more importantly, need no DNS, so
 * the test is hermetic. `underlyingFetch` never touches a socket.
 */
interface Hop {
  url: string;
  headers: Record<string, string>;
}

function proxyWith(
  redirects: Record<string, string>,
  trusted: string[],
): { proxy: EgressProxy, hops: Hop[], audit: AuditEntry[] } {
  const hops: Hop[] = [];
  const audit: AuditEntry[] = [];
  const proxy = new EgressProxy((e) => audit.push(e), {
    trustedLocalOrigins: trusted,
    underlyingFetch: ((url: string, init?: RequestInit) => {
      hops.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      const location = redirects[url];
      if (location) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location } }),
        );
      }
      return Promise.resolve(new Response("done", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  return { proxy, hops, audit };
}

const AUTH = { authorization: "Bearer sk-secret", cookie: "session=abc" };

describe("redirect credential handling", () => {
  test("an https → http downgrade on the same host drops the credentials", async () => {
    const { proxy, hops } = proxyWith(
      { "https://localhost/v1": "http://localhost/v1" },
      ["https://localhost", "http://localhost"],
    );
    await proxy.forTool(MANIFEST, "s1")("https://localhost/v1", { headers: { ...AUTH } });

    expect(hops).toHaveLength(2);
    expect(hops[0]!.headers.authorization).toBe("Bearer sk-secret");
    // The whole point: the key must not ride a cleartext hop.
    expect(hops[1]!.headers.authorization).toBeUndefined();
    expect(hops[1]!.headers.cookie).toBeUndefined();
  });

  test("a port change on the same host and scheme drops the credentials", async () => {
    const { proxy, hops } = proxyWith(
      { "http://localhost:8080/a": "http://localhost:9090/b" },
      ["http://localhost:8080", "http://localhost:9090"],
    );
    await proxy.forTool(MANIFEST, "s1")("http://localhost:8080/a", { headers: { ...AUTH } });

    expect(hops).toHaveLength(2);
    // A different port is a different service, even on your own machine.
    expect(hops[1]!.headers.authorization).toBeUndefined();
  });

  test("a same-origin redirect keeps the credentials", async () => {
    const { proxy, hops } = proxyWith(
      { "https://localhost/v1": "https://localhost/v1/" },
      ["https://localhost"],
    );
    await proxy.forTool(MANIFEST, "s1")("https://localhost/v1", { headers: { ...AUTH } });

    expect(hops).toHaveLength(2);
    // Stripping here would break every API that redirects a path to its
    // canonical form, which is the ordinary case, not the attack.
    expect(hops[1]!.headers.authorization).toBe("Bearer sk-secret");
  });

  test("the audit entry names the host actually reached, not just the one asked for", async () => {
    const { proxy, audit } = proxyWith(
      { "https://localhost/v1": "http://localhost:9090/elsewhere" },
      ["https://localhost", "http://localhost:9090"],
    );
    await proxy.forTool(MANIFEST, "s1")("https://localhost/v1", { headers: { ...AUTH } });

    const success = audit.find((e) => e.result === "success");
    expect(success).toBeDefined();
    // "What did it actually talk to" has to be answerable from the log alone.
    expect(success!.argsJson).toContain("http://localhost:9090/elsewhere");
  });
});
