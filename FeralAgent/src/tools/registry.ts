/**
 * Tool registry — the gate every tool call passes through.
 *
 * Registration validates the manifest (rejecting inconsistent ones) so the
 * registry only ever holds safe tools. Invocation is the single choke point
 * where the sandbox is applied:
 *   - unknown tool name  → blocked + audited, structured error returned
 *   - known tool         → given a ToolContext carrying a fetch bound to *its*
 *                          permissions and the audit logger, then executed
 * The agent can only reach tools through this registry, so a tool can never be
 * invoked outside the sandbox and can never exercise an undeclared permission.
 */

import type { EgressProxy } from "../sandbox/egress-proxy.ts";
import type { AuditLog } from "../sandbox/audit-log.ts";
import { validateManifest } from "../sandbox/tool-permissions.ts";
import type {
  Tool,
  ToolContext,
  ToolParameter,
  ToolResult,
} from "../types.ts";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #egress: EgressProxy;
  readonly #audit: AuditLog;

  constructor(egress: EgressProxy, audit: AuditLog) {
    this.#egress = egress;
    this.#audit = audit;
  }

  /** Register a tool after validating its manifest. Throws on bad manifests. */
  register(tool: Tool): void {
    validateManifest(tool.manifest);
    if (this.#tools.has(tool.manifest.name)) {
      throw new Error(`tool "${tool.manifest.name}" already registered`);
    }
    this.#tools.set(tool.manifest.name, tool);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** All registered tools, for prompt construction. */
  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /**
   * Invoke a tool by name within the sandbox. Never throws: every failure
   * (unknown tool, permission denial, execution error) is caught, audited, and
   * returned as a structured ToolResult.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<ToolResult> {
    const start = Date.now();
    const tool = this.#tools.get(name);

    if (!tool) {
      this.#audit.log({
        sessionId,
        actionType: "blocked",
        toolName: name,
        argsJson: safeJson(args),
        result: "blocked",
        blockedReason: `unknown or unregistered tool "${name}"`,
      });
      return {
        ok: false,
        content: `Tool "${name}" is not available.`,
        error: "unknown_tool",
      };
    }

    const ctx: ToolContext = {
      sessionId,
      manifest: tool.manifest,
      fetch: this.#egress.forTool(tool.manifest, sessionId),
      audit: this.#audit.logger,
    };

    try {
      const result = await tool.execute(args, ctx);
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: result.ok ? "success" : "error",
        blockedReason: result.ok ? undefined : result.error,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: "error",
        blockedReason: String(err),
        durationMs: Date.now() - start,
      });
      return {
        ok: false,
        content: `Tool "${name}" failed: ${String(err)}`,
        error: "execution_error",
      };
    }
  }

  /** A compact, model-facing description of all tools and their parameters. */
  describe(): string {
    return this.list()
      .map((tool) => {
        const params = Object.entries(tool.parameters)
          .map(([key, p]) => describeParam(key, p))
          .join(", ");
        return `- ${tool.manifest.name}(${params}): ${tool.manifest.description}`;
      })
      .join("\n");
  }
}

function describeParam(key: string, p: ToolParameter): string {
  const optional = p.required === false ? "?" : "";
  return `${key}${optional}: ${p.type} — ${p.description}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable args]"';
  }
}
