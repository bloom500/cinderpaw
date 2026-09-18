/**
 * Signal — the one that needs something installed, and says so.
 *
 * Signal has no bot API. Every integration, theirs included, drives a
 * `signal-cli` linked device; the usual packaging is `signal-cli-rest-api`
 * listening on localhost, which is what this talks to: `/v1/about` to see it
 * is there, `/v1/receive/{number}` to poll, `/v2/send` to reply. No new
 * dependency, and the GPL-licensed binary stays outside our tree.
 *
 * The interesting part of this connector is not the wire. It is the first
 * one in the set that CANNOT work on a machine that was never set up, and
 * the whole failure has to land on the user's screen rather than in a log:
 * a bridge that is not running looks exactly like a connector that is
 * broken. `start()` refuses with a sentence that names the thing to install
 * and the address it was looked for at, and `health()` keeps saying it.
 *
 * That is the `binaries` capability from transports/plugin-contract.ts,
 * exercised for real for the first time. The contract declares the need; the
 * check and the message are here until the host grows a shared one.
 *
 * ponytail: polling, not the SSE event stream some builds of the bridge
 * offer. One code path that works against every build beats two where one is
 * only reachable on some installs. Ceiling: a busy number pays up to
 * POLL_INTERVAL_MS of latency; swap in SSE if that ever matters.
 */

import {
  connectorErrorMessage,
  mimeForName,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import {
  registerTransport,
  type ConnectorContext,
  type LiveConnector,
  type OutboundFile,
} from "./registry.ts";

/** Signal has no hard limit near chat length; this keeps replies readable. */
const SIGNAL_MAX = 4000;
const POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * What to tell someone whose bridge is not answering.
 *
 * Exported and tested because this string IS the feature for a first-run
 * user: without it they get a connector that is enabled, silent, and
 * indistinguishable from a bug in Cinderpaw.
 */
export function signalBridgeMissingMessage(url: string): string {
  return (
    `signal: nothing is answering at ${url}. Signal has no bot API, so Cinderpaw talks to ` +
    "signal-cli running on this machine. Install signal-cli-rest-api and link it to your " +
    "number (https://github.com/bbernhard/signal-cli-rest-api), then enable this connector " +
    "again. If it is running on another port, set SIGNAL_BRIDGE_URL to match."
  );
}

export function signalSessionId(number: string): string {
  // The phone number IS the person on Signal: no channels, no separate ids.
  return `signal:${number}`;
}

export function parseSignalSession(sessionId: string): { number: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 2 || parts[0] !== "signal" || !parts[1]) return null;
  return { number: parts[1] };
}

/** Only digits and a leading +, so a nick or a typo cannot become a target. */
export function normalizeSignalNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    timestamp?: number;
    dataMessage?: { message?: string | null };
  };
}

export class SignalConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #base = "";
  #number = "";
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const number = normalizeSignalNumber(
      ctx.row.metadata?.SIGNAL_NUMBER ?? ctx.secrets.SIGNAL_NUMBER ?? "",
    );
    const base = (
      ctx.row.metadata?.SIGNAL_BRIDGE_URL ??
      ctx.secrets.SIGNAL_BRIDGE_URL ??
      "http://127.0.0.1:8080"
    )
      .trim()
      .replace(/\/+$/, "");
    if (!number) {
      throw new Error(
        "signal: no phone number (expected SIGNAL_NUMBER, with the country code, e.g. +40712345678 — the number signal-cli is linked to)",
      );
    }
    this.#number = number;
    this.#base = base;

    // Prove the bridge is there BEFORE reporting live. This is the whole
    // point of the connector's first run: the reason has to be on screen.
    let about: Response;
    try {
      about = await fetch(`${base}/v1/about`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new Error(signalBridgeMissingMessage(base));
    }
    if (!about.ok) throw new Error(signalBridgeMissingMessage(base));

    this.#allow = new Set(
      (ctx.row.allowlist ?? []).map(normalizeSignalNumber).filter(Boolean),
    );
    ctx.log(
      `signal: bridge at ${base} answering for ${number} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add phone numbers to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("signal", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    void this.#poll();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("signal");
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseSignalSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, SIGNAL_MAX)) {
      await fetch(`${this.#base}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: part,
          number: this.#number,
          recipients: [target.number],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
  }

  /**
   * A file to the number behind `sessionId`.
   *
   * The bridge takes attachments inline, base64, on the same `/v2/send` call
   * as the text — but only in its extended form
   * (`data:<mime>;filename=<name>;base64,…`). Plain base64 arrives as
   * `attachment.bin`, which is a photo the person cannot tell from a
   * spreadsheet, so the name and type are always spelled out.
   */
  async sendFile(sessionId: string, file: OutboundFile): Promise<void> {
    const target = parseSignalSession(sessionId);
    if (!target) throw new Error("Signal: that conversation has no number I can send to.");
    const b64 = Buffer.from(file.data).toString("base64");
    const res = await fetch(`${this.#base}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: file.caption.slice(0, SIGNAL_MAX),
        number: this.#number,
        recipients: [target.number],
        base64_attachments: [
          `data:${mimeForName(file.name)};filename=${file.name};base64,${b64}`,
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The bridge puts signal-cli's own complaint in `error`, and that is the
      // part worth repeating ("Failed to send message", "Unregistered user").
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(`Signal refused the file: ${why ?? `HTTP ${res.status}`}`);
    }
  }

  async #poll(): Promise<void> {
    while (this.#running) {
      try {
        const res = await fetch(
          `${this.#base}/v1/receive/${encodeURIComponent(this.#number)}`,
          { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const batch = (await res.json()) as SignalEnvelope[];
        this.#live = true;
        this.#error = undefined;
        for (const item of Array.isArray(batch) ? batch : []) await this.#onEnvelope(item);
      } catch (e) {
        if (!this.#running) return;
        this.#live = false;
        // The bridge going away mid-run is the same problem as it never
        // being there, so it gets the same sentence rather than a raw error.
        this.#error = signalBridgeMissingMessage(this.#base);
        this.#ctx?.log(`signal: poll failed (${String(e)})`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async #onEnvelope(item: SignalEnvelope): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    const env = item.envelope;
    const text = env?.dataMessage?.message?.trim();
    const from = normalizeSignalNumber(env?.sourceNumber ?? env?.source ?? "");
    // Receipts, typing indicators and sync messages all arrive here with no
    // dataMessage. They are not errors, they are most of the traffic.
    if (!text || !from) return;
    if (from === this.#number) return;

    if (!this.#allow.has(from)) {
      ctx.log(`signal: ignored message from non-allowlisted ${from}`);
      return;
    }
    const sessionId = signalSessionId(from);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Signal"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        text,
        `signal-${env?.timestamp ?? Date.now()}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`signal: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("signal", () => new SignalConnector());
