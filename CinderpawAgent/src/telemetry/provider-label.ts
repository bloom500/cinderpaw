/**
 * Which provider served a completion, as a short label for usage stats.
 *
 * Derived from the base URL rather than the configured provider kind: "openai"
 * is the dialect a dozen gateways speak, so it says nothing about who was paid.
 * The host does. Loopback is the on-device engine.
 *
 * This is what the LOCAL database keeps. It can be a person's own hostname,
 * so it never leaves the machine as is: `publicProvider` below is the only
 * label that does.
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

/**
 * The BYOK catalog's hosts (crates/cinderpaw-core/src/byok.rs, pinned by
 * tests/provider-label.test.ts against the same golden file the Rust and TUI
 * tests use), keyed the way `providerOf` stores them, to the catalog id.
 */
export const CLOUD_PROVIDERS: Readonly<Record<string, string>> = {
  "openai.com": "openai",
  "anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "kimi.com": "kimi",
  "z.ai": "glm",
  "minimax.io": "minimax",
  "groq.com": "groq",
  "mistral.ai": "mistral",
  "deepseek.com": "deepseek",
  "openrouter.ai": "openrouter",
  "integrate.api.nvidia.com": "nvidia",
  "inference.baseten.co": "baseten",
  "ark.ap-southeast.bytepluses.com": "byteplus",
  "cerebras.ai": "cerebras",
  "llm.chutes.ai": "chutes",
  "cohere.ai": "cohere",
  "deepinfra.com": "deepinfra",
  "featherless.ai": "featherless",
  "fireworks.ai": "fireworks",
  "gmi-serving.com": "gmi",
  "router.huggingface.co": "huggingface",
  "kilo.ai": "kilocode",
  "longcat.chat": "longcat",
  "moonshot.ai": "moonshot",
  "novita.ai": "novita",
  "opencode.ai": "opencode",
  "qianfan.baidubce.com": "qianfan",
  "dashscope-intl.aliyuncs.com": "qwen",
  "stepfun.ai": "stepfun",
  "tokenhub.tencentmaas.com": "tencent-tokenhub",
  "together.xyz": "together",
  "venice.ai": "venice",
  "ark.cn-beijing.volces.com": "volcengine",
  "x.ai": "xai",
  "xiaomimimo.com": "xiaomi",
};

/** Loopback, private and link-local addresses and LAN-only names. */
function isLocalHost(h: string): boolean {
  if (h === "local" || h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true; // host.docker.internal too
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = h.replace(/^\[|\]$/g, "");
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6); // fc00::/7, fe80::/10
}

/**
 * The provider label that may leave the machine: a catalog id for a known
 * cloud, `local` for this computer or the home network, `custom` for any other
 * address. A host a person typed in can name them or their company, so it is
 * never sent.
 */
export function publicProvider(stored: string): string {
  return CLOUD_PROVIDERS[stored] ?? (isLocalHost(stored) ? "local" : "custom");
}
