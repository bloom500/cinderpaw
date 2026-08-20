/**
 * Regression: switching models left the Brain Stack pointed at the old one.
 *
 * Reported 2026-08-19: a user on an OpenRouter route added a Google key,
 * switched to Gemini, sent a message, and got
 *
 *   Inference unavailable: refusing to contact untrusted inference endpoint:
 *   https://openrouter.ai/api
 *
 * — an endpoint they had just switched AWAY from, named by a security check
 * that was doing its job.
 *
 * The chain: `set_model` calls `router.reconfigure()`, which rebuilds the
 * trusted-URL set from the new targets and drops the old one. The Brain Stack
 * is built ONCE at boot from the targets the router had then, and nothing
 * updated it — so the next turn routed to the abandoned provider and the
 * trust check refused it. Every message failed until the app was restarted.
 *
 * Before Phase 1 (`d8a832c`) this could not happen: no product path ever wrote
 * brain.json, so the Brain Stack was never constructed. Deriving it by default
 * made a latent coupling real.
 *
 * The refusal is not the bug. Routing to a provider the user has switched away
 * from is the bug — it sends the conversation, and the key, somewhere they
 * stopped choosing. The fix keeps the derived brain following the router.
 */

import { describe, expect, test } from "bun:test";

import { BrainStack } from "../src/brain/brain-stack.ts";
import { deriveDefaultConfig, rebuildDerivedBrain } from "../src/brain/brain-config.ts";
import { CircuitBreaker } from "../src/egress/circuit-breaker.ts";
import type { ModelTarget } from "../src/types.ts";

const OPENROUTER: ModelTarget = {
  provider: "openai_compatible",
  model: "~deepseek/deepseek-v4-flash-latest",
  baseUrl: "https://openrouter.ai/api",
  // A cloud target without a key is "unconfigured" and invisible to the
  // scorer; set_model always carries one, so the fixtures do too.
  apiKey: "or-key",
};

const GOOGLE: ModelTarget = {
  provider: "openai_compatible",
  model: "gemini-3.7-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "goog-key",
};

const ask = { text: "what did we decide yesterday?", hasImages: false, offline: false };

describe("a derived brain follows a model switch", () => {
  test("stops routing to the provider the user switched away from", () => {
    const atBoot = deriveDefaultConfig([OPENROUTER, undefined])!;
    const brainAtBoot = new BrainStack(atBoot, new CircuitBreaker());
    expect(brainAtBoot.route(ask).primary.baseUrl).toBe("https://openrouter.ai/api");

    // The user switches to Gemini. This is what dispatch must do alongside
    // router.reconfigure().
    const afterSwitch = rebuildDerivedBrain(true, GOOGLE, undefined)!;
    const brain = new BrainStack(afterSwitch, new CircuitBreaker());

    const chosen = brain.route(ask);
    expect(chosen.primary.baseUrl).toBe(GOOGLE.baseUrl);
    // The old endpoint must not survive anywhere in the registry: the router's
    // trusted set no longer contains it, so a route to it is a dead turn.
    const everyTarget = afterSwitch.registry.map((m) => m.target.baseUrl);
    expect(everyTarget).not.toContain("https://openrouter.ai/api");
  });

  test("leaves a hand-written brain.json alone", () => {
    // A user who wrote their own registry chose those models deliberately. A
    // model switch is not permission to overwrite that.
    expect(rebuildDerivedBrain(false, GOOGLE, undefined)).toBeNull();
  });

  test("keeps the fallback when the switch carries one", () => {
    const cfg = rebuildDerivedBrain(true, GOOGLE, OPENROUTER)!;
    const urls = cfg.registry.map((m) => m.target.baseUrl);
    expect(urls).toContain(GOOGLE.baseUrl);
    // Here OpenRouter is legitimate: it is the fallback the host just sent, so
    // the router trusts it too. Following the router is the whole rule.
    expect(urls).toContain("https://openrouter.ai/api");
  });
});
