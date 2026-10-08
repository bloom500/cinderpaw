/**
 * Which provider served a completion, as a short label for usage stats.
 *
 * Derived from the base URL rather than the configured provider kind: "openai"
 * is the dialect a dozen gateways speak, so it says nothing about who was paid.
 * The host does. Loopback is the on-device engine.
 */
export function providerOf(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local";
  return host.replace(/^(api|www)\./, "");
}
