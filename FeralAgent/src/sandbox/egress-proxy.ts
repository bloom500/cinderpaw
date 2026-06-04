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

    // 2. URL must parse and use an allowed scheme.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return block(`malformed URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      block(`disallowed scheme: ${parsed.protocol}`);
    }

    const host = parsed.hostname.toLowerCase();

    // 3. Block loopback / private / link-local destinations (SSRF guard).
    if (isBlockedHost(host)) {
      block(`destination is loopback/private/link-local: ${host}`);
    }

    // 4. Domain whitelist enforcement.
    const allowed = manifest.allowedDomains ?? [];
    if (!hostMatchesWhitelist(host, allowed)) {
      block(`host "${host}" not in allowedDomains for "${manifest.name}"`);
    }

    // 5. Rate limit (rolling window, global across all tools).
    this.#pruneWindow(start);
    if (this.#recent.length >= this.#config.maxRequests) {
      block(
        `rate limit exceeded: ${this.#config.maxRequests} req / ` +
          `${this.#config.windowMs}ms`,
      );
    }
    this.#recent.push(start);

    // 6. Perform the request with an enforced timeout.
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? this.#config.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(parsed.toString(), {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body,
        signal: controller.signal,
        redirect: "follow",
      });

      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
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
        headers,
        text: () => res.text(),
        json: () => res.json() as Promise<unknown>,
      };
    } catch (err) {
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
