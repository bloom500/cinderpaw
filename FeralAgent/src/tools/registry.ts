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
 *
 * Retry policy (P0-#5): tools that declare `manifest.retry` get up to
 * `attempts` retries with linear backoff (250ms × attempt) when the failure
 * matches a category in `on`. Tools without a `retry` manifest behave
 * exactly as before — a single attempt, no retry.
 *
 *   - "http"    → retry when the tool returned { ok: false, error: "http_error" | "network_error" }
 *   - "process" → retry when the tool.execute() call threw
 *   - "any"     → retry on any failure (http OR process)
 *
 * Each attempt (including the failed ones) is audited and observed. The
 * audit/observation rows let an operator reconstruct *why* a tool eventually
 * failed, not just the final outcome. Backoff sleeps are linear (250, 500,
 * 750, … ms) — exponential would be appropriate for cloud APIs but the
 * transport here is mostly local loopback where shorter backoffs recover
 * faster and the added wall-clock per attempt is trivial.
 */

import type { EgressProxy } from "../sandbox/egress-proxy.ts";
import type { AuditLog } from "../sandbox/audit-log.ts";
import { validateManifest } from "../sandbox/tool-permissions.ts";
import type {
  AskUserBridge,
  ProcessSandbox,
  Tool,
  ToolCallOptions,
  ToolContext,
  ToolParameter,
  ToolResult,
  ToolRetryCategory,
  ToolRetryPolicy,
} from "../types.ts";
import type { ToolObservationLog } from "../telemetry/tool-observations.ts";
import { CircuitBreaker } from "../sandbox/circuit-breaker.ts";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #egress: EgressProxy;
  readonly #audit: AuditLog;
  readonly #process: ProcessSandbox;
  readonly #observations: ToolObservationLog | null;
  readonly #askUser: AskUserBridge | null;
  /**
   * Per-tool circuit breaker (P2-#2). Tracks consecutive failures and
   * short-circuits calls to tools that are clearly sick. Saves LLM
   * round-trips on flaky downstream APIs / runaway subprocesses.
   * Read-only inspection via `breakerStateOf(tool)` for debugging.
   */
  readonly #breaker: CircuitBreaker;
  /**
   * Optional hook registry (P0-4). `before_tool_call` handlers can
   * block a call; `after_tool_call` handlers are informational.
   * Default no-op so unit tests and the bare-minimum wiring don't
   * need to know about hooks.
   */
  readonly #hooks: import("../core/hook-registry.ts").HookRegistry | null;

  constructor(
    egress: EgressProxy,
    audit: AuditLog,
    process: ProcessSandbox,
    observations?: ToolObservationLog,
    askUser?: AskUserBridge,
    breaker?: CircuitBreaker,
    hooks?: import("../core/hook-registry.ts").HookRegistry,
  ) {
    this.#egress = egress;
    this.#audit = audit;
    this.#process = process;
    this.#observations = observations ?? null;
    this.#askUser = askUser ?? null;
    this.#breaker = breaker ?? new CircuitBreaker();
    this.#hooks = hooks ?? null;
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
   *
   * Honors `tool.manifest.retry` (P0-#5): up to `attempts` extra calls with
   * linear backoff when the failure matches one of the `on` categories.
   * Tools without a retry manifest take the single-attempt path.
   *
   * Honors `opts.signal` + `opts.timeoutMs` (P0-#3): the registry creates a
   * per-call AbortController that combines the caller's signal with an
   * internal timeout, then hands the resulting signal to the tool via
   * `ctx.signal`. If the caller's signal aborts (AgentLoop.stop) or the
   * timeout fires, the tool's `ctx.signal` becomes aborted AND the registry
   * returns a structured error so the agent loop sees a clean stop / timeout
   * even if the tool itself never resolves.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    sessionId: string,
    opts: ToolCallOptions = {},
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

    // P0-4: before_tool_call hook. A blocking handler aborts the call
    // with a structured error and an audit row tagged with the reason.
    // The hook never throws (the registry catches + logs); a block is
    // a deliberate `{ block: true, reason }` return.
    if (this.#hooks) {
      const hookResult = await this.#hooks.fire("before_tool_call", {
        tool: name,
        args,
        sessionId,
      });
      if (hookResult?.block) {
        this.#audit.log({
          sessionId,
          actionType: "blocked",
          toolName: name,
          argsJson: safeJson(args),
          result: "blocked",
          blockedReason: `hook: ${hookResult.reason}`,
        });
        return {
          ok: false,
          content: `Tool "${name}" blocked by hook: ${hookResult.reason}`,
          error: "blocked_by_hook",
        };
      }
    }

    // P2-#2: per-tool circuit breaker. If the tool is currently in
    // OPEN or has a HALF_OPEN probe in flight, short-circuit with a
    // structured error so the LLM gets a clean "this tool is sick"
    // signal without burning a 60s timeout.
    const breakerCheck = this.#breaker.check(name);
    if (!breakerCheck.allow) {
      this.#audit.log({
        sessionId,
        actionType: "blocked",
        toolName: name,
        argsJson: safeJson(args),
        result: "blocked",
        blockedReason: breakerCheck.reason ?? "circuit_open",
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: false,
        durationMs: 0,
        error: breakerCheck.reason ?? "circuit_open",
        argsKeys: Object.keys(args),
      });
      return {
        ok: false,
        content: `Tool "${name}" short-circuited: ${breakerCheck.reason}. Try a different approach or wait for recovery.`,
        error: "circuit_open",
      };
    }

    // Per-call abort controller. Combines:
    //   1. caller-supplied signal (e.g. AgentLoop.stop() / a test's abort)
    //   2. internal timeout (default 60s, overridable per call)
    // The combined signal is what the tool sees via `ctx.signal`.
    const ac = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
    const onCallerAbort = () => ac.abort("cancelled");
    if (opts.signal) {
      if (opts.signal.aborted) {
        ac.abort("cancelled");
      } else {
        opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const ctx: ToolContext = {
      sessionId,
      signal: ac.signal,
      manifest: tool.manifest,
      fetch: this.#egress.forTool(tool.manifest, sessionId),
      audit: this.#audit.logger,
      // Only expose the process sandbox to tools that declared
      // `process:spawn`. Other tools receive `undefined` so a typo or
      // a misconfigured call site fails loudly at the property access,
      // not silently.
      process: tool.manifest.permissions.includes("process:spawn")
        ? this.#process
        : undefined,
      // askUser is always available when the registry was constructed
      // with a bridge; the ask_user tool checks ctx.askUser is defined
      // and refuses to run otherwise.
      askUser: this.#askUser ?? undefined,
    };

    const policy = tool.manifest.retry;

    // Fast path: no retry policy → original single-attempt behavior. Kept
    // separate so the hot path stays zero-overhead for tools that don't opt in.
    if (!policy || policy.attempts <= 0) {
      const outcome = await raceWithAbort(
        () => this.#executeOnce(name, tool, ctx, args, sessionId, start),
        ac.signal,
      );
      if (typeof outcome === "object" && outcome !== null && "kind" in outcome && outcome.kind === "aborted") {
        const aborted = finalize(
          {
            ok: false,
            content: `Tool "${name}" aborted: ${outcome.reason}`,
            error: outcome.reason === "timeout" ? "timeout" : "cancelled",
          },
          ac,
          timer,
          opts.signal,
          onCallerAbort,
        );
        if (this.#hooks) {
          try {
            await this.#hooks.fire("after_tool_call", {
              tool: name,
              args,
              result: { ok: aborted.ok, content: aborted.content, error: aborted.error },
              sessionId,
              durationMs: Date.now() - start,
            });
          } catch (err) {
            process.stderr.write(`[tools] after_tool_call hook fire failed: ${String(err)}\n`);
          }
        }
        return aborted;
      }
      const ok = finalize(outcome as ToolResult, ac, timer, opts.signal, onCallerAbort);
      if (this.#hooks) {
        try {
          await this.#hooks.fire("after_tool_call", {
            tool: name,
            args,
            result: { ok: ok.ok, content: ok.content, error: ok.error },
            sessionId,
            durationMs: Date.now() - start,
          });
        } catch (err) {
          process.stderr.write(`[tools] after_tool_call hook fire failed: ${String(err)}\n`);
        }
      }
      return ok;
    }

    // Retry path: try up to attempts+1 times, sleeping backoffMs * attempt
    // between failed attempts. The last observed result (or thrown error) is
    // returned if all attempts are exhausted.
    const maxAttempts = policy.attempts + 1;
    let lastFailedResult: ToolResult | null = null;
    let lastThrown: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Honour caller cancellation between attempts too — no point retrying
      // a tool the user has already stopped.
      if (ac.signal.aborted) {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
        return {
          ok: false,
          content: `Tool "${name}" cancelled after ${attempt - 1} attempt(s).`,
          error: "cancelled",
        };
      }
      if (attempt > 1) {
        await sleep(RETRY_BACKOFF_MS * (attempt - 1));
      }
      const outcome = await raceWithAbort(
        () => this.#executeOnceCapture(name, tool, ctx, args, sessionId, start),
        ac.signal,
      );
      if (outcome.kind === "ok") {
        return finalize(outcome.result, ac, timer, opts.signal, onCallerAbort);
      }
      if (outcome.kind === "result") {
        lastFailedResult = outcome.result;
        if (!isRetryable(policy, outcome.result)) {
          return finalize(outcome.result, ac, timer, opts.signal, onCallerAbort);
        }
      } else if (outcome.kind === "thrown") {
        // "thrown" — recorded as an execution_error inside #executeOnceCapture
        lastThrown = outcome.error;
        if (!isRetryable(policy, "thrown")) {
          return finalize(
            {
              ok: false,
              content: `Tool "${name}" failed: ${String(outcome.error)}`,
              error: "execution_error",
            },
            ac,
            timer,
            opts.signal,
            onCallerAbort,
          );
        }
      } else {
        // "aborted" — the timeout or caller signal fired. The agent loop
        // gets a clean stop/timeout result so it can keep moving.
        return finalize(
          {
            ok: false,
            content: `Tool "${name}" aborted: ${outcome.reason}`,
            error: outcome.reason === "timeout" ? "timeout" : "cancelled",
          },
          ac,
          timer,
          opts.signal,
          onCallerAbort,
        );
      }
    }

    // Retries exhausted. Prefer the last structured result (preserves the
    // tool's own error code) over the synthetic execution_error wrapper.
    const finalResult: ToolResult = lastFailedResult ?? {
      ok: false,
      content: `Tool "${name}" failed: ${String(lastThrown)}`,
      error: "execution_error",
    };
    const result = finalize(finalResult, ac, timer, opts.signal, onCallerAbort);

    // P0-4: after_tool_call hook. Informational — runs after audit +
    // observation + circuit-breaker are recorded, so handlers can
    // observe the same view of the world the rest of the system has.
    // Errors are swallowed inside the registry; the result is what the
    // agent loop sees regardless of hook behaviour.
    if (this.#hooks) {
      try {
        await this.#hooks.fire("after_tool_call", {
          tool: name,
          args,
          result: { ok: result.ok, content: result.content, error: result.error },
          sessionId,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        process.stderr.write(
          `[tools] after_tool_call hook fire failed: ${String(err)}\n`,
        );
      }
    }

    return result;
  }

  /**
   * Single attempt: run the tool, audit + observe the outcome, return the
   * structured result. Catches throws and converts them to a synthetic
   * `{ok:false, error: "execution_error"}` result so the retry loop above
   * can inspect them through a single code path.
   *
   * Returned shape is a discriminated union so the retry loop can tell
   * "tool returned a structured failure" from "tool threw" without a second
   * try/catch.
   */
  async #executeOnce(
    name: string,
    tool: Tool,
    ctx: ToolContext,
    args: Record<string, unknown>,
    sessionId: string,
    startedAt: number,
  ): Promise<ToolResult> {
    const outcome = await this.#executeOnceCapture(name, tool, ctx, args, sessionId, startedAt);
    if (outcome.kind === "ok" || outcome.kind === "result") return outcome.result;
    return {
      ok: false,
      content: `Tool "${name}" failed: ${String(outcome.error)}`,
      error: "execution_error",
    };
  }

  async #executeOnceCapture(
    name: string,
    tool: Tool,
    ctx: ToolContext,
    args: Record<string, unknown>,
    sessionId: string,
    startedAt: number,
  ): Promise<
    | { kind: "ok"; result: ToolResult }
    | { kind: "result"; result: ToolResult }
    | { kind: "thrown"; error: unknown }
  > {
    try {
      const result = await tool.execute(args, ctx);
      const durationMs = Date.now() - startedAt;
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: result.ok ? "success" : "error",
        blockedReason: result.ok ? undefined : result.error,
        durationMs,
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: result.ok,
        durationMs,
        error: result.ok ? null : (result.error ?? result.content.slice(0, 120)),
        argsKeys: Object.keys(args),
      });
      // P2-#2: feed the circuit breaker. A success resets the failure
      // log; a structured failure counts as a failure. The breaker
      // opens after `failureThreshold` consecutive failures.
      if (result.ok) {
        this.#breaker.recordSuccess(name);
      } else {
        this.#breaker.recordFailure(name);
      }
      return result.ok
        ? { kind: "ok", result }
        : { kind: "result", result };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: "error",
        blockedReason: String(err),
        durationMs,
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: false,
        durationMs,
        error: String(err).slice(0, 120),
        argsKeys: Object.keys(args),
      });
      // P2-#2: a thrown error is also a failure for the breaker.
      this.#breaker.recordFailure(name);
      return { kind: "thrown", error: err };
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

  /**
   * Inspect a tool's circuit-breaker state (P2-#2). Public for
   * debugging, observability, and the agent's self-diagnosis
   * (`tool_health` tool). Cheap O(1) lookup.
   */
  breakerStateOf(tool: string): "closed" | "open" | "half_open" {
    return this.#breaker.stateOf(tool);
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

/** Linear backoff base — see module docstring for rationale. */
const RETRY_BACKOFF_MS = 250;

/**
 * Default per-tool wall-clock timeout. Most V1 tools finish in well under
 * a second on local resources; 60s is a generous ceiling that still bounds
 * the agent loop against hung FS / hung fetch / runaway subprocesses. Callers
 * (tests, ad-hoc scripts) can override per-call via `opts.timeoutMs`.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Cleanup helper invoked at every return point of `call()`. Releases the
 * timeout timer and the caller's abort listener so neither leaks across
 * multiple calls in the same session.
 *
 * Also handles the case where the tool's own result is from an aborted
 * race — in that case we replace the (potentially stale) `result` with a
 * structured timeout/cancellation error so the LLM sees a clear signal.
 */
function finalize(
  result: ToolResult,
  ac: AbortController,
  timer: ReturnType<typeof setTimeout>,
  callerSignal: AbortSignal | undefined,
  onCallerAbort: () => void,
): ToolResult {
  clearTimeout(timer);
  if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  // If the race was lost (timeout or caller-cancel) but the inner promise
  // eventually settled with a "success" result, downgrade to a structured
  // error so the LLM knows the call was interrupted, not successful.
  if (ac.signal.aborted) {
    const reason = ac.signal.reason;
    if (reason === "timeout") {
      return {
        ok: false,
        content: `Tool aborted: timeout`,
        error: "timeout",
      };
    }
    if (reason === "cancelled") {
      return {
        ok: false,
        content: `Tool aborted: cancelled`,
        error: "cancelled",
      };
    }
  }
  return result;
}

/**
 * Race a producer against an abort signal. The producer is invoked lazily
 * (so we don't start a tool call we know is already cancelled). When the
 * signal aborts first, we return an `"aborted"` outcome carrying the
 * abort reason (`"timeout"` | `"cancelled"`), so the caller can build a
 * structured error.
 *
 * The producer's underlying promise is intentionally not cancelled — JS
 * has no general way to cancel a promise. Tools that respect `ctx.signal`
 * will see the abort and unwind; tools that don't will resolve eventually
 * and the result will be discarded (slight memory pressure in pathological
 * cases, acceptable trade-off for keeping the agent loop responsive).
 */
async function raceWithAbort<T>(
  producer: () => Promise<T>,
  signal: AbortSignal,
): Promise<T | { kind: "aborted"; reason: string }> {
  if (signal.aborted) {
    return { kind: "aborted", reason: String(signal.reason) };
  }
  return new Promise<T | { kind: "aborted"; reason: string }>((resolve) => {
    const onAbort = () =>
      resolve({ kind: "aborted", reason: String(signal.reason) });
    signal.addEventListener("abort", onAbort, { once: true });
    producer().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        // Producer rejected — treat as a thrown error from the tool. This
        // differs from "aborted" because the tool itself decided to fail,
        // not the timeout/cancel. Let the caller decide what to do.
        signal.removeEventListener("abort", onAbort);
        // Re-throw by resolving with a marker so the type system stays sane.
        // The caller (call()) only ever races with executeOnceCapture, which
        // already catches throws internally and converts them to a
        // `{kind:"thrown"}` outcome. If we ever race with a producer that
        // can reject, the caller's await would re-throw — handled by the
        // try/catch in call(). We keep this path strict on purpose.
        throw err;
      },
    );
  });
}

/** Resolves after `ms` milliseconds. Extracted so tests can stub it if needed. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies a failure as retry-eligible under the tool's retry policy.
 *
 *   - `"any"`     → always retry
 *   - `"thrown"`  → retry only when the policy lists `process`
 *   - `ok: false` → retry when the error is a recognized http-style error AND
 *                   the policy lists `http`
 *
 * Unknown error codes (e.g. `bad_args`, `not_found`, `permission_denied`) are
 * NEVER retried — they are deterministic, retrying would just burn budget.
 */
function isRetryable(
  policy: ToolRetryPolicy,
  failure: ToolResult | "thrown",
): boolean {
  const cats: readonly ToolRetryCategory[] = policy.on;
  if (cats.includes("any")) return true;
  if (failure === "thrown") return cats.includes("process");
  // Structured failure — only retry http-flavored errors.
  if (!failure.ok) {
    if (
      failure.error === "http_error" ||
      failure.error === "network_error"
    ) {
      return cats.includes("http");
    }
  }
  return false;
}
