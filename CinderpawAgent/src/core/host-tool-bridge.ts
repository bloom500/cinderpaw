/**
 * HostToolBridge — tools the HOST owns, called by the agent, executed outside.
 *
 * Normally Cinderpaw executes its own tools: the registry runs them in-process,
 * inside the sandbox, and the caller only ever sees the answer. This bridge is
 * the other arrangement. The host declares a set of tools it will run itself;
 * when the model calls one, the sidecar emits
 *
 *     { type: "tool_request", id, sessionId, tool, arguments }
 *
 * on stdout and suspends that tool call until the host writes
 *
 *     { type: "tool_response", id, content }        // or { id, error }
 *
 * back on stdin. Same request/response shape as `ask_user` (see
 * `ask-user-bridge.ts`, which this deliberately mirrors), and the same
 * transport-agnostic split: this module knows about events, promises and
 * timeouts, never about who is on the other end.
 *
 * WHY IT EXISTS. Benchmarks and harnesses that own an environment need the
 * agent's tool calls to pass through THEM — not because they want to watch, but
 * because in tau2-bench what gets graded is a fresh environment replayed from
 * the recorded transcript, so a tool call the harness never saw did not happen.
 * An agent that quietly executes its own tools scores zero on every task that
 * writes anything. Generalised: any host that owns state the agent acts on has
 * to be the one acting.
 *
 * OFF UNLESS ASKED. `CINDERPAW_HOST_TOOLS` unset — the overwhelmingly common
 * case, and every case for a normal install — means this file registers
 * nothing and costs nothing. There is no default set of host tools, because a
 * host that has not said what it owns owns nothing.
 *
 * NOT A SANDBOX ESCAPE. A host tool runs in the host process, which spawned
 * this one and already has everything the sidecar has. The bridge hands over
 * arguments and returns text; it grants the agent no permission it did not
 * already have through whoever started it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { schemaToParameters, type MCPToolDef } from "../egress/mcp-client.ts";
import type {
  OutboundEvent,
  Tool,
  ToolContext,
  ToolManifest,
  ToolResult,
} from "../types.ts";

/**
 * How long a single host tool call may stay outstanding.
 *
 * Five minutes matches the ask_user default for the same reason: the thing on
 * the other end may be a person, or a simulation waiting on a person, and a
 * short timeout turns a slow answer into a wrong one. A host that wants to fail
 * faster fails faster by answering with `error`.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface Pending {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: string;
}

export class HostToolBridge {
  readonly #emit: (event: OutboundEvent) => void;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  constructor(emit: (event: OutboundEvent) => void, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.#emit = emit;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Ask the host to run one tool call. Resolves with the host's text result,
   * rejects on host-reported error, timeout, or cancellation.
   *
   * The pending entry is registered BEFORE the event goes out. The emit is
   * synchronous today, but a response that arrived first would find no entry
   * and be dropped as unknown — leaving the promise to time out five minutes
   * later against an answer that was already given. Same ordering discipline as
   * `ChannelAskRouter.ask`, and for the same reason.
   */
  call(
    tool: string,
    args: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `host tool "${tool}" got no answer in ${Math.round(this.#timeoutMs / 1000)}s`,
          ),
        );
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, tool });

      // The registry gives up on a tool call long before this bridge does — its
      // own per-call timeout is 60s by default and it fires `ctx.signal`, then
      // returns a timeout to the model whether or not our promise ever settles.
      // Without this the entry would sit here for the rest of the five minutes,
      // and a late `tool_response` would resolve a call nobody is waiting for.
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(new Error(`host tool "${tool}" cancelled before it was sent`));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const p = this.#pending.get(id);
            if (!p) return;
            clearTimeout(p.timer);
            this.#pending.delete(id);
            p.reject(new Error(`host tool "${tool}" cancelled`));
          },
          { once: true },
        );
      }

      this.#emit({ type: "tool_request", id, sessionId, tool, arguments: args });
    });
  }

  /** Host answered. Called by the transport on `tool_response`. */
  resolve(id: string, content: string): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    p.resolve(content);
    return true;
  }

  /** Host reported a failure for this call. Distinct from the bridge failing. */
  fail(id: string, message: string): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    p.reject(new Error(message));
    return true;
  }

  /** Shutdown / stop: nothing is coming, so say so instead of stalling. */
  cancelAll(reason: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(new Error(`host tool "${p.tool}" cancelled: ${reason}`));
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}

/** What `CINDERPAW_HOST_TOOLS` points at. */
interface HostToolsFile {
  /** MCP's tool-definition shape, reused verbatim — see loadHostTools. */
  tools: MCPToolDef[];
}

/**
 * Read the host's tool declarations and wrap each as a registry Tool.
 *
 * The file is MCP's `{name, description, inputSchema}` shape on purpose rather
 * than a third dialect of the same thing: it is the format every tool server
 * already emits, `schemaToParameters` already understands it (including the
 * `$ref`/`$defs` nesting that pydantic-generated schemas are full of), and a
 * host that already speaks MCP can hand over the list it already has.
 *
 * Names are registered VERBATIM, with no `host_` prefix. The host's tools are
 * usually named by a policy document the model is also given — tau2's airline
 * policy tells the agent to call `book_reservation` — and a prefix would make
 * every one of those references wrong.
 *
 * Throws on a malformed file rather than degrading to an empty list. Everywhere
 * else in this codebase an unreadable config means "carry on with less", but
 * here "less" is an agent that silently cannot touch the only tools that matter,
 * and it would look exactly like a bad model. The caller reports the error where
 * the person who wrote the file can read it.
 */
export function loadHostTools(path: string, bridge: HostToolBridge): Tool[] {
  let parsed: HostToolsFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as HostToolsFile;
  } catch (e) {
    throw new Error(
      `CINDERPAW_HOST_TOOLS: could not read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed.tools)) {
    throw new Error(`CINDERPAW_HOST_TOOLS: ${path} has no "tools" array`);
  }

  return parsed.tools.map((def) => {
    if (!def || typeof def.name !== "string" || !def.name) {
      throw new Error(`CINDERPAW_HOST_TOOLS: ${path} has a tool with no name`);
    }
    const manifest: ToolManifest = {
      name: def.name,
      description: def.description ?? `Host-provided tool: ${def.name}`,
      // None. The call leaves this process entirely; nothing here opens a
      // socket, reads a file or spawns anything on the tool's behalf.
      permissions: [],
      networkAccess: false,
    };
    const parameters = schemaToParameters(def.inputSchema ?? { type: "object" });

    const execute = async (
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      try {
        const content = await bridge.call(def.name, args, ctx.sessionId, ctx.signal);
        return { ok: true, content: content || "(no output)" };
      } catch (err) {
        // The host's own failures reach the model as ordinary tool failures —
        // it can read them and try different arguments, which is the point.
        return {
          ok: false,
          content: `${def.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          error: "execution_error",
        };
      }
    };

    return { manifest, parameters, execute };
  });
}
