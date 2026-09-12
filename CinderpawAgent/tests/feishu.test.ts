/**
 * The two pieces of `feishu.ts` that can be checked without a Feishu tenant.
 *
 * Nobody here has one, so the connector's own header says which parts are
 * measured and which are read defensively. These are the measured parts: the
 * text extraction, which decides whether the agent sees the actual question,
 * and the cloud probe, which decides whether a wrong-cloud app fails with a
 * sentence or sits silent forever.
 */

import { describe, expect, test } from "bun:test";
import {
  feishuCloudAccepts,
  feishuMessageText,
  feishuSessionId,
  parseFeishuSession,
} from "../src/transports/feishu.ts";

describe("feishuMessageText", () => {
  test("reads the text out of the JSON string content", () => {
    expect(feishuMessageText("text", JSON.stringify({ text: "what time is it" }))).toBe(
      "what time is it",
    );
  });

  test("strips the @-mention placeholder a group message arrives with", () => {
    // Without this the agent is asked about a username, not about the weather.
    const text = feishuMessageText("text", JSON.stringify({ text: "@_user_1 weather?" }), [
      { key: "@_user_1" },
    ]);
    expect(text).toBe("weather?");
  });

  test("a non-text message yields nothing rather than throwing", () => {
    expect(feishuMessageText("image", JSON.stringify({ image_key: "img_1" }))).toBe("");
  });

  test("content that is not JSON yields nothing rather than throwing", () => {
    expect(feishuMessageText("text", "not json at all")).toBe("");
  });

  test("content that is JSON but has no text field yields nothing", () => {
    expect(feishuMessageText("text", JSON.stringify({ nope: 1 }))).toBe("");
  });
});

describe("session ids round-trip", () => {
  test("a built id parses back to the same pair", () => {
    expect(parseFeishuSession(feishuSessionId("oc_1", "ou_9"))).toEqual({
      chatId: "oc_1",
      openId: "ou_9",
    });
  });

  test("another connector's session id is not claimed", () => {
    expect(parseFeishuSession("zalo:1:2")).toBeNull();
  });
});

describe("feishuCloudAccepts reads the envelope, not the status", () => {
  const OK = { code: 0, tenant_access_token: "t-1", expire: 7200 };
  const REJECTED = { code: 10003, msg: "invalid param" };

  async function withFetch<T>(
    reply: () => Response | Promise<Response>,
    body: () => Promise<T>,
  ): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => await reply()) as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("code 0 is acceptance", async () => {
    const answer = await withFetch(
      () => new Response(JSON.stringify(OK), { status: 200 }),
      () => feishuCloudAccepts("https://open.feishu.cn", "cli_x", "s"),
    );
    expect(answer.ok).toBe(true);
  });

  test("HTTP 200 with a non-zero code is a rejection, carrying Feishu's own words", async () => {
    // Measured on 2026-09-12: both clouds answer a bad app id this way, so a
    // status-only check would report this connector healthy forever.
    const answer = await withFetch(
      () => new Response(JSON.stringify(REJECTED), { status: 200 }),
      () => feishuCloudAccepts("https://open.feishu.cn", "cli_x", "s"),
    );
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.why).toBe("invalid param");
  });

  test("a reply that is not JSON is a rejection, not a crash", async () => {
    const answer = await withFetch(
      () => new Response("<html>gateway</html>", { status: 502 }),
      () => feishuCloudAccepts("https://open.feishu.cn", "cli_x", "s"),
    );
    expect(answer.ok).toBe(false);
  });

  test("an unreachable host is a rejection, not a crash", async () => {
    const answer = await withFetch(
      () => Promise.reject(new Error("ENOTFOUND")),
      () => feishuCloudAccepts("https://open.feishu.cn", "cli_x", "s"),
    );
    expect(answer.ok).toBe(false);
  });
});
