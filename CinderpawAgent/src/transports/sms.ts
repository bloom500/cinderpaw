/**
 * SMS through Twilio — the second connector on the inbound receiver.
 *
 * Twilio POSTs each incoming text as a form (`From`, `To`, `Body`,
 * `MessageSid`) to the URL configured on the number, and signs it with
 * `X-Twilio-Signature` = base64 HMAC-SHA1(auth token, URL + the params
 * sorted by key, concatenated key then value). The URL in that formula is the
 * PUBLIC one Twilio was told, not the loopback address the receiver sees, so
 * unlike LINE this transport has to be told the public URL by the person who
 * owns it (`TWILIO_WEBHOOK_URL`). A wrong URL fails every signature, and the
 * log says which URL it checked against so that is a one-line fix.
 *
 * Replies go by the Messages API (`POST /2010-04-01/Accounts/{sid}/Messages.json`,
 * basic auth), not by TwiML in the webhook response: the agent takes longer
 * than Twilio waits for a response, and each outbound SMS is billed.
 *
 * ponytail: text only, no MMS media, one sending number. Session = the
 * other phone number; the allowlist is phone numbers in E.164.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { inboundAddress, inboundPath, serveInbound, type InboundRequest } from "./inbound.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/** One SMS segment is 160 GSM-7 characters; Twilio concatenates up to 1600. */
const SMS_MAX = 1500;
const API = "https://api.twilio.com/2010-04-01";

export function smsSessionId(phone: string): string {
  return `sms:${phone}`;
}

export function parseSmsSession(sessionId: string): { phone: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 2 || parts[0] !== "sms" || !parts[1]) return null;
  return { phone: parts[1] };
}

/**
 * Twilio's scheme: the public URL, then every POST field in key order as
 * key+value with no separators, HMAC-SHA1 with the auth token, base64.
 */
export function verifyTwilioSignature(
  authToken: string,
  publicUrl: string,
  params: URLSearchParams,
  header: string | null,
): boolean {
  if (!header) return false;
  const keys = [...new Set(params.keys())].sort();
  let data = publicUrl;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  const expected = createHmac("sha1", authToken).update(data).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class SmsConnector implements LiveConnector {
  #sid = "";
  #token = "";
  #from = "";
  #publicUrl = "";
  #ctx: ConnectorContext | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #unserve: (() => Promise<void>) | null = null;
  /** Twilio retries a webhook that did not answer 2xx; MessageSid is the key. */
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const field = (k: string) => (ctx.row.metadata?.[k] ?? ctx.secrets[k] ?? "").trim();
    this.#sid = field("TWILIO_ACCOUNT_SID");
    this.#token = field("TWILIO_AUTH_TOKEN");
    this.#from = field("TWILIO_FROM_NUMBER");
    this.#publicUrl = field("TWILIO_WEBHOOK_URL");
    if (!this.#sid || !this.#token || !this.#from) {
      throw new Error(
        "sms: enabled but missing the account SID, the auth token or the sending number " +
          "(all three are on the Twilio console home page and the number's page)",
      );
    }
    if (!/^https?:\/\//.test(this.#publicUrl)) {
      throw new Error(
        "sms: no public webhook URL. Twilio signs each message with the URL you gave it, so " +
          `Cinderpaw needs the same one: set TWILIO_WEBHOOK_URL to e.g. https://<your host>${inboundPath("sms")}, ` +
          "and paste that same address as the number's 'A message comes in' webhook in the console.",
      );
    }

    // Validate the credentials before opening a port for them.
    const me = await this.#api("GET", `/Accounts/${this.#sid}.json`);
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "sms: Twilio rejected the account SID + auth token — copy both again from the console home page"
          : `sms: Twilio answered HTTP ${me.status} to the account lookup`,
      );
    }

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#unserve = await serveInbound("sms", (req) => this.#onRequest(req), ctx.log);
    const { host, port } = inboundAddress();
    ctx.log(
      `sms: connected as ${this.#from} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every text is ignored. " +
            "Add phone numbers in +country format to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      }). Webhook: ${this.#publicUrl} → http://${host}:${port}${inboundPath("sms")}`,
    );

    ctx.askRouter.registerSender("sms", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("sms");
    await this.#unserve?.();
    this.#unserve = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseSmsSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, SMS_MAX)) {
      const res = await this.#api(
        "POST",
        `/Accounts/${this.#sid}/Messages.json`,
        new URLSearchParams({ From: this.#from, To: target.phone, Body: part }),
      );
      if (!res.ok) throw new Error(`sms: Twilio answered HTTP ${res.status} to send: ${(await res.text()).slice(0, 200)}`);
    }
  }

  #api(method: "GET" | "POST", path: string, body?: URLSearchParams): Promise<Response> {
    return fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.#sid}:${this.#token}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body: body.toString() } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /**
   * One webhook POST. Verified against the PUBLIC URL, then acknowledged with
   * an empty TwiML document (Twilio wants XML back or it logs a warning), and
   * the agent runs afterwards.
   */
  async #onRequest(req: InboundRequest): Promise<Response> {
    const params = new URLSearchParams(Buffer.from(req.body).toString("utf8"));
    // Twilio signs the URL it called, query string included; the public URL
    // the person typed is the base, and the query it appended (if any) is
    // taken from the request so a `?foo=1` set in the console still verifies.
    const url = this.#publicUrl.split("?")[0] + req.url.search;
    if (!verifyTwilioSignature(this.#token, url, params, req.headers.get("x-twilio-signature"))) {
      this.#ctx?.log(
        `sms: rejected a POST with a bad signature — checked against ${url}; ` +
          "if that is not exactly the webhook URL in the Twilio console, fix TWILIO_WEBHOOK_URL",
      );
      return new Response("bad signature", { status: 401 });
    }
    void this.#onMessage(params);
    return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  async #onMessage(p: URLSearchParams): Promise<void> {
    const from = p.get("From")?.trim();
    const text = p.get("Body")?.trim();
    const sid = p.get("MessageSid") ?? "";
    if (!from || !text) return;
    if (sid) {
      if (this.#seen.has(sid)) return;
      this.#seen.add(sid);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }
    const ctx = this.#ctx;
    if (!ctx) return;
    if (!this.#allow.has(from)) {
      ctx.log(`sms: ignored a text from non-allowlisted ${from}`);
      return;
    }
    const sessionId = smsSessionId(from);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("SMS"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${from}] ${text}`, `sms-${sid || Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`sms: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("sms", () => new SmsConnector());
