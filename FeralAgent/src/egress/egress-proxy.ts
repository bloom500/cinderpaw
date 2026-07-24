/**
 * Egress proxy — the single network exit for the entire agent.
 *
 * Non-negotiable constraint: no network request may bypass `feralFetch`. Tools
 * receive a *bound* fetch from `EgressProxy.forTool()` that enforces, for every
 * request:
 *   - the host is in the calling tool's `allowedDomains` whitelist
 *   - the host is not localhost / loopback
 *   - the host is not a private / link-local IP range
 *   - the global rate limit has not been exceeded
 * Every attempt — allowed or blocked — is written to the audit log.
 */

import { lookup } from "node:dns/promises";
import type {
  AuditLogger,
  FeralFetch,
  FeralFetchInit,
  FeralFetchResponse,
  ToolManifest,
} from "../types.ts";

export interface EgressProxyConfig {
  /** Max requests allowed inside the rolling window. */
  maxRequests: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Default per-request timeout when a tool does not specify one. */
  defaultTimeoutMs: number;
  /**
   * Exact origins (scheme + host + port) the OPERATOR has declared they run
   * themselves — the only way a loopback/private destination is ever reachable.
   * Exists for self-hosted sidecar services (a SearXNG instance backing
   * web_search, `FERAL_SEARXNG_URL`), which live on localhost by design and
   * would otherwise be blocked by our own SSRF guard.
   *
   * The exemption is deliberately narrow:
   *   - exact-origin match, never a suffix/host match — `http://127.0.0.1:8888`
   *     does not license `http://127.0.0.1:9000` or any other internal port;
   *   - it waives ONLY the private-address guard. The tool's `allowedDomains`
   *     whitelist is still enforced, so a tool that never declared the host
   *     cannot reach it even when it is exempt;
   *   - it is re-checked per hop, so a redirect off the origin lands back
   *     under the full guard;
   *   - it comes from process env, i.e. the human running the process — never
   *     from the model, a tool argument, or a fetched page.
   */
  trustedLocalOrigins: string[];
  /**
   * The underlying fetch the proxy performs the request WITH. Defaults to the
   * global one, which is right everywhere except in the custom-tool child:
   * there the guard replaces `globalThis.fetch` with a proxy-backed one, so a
   * proxy that resolved `fetch` at call time would call itself, once per hop,
   * until the rate limiter stopped it. Capture the native fetch, inject it.
   */
  underlyingFetch: (url: string, init: RequestInit) => Promise<Response>;
}

const DEFAULT_CONFIG: EgressProxyConfig = {
  maxRequests: 30,
  windowMs: 60_000,
  defaultTimeoutMs: 15_000,
  trustedLocalOrigins: [],
  underlyingFetch: (url, init) => fetch(url, init),
};

export class EgressProxy {
  readonly #audit: AuditLogger;
  readonly #config: EgressProxyConfig;
  /** Timestamps of recent requests for the rolling-window rate limiter. */
  readonly #recent: number[] = [];

