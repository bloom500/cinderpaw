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
}

const DEFAULT_CONFIG: EgressProxyConfig = {
  maxRequests: 30,
  windowMs: 60_000,
  defaultTimeoutMs: 15_000,
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
        const res = await fetch(parsed.toString(), {
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

/** True when a host is loopback, a private range, or link-local. */
export function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // Unique-local IPv6 (fc00::/7) and link-local IPv6 (fe80::/10).
  if (/^\[?(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host)) return true;

  const v4 = parseIPv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this" network
    return false;
  }

  return false;
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
 * of an entry (so `api.example.com` matches `example.com`).
 */
export function hostMatchesWhitelist(host: string, whitelist: string[]): boolean {
  return whitelist.some((entry) => {
    const e = entry.toLowerCase().replace(/^\*\./, "");
    return host === e || host.endsWith(`.${e}`);
  });
}
