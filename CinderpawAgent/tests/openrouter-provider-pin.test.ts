/**
 * The benchmark reproducibility guard.
 *
 * OpenRouter picks an endpoint per request. On 2026-09-02 the same 21 telecom
 * tasks — same seed, same model, unchanged agent code — scored 11/21 and then
 * 20/21, with nine tasks flipping the same way and their conversations
 * collapsing from 201 messages to 34-72. A score that moves 40 points between
 * identical runs is not a measurement.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { openRouterProviderPin } from "../src/egress/inference-providers.ts";
import type { ModelTarget } from "../src/types.ts";

const OR = { model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api/v1" } as ModelTarget;
const LOCAL = { model: "qwen", baseUrl: "http://127.0.0.1:11434/v1" } as ModelTarget;

const orig = process.env.CINDERPAW_OPENROUTER_PROVIDER;
afterEach(() => {
  if (orig === undefined) delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
  else process.env.CINDERPAW_OPENROUTER_PROVIDER = orig;
});

describe("openRouterProviderPin", () => {
  test("off unless asked — a fresh install keeps its fallbacks", () => {
    delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
    expect(openRouterProviderPin(OR)).toEqual({});
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "   ";
    expect(openRouterProviderPin(OR)).toEqual({});
  });

  test("pins one provider and refuses to fall back", () => {
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "Z.AI";
    // allow_fallbacks:false is the whole point — a pin that silently routes
    // elsewhere measures nothing, which is the bug this exists to prevent.
    expect(openRouterProviderPin(OR)).toEqual({
      provider: { order: ["Z.AI"], allow_fallbacks: false },
    });
  });

  test("never leaks onto a non-OpenRouter target", () => {
    // `provider` is an OpenRouter extension. Sending it to a local llama.cpp or
    // to OpenAI is at best ignored and at worst a 400 on a strict server.
    process.env.CINDERPAW_OPENROUTER_PROVIDER = "Z.AI";
    expect(openRouterProviderPin(LOCAL)).toEqual({});
  });
});

describe("openRouterProviderPin — a list, not a single point of failure", () => {
  const OR = { provider: "openai_compatible" as const, model: "m", baseUrl: "https://openrouter.ai/api/v1" };
  const withPin = (v: string | undefined, run: () => void) => {
    const prev = process.env.CINDERPAW_OPENROUTER_PROVIDER;
    if (v === undefined) delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
    else process.env.CINDERPAW_OPENROUTER_PROVIDER = v;
    try { run(); } finally {
      if (prev === undefined) delete process.env.CINDERPAW_OPENROUTER_PROVIDER;
      else process.env.CINDERPAW_OPENROUTER_PROVIDER = prev;
    }
  };

  test("keeps preference order, so the endpoint you report is tried first", () => {
    withPin("deepseek,together,baidu/fp8", () => {
      const pin = openRouterProviderPin(OR) as { provider: { order: string[] } };
      expect(pin.provider.order).toEqual(["deepseek", "together", "baidu/fp8"]);
    });
  });

  test("still refuses to leave the declared set", () => {
    // The whole reason a benchmark pins at all: routing may move WITHIN the
    // list and never outside it, so the run can still say what served it.
    withPin("deepseek,together", () => {
      const pin = openRouterProviderPin(OR) as { provider: { allow_fallbacks: boolean } };
      expect(pin.provider.allow_fallbacks).toBe(false);
    });
  });

  test("tolerates spacing and a trailing separator", () => {
    withPin(" deepseek , together , ", () => {
      const pin = openRouterProviderPin(OR) as { provider: { order: string[] } };
      expect(pin.provider.order).toEqual(["deepseek", "together"]);
    });
  });

  test("a list of nothing pins nothing, rather than pinning an empty order", () => {
    // An empty `order` with allow_fallbacks:false is a request no endpoint can
    // satisfy — every call would fail, which is worse than not pinning.
    withPin(" , ; ", () => {
      expect(openRouterProviderPin(OR)).toEqual({});
    });
  });
});