  constructor(audit: AuditLogger, config: Partial<EgressProxyConfig> = {}) {
    this.#audit = audit;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Produce a fetch bound to a single tool's permissions. The returned function
   * is the only network primitive a tool is ever given.
   */
  forTool(manifest: ToolManifest, sessionId: string): FeralFetch {
    return (url: string, init?: FeralFetchInit) =>
      this.#fetch(manifest, sessionId, url, init);
  }

  async #fetch(
    manifest: ToolManifest,
    sessionId: string,
    url: string,
    init?: FeralFetchInit,
  ): Promise<FeralFetchResponse> {
    const start = Date.now();

    const block = (reason: string): never => {
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "blocked",
        toolName: manifest.name,
        argsJson: JSON.stringify({ url }),
        result: "blocked",
        blockedReason: reason,
        durationMs: Date.now() - start,
      });
      throw new EgressBlockedError(reason);
    };

    // 1. The tool must actually be permitted to use the network at all.
    if (!manifest.networkAccess) {
      block(`tool "${manifest.name}" has no network access`);
    }

    const allowed = manifest.allowedDomains ?? [];

    // Validate a single URL hop: scheme, SSRF host guard (by hostname string
    // AND by every resolved IP), and the tool's domain whitelist. Run on the
    // initial URL *and* on every redirect target — `fetch(redirect:"follow")`
    // would chase a 3xx to an internal address without re-checking anything,
    // turning any whitelisted (or compromised) host into an SSRF pivot.
    const validateHop = async (raw: string): Promise<URL> => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return block(`malformed URL: ${raw}`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        block(`disallowed scheme: ${parsed.protocol}`);
      }
      const host = parsed.hostname.toLowerCase();
      // An operator-declared self-hosted origin (see `trustedLocalOrigins`)
      // waives the private-address guard for THIS hop only. Exact-origin
      // match: the port is part of the identity, so trusting one local
      // service does not trust the rest of the loopback interface. The
      // domain whitelist below still applies — this is not an open door.
      const trustedLocal = this.#config.trustedLocalOrigins.includes(parsed.origin);
      if (!trustedLocal) {
        // SSRF guard by hostname string (literal IPs, localhost, ULA/link-local).
        if (isBlockedHost(host)) {
          block(`destination is loopback/private/link-local: ${host}`);
        }
        // SSRF guard by resolved IP — defeats DNS rebinding and any hostname
        // that points into a private range. Every A/AAAA answer must be public.
        for (const ip of await resolveHostIps(host)) {
          if (isBlockedHost(ip.toLowerCase())) {
            block(`host "${host}" resolves to a blocked address: ${ip}`);
          }
        }
      }
      // Domain whitelist enforcement.
      if (!hostMatchesWhitelist(host, allowed)) {
        block(`host "${host}" not in allowedDomains for "${manifest.name}"`);
      }
      return parsed;
    };

    // 2-4. Validate the first hop before anything touches the network.
    let parsed = await validateHop(url);

    // 5. Rate limit (rolling window, global across all tools). Counts the
    //    request once regardless of how many redirects it follows.
    this.#pruneWindow(start);
    if (this.#recent.length >= this.#config.maxRequests) {
      block(
        `rate limit exceeded: ${this.#config.maxRequests} req / ` +
          `${this.#config.windowMs}ms`,
      );
    }
    this.#recent.push(start);

    // 6. Perform the request with an enforced timeout, following redirects
    //    MANUALLY so every hop is re-validated by `validateHop`.
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? this.#config.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onCallerAbort: (() => void) | undefined;
    if (init?.signal) {
      onCallerAbort = () => controller.abort(init.signal?.reason);
      if (init.signal.aborted) {
        onCallerAbort();
      } else {
        init.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const MAX_REDIRECTS = 5;

    try {
      let method = init?.method ?? "GET";
      let body = init?.body;
      // Copy caller headers so we can strip credentials on a cross-origin hop
      // without mutating the caller's object.
      let headers: Record<string, string> = { ...(init?.headers ?? {}) };
      let currentHost = parsed.hostname.toLowerCase();

      for (let hop = 0; ; hop++) {
        const res = await this.#config.underlyingFetch(parsed.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });

        // 3xx with a Location → re-validate the target and continue.
        const isRedirect =
          res.status >= 300 && res.status < 400 && res.headers.has("location");
        if (isRedirect) {
          if (hop >= MAX_REDIRECTS) {
            block(`too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`);
          }
          const loc = res.headers.get("location")!;
          const next = new URL(loc, parsed); // resolve relative Location
          // Per fetch semantics: 303 (and 301/302 on an unsafe method)
          // downgrades the follow-up to GET and drops the body.
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) &&
              method !== "GET" &&
              method !== "HEAD")
          ) {
            method = "GET";
            body = undefined;
          }
          // Drop credentials when the origin changes so a redirect can't
          // leak an Authorization/Cookie header to a different host.
          const nextHost = next.hostname.toLowerCase();
          if (nextHost !== currentHost) {
            for (const k of Object.keys(headers)) {
              const lk = k.toLowerCase();
              if (lk === "authorization" || lk === "cookie" || lk === "proxy-authorization") {
                delete headers[k];
              }
            }
            currentHost = nextHost;
          }
          parsed = await validateHop(next.toString());
          continue;
        }

        // Final (non-redirect) response.
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });

        this.#audit({
          timestamp: Date.now(),
          sessionId,
          actionType: "network",
          toolName: manifest.name,
          argsJson: JSON.stringify({ url, method: init?.method ?? "GET" }),
          result: "success",
          durationMs: Date.now() - start,
        });

        return {
          status: res.status,
          ok: res.ok,
          headers: respHeaders,
          text: () => res.text(),
          json: () => res.json() as Promise<unknown>,
        };
      }
    } catch (err) {
      // A blocked redirect throws EgressBlockedError (already audited by
      // `block`); re-throw it as-is so callers see the block reason.
      if (err instanceof EgressBlockedError) throw err;
      const message =
        controller.signal.aborted
          ? `request timed out after ${timeoutMs}ms`
          : String(err);
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "network",
        toolName: manifest.name,
        argsJson: JSON.stringify({ url }),
        result: "error",
        blockedReason: message,
        durationMs: Date.now() - start,
      });
      throw new EgressError(message);
    } finally {
      clearTimeout(timer);
      if (onCallerAbort && init?.signal) {
        init.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  #pruneWindow(now: number): void {
    const cutoff = now - this.#config.windowMs;
    while (this.#recent.length > 0 && this.#recent[0]! < cutoff) {
      this.#recent.shift();
    }
  }
}

