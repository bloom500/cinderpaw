/**
 * Custom-tool runner — the CHILD side of an agent-authored tool call.
 *
 * The sidecar spawns itself with `--custom-tool-runner <module>` to execute
 * one custom tool (see `custom-tools.ts` for the parent side). Running our
 * own binary is what makes the forge work on an end-user machine: a packaged
 * Feral embeds its Bun runtime, so there is nothing to find on PATH. The
 * previous design shelled out to `bun` or `node` and silently disabled the
 * whole feature — including re-registering already-forged tools at boot —
 * on any machine without a JS runtime installed, i.e. every non-developer.
 *
 * Deliberately dependency-free and side-effect-free at import, and handled
 * before the CLI parser so a module path is never read as a subcommand. It
 * does NOT skip the agent's own module-graph startup, though — see the
 * ponytail note at the call site in `index.ts` for why, and what it costs.
 *
 * Wire contract (must stay in sync with `parseRunnerResult`): args arrive as
 * one JSON object on stdin, the result is the LAST JSON line on stdout —
 * anything the tool itself logs above it is ignored.
 */

import { pathToFileURL } from "node:url";
import { EgressProxy } from "../egress/egress-proxy.ts";
import type { ToolManifest } from "../types.ts";

export const CUSTOM_TOOL_RUNNER_FLAG = "--custom-tool-runner";

/**
 * Comma-separated domain whitelist the PARENT hands the child (see
 * `createCustomTool`). Empty / absent = this tool declared no network, and
 * every request it makes is refused — which is what finally makes the
 * manifest's `networkAccess: false` a statement about the child rather than
 * about the ctx it wasn't given.
 */
export const TOOL_DOMAINS_ENV = "FERAL_TOOL_ALLOWED_DOMAINS";

/**
 * Route the child's `fetch` through the same EgressProxy the in-process tools
 * use: scheme check, SSRF guard (loopback / private / link-local, by hostname
 * AND by every resolved IP), per-hop redirect re-validation, domain whitelist,
 * rate limit.
 *
 * This is the "approach (b)" wiring and it beats an HTTP_PROXY env var for one
 * decisive reason: the EgressProxy is an in-process fetch wrapper, not a proxy
 * server, so there is no port to point HTTP_PROXY at — and because we own the
 * child's entrypoint (the runner IS this binary), there is nothing to preload.
 * It also means the guard cannot accidentally intercept the sidecar's own
 * localhost:11435 inference calls: those happen in the PARENT, which never
 * installs this.
 *
 * ponytail: known ceiling, stated precisely because the comment this replaces
 * was the honest kind and should stay that way. This closes `globalThis.fetch`
 * — which is what tool code and every library it might import actually call.
 * It does NOT close `Bun.fetch` (non-writable, non-configurable — see below),
 * `node:http`, or `node:net`. So this raises the floor from "no enforcement at
 * all" to "the ordinary path is enforced"; it is not a containment boundary,
 * and the CONSENT + SMOKE gates remain the thing that stops hostile code.
 * Closing it properly needs OS-level confinement, not more JS — upgrade path
 * unchanged: a WASI runtime with an explicit preopen set.
 * Second ceiling: responses are buffered as text, so a tool streaming a large
 * binary body gets it mangled — pass the body through if that ever matters.
 */
export function installEgressFetch(env: NodeJS.ProcessEnv = process.env): void {
  const allowedDomains = (env[TOOL_DOMAINS_ENV] ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  const manifest: ToolManifest = {
    name: "custom_tool",
    description: "agent-forged tool (child process)",
    permissions: [],
    networkAccess: allowedDomains.length > 0,
    allowedDomains,
  };
  // The child has no DB, so "audit" is a stderr line. The parent captures
  // stderr and puts it in the tool result, so a blocked request is visible to
  // the agent instead of looking like an unexplained failure.
  // ponytail: the rate-limit window is per-process, i.e. per tool CALL. That
  // is a cap of 30 requests per invocation rather than a global one; a shared
  // budget would need the parent to broker every request.
  // Capture the native fetch BEFORE we replace the global one: the proxy
  // performs the real request itself, and if it resolved `fetch` at call time
  // it would re-enter our guard on every hop.
  const native: typeof fetch = globalThis.fetch.bind(globalThis);
  const proxied = new EgressProxy(
    (e) => {
      if (e.result !== "success") {
        process.stderr.write(`[egress] ${e.result}: ${e.blockedReason ?? "unknown"}\n`);
      }
    },
    { trustedLocalOrigins: [], underlyingFetch: native },
  ).forTool(manifest, "custom-tool");

  const guarded = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await proxied(url, {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body != null ? { body: init.body as string } : {}),
    });
    return new Response(await res.text(), { status: res.status, headers: res.headers });
  };

  globalThis.fetch = guarded as unknown as typeof fetch;
  // NOT closed, and deliberately not pretended otherwise: `Bun.fetch` is a
  // second handle on the same primitive, and both it and the `Bun` global are
  // non-writable AND non-configurable — assignment is a silent no-op and
  // defineProperty throws. Verified, not assumed. `node:http` / `node:net` are
  // likewise reachable. See the ceiling note above: those need OS-level
  // confinement, which is the standing upgrade path.
}

interface RunnerResult {
  ok: boolean;
  content: string;
  data?: unknown;
  error?: string;
}

/** Execute one tool module and write its result line to stdout. Never
 *  throws: a module that blows up is reported as a structured failure,
 *  because the parent distinguishes "tool failed" from "no result at all"
 *  and only the latter should look like a crash. */
export async function runCustomToolModule(modulePath: string): Promise<void> {
  // BEFORE the module is imported — an import-time fetch must be guarded too.
  installEgressFetch();

  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let result: RunnerResult;
  try {
    if (!modulePath) throw new Error(`${CUSTOM_TOOL_RUNNER_FLAG} needs a module path`);
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      default?: (args: unknown) => unknown;
    };
    if (typeof mod.default !== "function") {
      throw new Error("tool module must have a default export function");
    }
    const raw = await mod.default(input.trim() ? JSON.parse(input) : {});
    result =
      raw && typeof raw === "object"
        ? {
            ok: (raw as RunnerResult).ok !== false,
            content: String((raw as RunnerResult).content ?? ""),
            ...((raw as RunnerResult).data !== undefined ? { data: (raw as RunnerResult).data } : {}),
          }
        : { ok: true, content: String(raw ?? "") };
  } catch (err) {
    result = {
      ok: false,
      content: String((err as Error)?.stack || err),
      error: "tool_error",
    };
  }

  // Bun.write (not process.stdout.write) so the bytes are flushed before the
  // caller exits the process — a truncated result line reads to the parent
  // as "the tool produced nothing", which is a different, misleading error.
  await Bun.write(Bun.stdout, "\n" + JSON.stringify(result));
}
