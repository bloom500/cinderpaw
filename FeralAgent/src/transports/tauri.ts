/**
 * Tauri sidecar transport.
 *
 * Used when Feral Agent runs as a Bun sidecar inside the Feral desktop app.
 * Communication is newline-delimited JSON:
 *   - inbound:  one JSON object per line on stdin
 *   - outbound: one JSON object per line on stdout
 * stdout is reserved exclusively for protocol traffic; all diagnostics go to
 * stderr so the host never has to parse mixed output.
 */

import type {
  InboundMessage,
  OutboundEvent,
  Transport,
} from "../types.ts";

export class TauriTransport implements Transport {
  #onMessage: ((msg: InboundMessage) => void | Promise<void>) | null = null;
  #onReady: (() => void) | null = null;
  #buffer = "";
  #started = false;
  /** In-flight handler promises, drained before exit on stdin close. */
  readonly #pending = new Set<Promise<void>>();
  /** Serializes outbound writes so concurrent senders never interleave. */
  #writeChain: Promise<void> = Promise.resolve();

  send(event: OutboundEvent): void {
    // One compact JSON object per line. Writes are SERIALIZED through a chain:
    // concurrent senders (e.g. a large `embed_text` request batching 128 texts
    // and the RSI passive engine's requests) previously raced on
    // process.stdout.write. Under Bun a large write can be split and
    // interleaved with another, mangling the newline-delimited framing — Rust
    // then parsed a request with a missing `id`, replied with an empty id
    // ("rsi_response without requestId — ignored"), and the bridge Promise hung
    // forever, deadlocking the RAPTOR tree build mid-embed. Chaining each write
    // after the previous one drains keeps every JSON object an intact line.
    const line = JSON.stringify(event) + "\n";
    this.#writeChain = this.#writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (process.stdout.write(line)) resolve();
            else process.stdout.once("drain", () => resolve());
          }),
      )
      // A failed write must never wedge the queue for every later line.
      .catch(() => {});
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.#onMessage = handler;
  }

  onReady(handler: () => void): void {
    this.#onReady = handler;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#drain();
    });

    process.stdin.on("end", () => {
      // Flush any trailing line without a terminator, then exit once all
      // in-flight handlers have settled so no response is dropped.
      const last = this.#buffer.trim();
      if (last) this.#dispatch(last);
      void Promise.allSettled([...this.#pending]).then(() => process.exit(0));
    });

    // Signal readiness on the next tick so callers can finish wiring handlers.
    queueMicrotask(() => this.#onReady?.());
  }

  /** Split the buffer on newlines and dispatch each complete line. */
  #drain(): void {
    let index = this.#buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line) this.#dispatch(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let msg: InboundMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isInbound(parsed)) {
        throw new Error("missing or invalid 'type' field");
      }
      msg = parsed;
    } catch (err) {
      this.send({
        type: "error",
        message: `malformed inbound message: ${String(err)}`,
      });
      return;
    }

    // Errors thrown by the handler must not break the stdin reader. Track the
    // promise so a stdin close waits for it before exiting.
    const work = Promise.resolve(this.#onMessage?.(msg))
      .catch((err: unknown) => {
        this.send({
          type: "error",
          id: msg.id,
          message: `handler error: ${String(err)}`,
        });
      })
      .then(() => {
        this.#pending.delete(work);
      });
    this.#pending.add(work);
  }
}

/**
 * Validate an inbound JSON object as an `InboundMessage`. Exported so the
 * type drift that caused the ask_user response bug (a new type added in
 * React, sidecar's `onMessage`, and the validator) can be caught with a
 * one-line test.
 */
/**
 * Allow-list of inbound message `type` strings. MUST stay in lockstep with
 * the `InboundMessage` union in `../types.ts` — drift here is what caused
 * the Fractal Benchmark button to spin forever (the new `fractal_benchmark`
 * type was added to the union and the onMessage switch, but the allow-list
 * wasn't updated, so the transport rejected the message before the handler
 * ever saw it). The exhaustive test in
 * `tests/tauri-transport-isinbound.test.ts` pins this surface.
 */
const INBOUND_TYPES = [
  "message",
  "ping",
  "shutdown",
  "set_model",
  "stop",
  "ask_user_response",
  "ask_user_cancel",
  "cron_add",
  "cron_remove",
  "cron_toggle",
  "cron_list",
  "desktop_control_response",
  "connectors_reload",
  // PROVISIONAL — temporary Settings button for the benchmark gate.
  "fractal_benchmark",
  "fractal_cluster_leaves",
  "rsi_start",
  "rsi_stop",
  "rsi_set_concurrency",
  "rsi_dream_now",
  "rsi_code_patches_list",
  "rsi_code_patch_resolve",
  "rsi_lora_train",
  "rsi_lora_reviews_list",
  "rsi_lora_review_resolve",
  "meta_status",
  "meta_evolve",
  "meta_rollback",
  "meta_history",
  // Slice A5 (L5 Governance) — host drives the policy FSM through
  // `GovernanceLifecycle`. Replies with one `governance_result` paired by
  // `id`; payload fields (`document`, `policyId`, `documentHash`, `layers`,
  // `note`, `reason`, `limit`) are flattened onto the inbound message.
  "governance_status",
  "governance_propose",
  "governance_approve",
  "governance_reject",
  "governance_rollback",
  "governance_freeze",
  "governance_unfreeze",
  "governance_verify",
  "governance_history",
  // Phase B (L4 Architecture Evolution) — modules surface. Sidecar replies
  // with one `modules_result` event paired by `id` (op list/resolve/evaluate).
  "modules_list",
  "module_resolve",
  "module_evaluate",
  // Sprint 1.6 — Memory Resume. Host asks the sidecar for the persisted
  // `current_task` + active workspace + last-active timestamp. Sidecar replies
  // with one `resume_get_result` event paired by `id`. See
  // `FeralAgent/src/memory/resume.ts` for the read-side helpers.
  "resume_get",
  // /compact (OpenClaw slash parity) — summarize the older portion of one
  // session's transcript now; replies with one `compact_result` paired by `id`.
  "compact_session",
  "rsi_response",
  // AI-Guided Onboarding (Etapa 1, ADR-0013). `start_onboarding` prepares the
  // onboarding profile + session; `tool_confirmation_response` carries the
  // user's approve/deny reply to a `confirmation_required` event.
  "start_onboarding",
  "tool_confirmation_response",
  // R5 — MCP over stdin (host manages config, sidecar owns connections).
  "mcp_reload",
  "mcp_status",
  "mcp_list_tools",
  "mcp_call_tool",
] as const satisfies readonly InboundMessage["type"][];

/**
 * Exhaustiveness check: if a new variant is added to `InboundMessage["type"]`
 * without being added to `INBOUND_TYPES`, the `as const satisfies` cast on the
 * array literal above will fail to compile. The `_assertExhaustive` value
 * below further asserts the opposite direction: every union member appears
 * in the array. Together they pin the allow-list to the union at compile
 * time, so drift is a TypeScript error, not a silent drop. The `void` keeps
 * TypeScript from complaining about an unused local.
 */
type _AssertExhaustive = Exclude<
  InboundMessage["type"],
  (typeof INBOUND_TYPES)[number]
> extends never
  ? true
  : false;
const _assertExhaustive: _AssertExhaustive = true;
void _assertExhaustive;

export function isInbound(value: unknown): value is InboundMessage {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && (INBOUND_TYPES as readonly string[]).includes(t);
}