export class EgressBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EgressBlockedError";
  }
}

export class EgressError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EgressError";
  }
}

/** True when `host` is already an IP literal (no DNS resolution needed). */
function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

/**
 * Resolve a hostname to every A/AAAA address so each can be checked against
 * the SSRF guard. Literal IPs resolve to themselves. On resolution failure we
 * return `[]` rather than blocking — the hostname-string and whitelist checks
 * have already run, and a DNS hiccup shouldn't masquerade as a security block;
 * the subsequent `fetch` will surface the real network error.
 */
async function resolveHostIps(host: string): Promise<string[]> {
  if (isIpLiteral(host)) return [host.replace(/^\[|\]$/g, "")];
  try {
    const records = await lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * True when a host is loopback, a private range, or link-local.
 *
 * IPv6 is decoded rather than string-matched. The old check tested for the
 * literal text `::1`, which meant every other spelling of the same address
 * walked through: `[0:0:0:0:0:0:0:1]` is loopback, and `[::ffff:127.0.0.1]` is
 * loopback wearing an IPv6 costume — neither is the string "::1". An address is
 * a number, so compare numbers.
 */
export function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v6 = parseIPv6(host);
  if (v6) {
    // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 address; judge it by the v4
    // rules, or ::ffff:127.0.0.1 is a loopback they never get to see.
    const mapped =
      v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    if (mapped) return isBlockedV4(v6[12]!, v6[13]!);

    if (v6.every((b, i) => (i < 15 ? b === 0 : b === 1))) return true; // ::1
    if (v6.every((b) => b === 0)) return true; // ::
    if ((v6[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7
    if (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    return false;
  }

  const v4 = parseIPv4(host);
  if (v4) return isBlockedV4(v4[0], v4[1]);

  return false;
}

function isBlockedV4(a: number, b: number): boolean {
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this" network
  return false;
}

/**
 * Decode an IPv6 literal (brackets optional) into its 16 bytes, or null when
 * `host` is not one. Handles `::` elision and an embedded IPv4 tail.
 */
export function parseIPv6(host: string): number[] | null {
  const raw = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!raw.includes(":")) return null;

  let text = raw;
  let v4: [number, number, number, number] | null = null;

  // A trailing dotted-quad (::ffff:127.0.0.1) occupies the last two groups.
  const lastSep = text.lastIndexOf(":");
  const tail = text.slice(lastSep + 1);
  if (tail.includes(".")) {
    v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastSep + 1)}0:0`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const split = (s: string) => (s === "" ? [] : s.split(":"));
  const left = split(halves[0] ?? "");
  const right = halves.length === 2 ? split(halves[1] ?? "") : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const elided = 8 - (left.length + right.length);
    if (elided < 1) return null;
    groups = [...left, ...Array<string>(elided).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

/** Parse a dotted-quad IPv4 literal, or null if `host` is not one. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((p) => Number(p));
  if (parts.some((n) => n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/**
 * A host matches the whitelist if it equals an entry exactly or is a subdomain
 * of an entry (so `api.example.com` matches `example.com`). The single entry
 * `"*"` matches every host — used for open-egress tools. This is NOT an SSRF
 * bypass: isBlockedHost() runs before the whitelist on every hop, so loopback/
 * private/link-local destinations stay blocked even under `"*"`. The ONE
 * exception is an origin the operator listed in `trustedLocalOrigins` (a
 * self-hosted service they run) — see that field's contract.
 */
export function hostMatchesWhitelist(host: string, whitelist: string[]): boolean {
  return whitelist.some((entry) => {
    if (entry === "*") return true;
    const e = entry.toLowerCase().replace(/^\*\./, "");
    return host === e || host.endsWith(`.${e}`);
  });
}
