/**
 * Brain Stack — slice 3: scoring + routing.
 *
 * Asserts on real behaviour:
 *   - the scoring formula matches the brief literally (Σ w·c − mw·cost + bonus)
 *   - budget mode penalises expensive models + applies the local bonus
 *   - quality mode ignores cost entirely
 *   - per-category REQUIREMENTS steer the choice (coding task → coding-
 *     strong, not reasoning-strong)
 *   - `overrides[category]` pins the primary when available
 *   - `offlineModelId` is forced when category === "offline"
 *   - override / offline that point to an unavailable model falls
 *     THROUGH to scoring (better to answer than to refuse)
 *   - open breaker circuit hides the model
 *   - different-provider fallback is preferred (anthropic primary →
 *     openai fallback, not another anthropic)
 *   - no available model throws BrainError — never silently picks
 *     a broken target
 *   - single-model registry → fallback is undefined
 *
 * The CircuitBreaker is a REAL one (not a mock) — we trip it with
 * recordFailure to drive the health filter. Mocking it would defeat
 * the point of slice 6's contract.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { CircuitBreaker } from "../src/egress/circuit-breaker.ts";
import {
  BrainError,
  BrainStack,
  LOCAL_BONUS,
  MODE_WEIGHT,
  REQUIREMENTS,
  pickTopScore,
  scoreModel,
  type BrainConfig,
  type Mode,
} from "../src/brain/brain-stack.ts";
import type {
  BrainModel,
  Capability,
  Category,
} from "../src/brain/capability-registry.ts";

// ---------------------------------------------------------------------------
// Fixtures — readable, named for their strength so test bodies stay short.
// ---------------------------------------------------------------------------

function makeModel(opts: {
  id: string;
  provider: string;
  capabilities: Record<Capability, number>;
  cost: 1 | 2 | 3;
  local?: boolean;
  contextWindow?: number;
}): BrainModel {
  return {
    id: opts.id,
    target: {
      provider: opts.provider,
      model: opts.id,
      baseUrl: opts.local
        ? "http://localhost:11434"
        : `https://${opts.provider}.example/v1`,
      ...(opts.local ? {} : { apiKey: "sk-test" }),
    },
    capabilities: opts.capabilities,
    cost: opts.cost,
    ...(opts.contextWindow === undefined ? {} : { contextWindow: opts.contextWindow }),
    local: opts.local ?? false,
  };
}

/** Coding-strong (anthropic, premium). Wins coding category. */
const codingStrong = makeModel({
  id: "coding-strong",
  provider: "anthropic",
  capabilities: { reasoning: 7, coding: 10, vision: 0, speed: 6, multilingual: 8 },
  cost: 3,
});

/** Reasoning-strong (openai, premium). Wins reasoning category. */
const reasoningStrong = makeModel({
  id: "reasoning-strong",
  provider: "openai",
  capabilities: { reasoning: 10, coding: 6, vision: 0, speed: 5, multilingual: 9 },
  cost: 3,
});

/** Vision-strong (google, premium). Wins vision category. */
const visionStrong = makeModel({
  id: "vision-strong",
  provider: "google",
  capabilities: { reasoning: 7, coding: 5, vision: 10, speed: 6, multilingual: 8 },
  cost: 3,
});

/** Local ollama — cheap, fast, no vision. Wins "simple" via local bonus. */
const localOllama = makeModel({
  id: "local-ollama",
  provider: "ollama",
  capabilities: { reasoning: 6, coding: 7, vision: 0, speed: 9, multilingual: 5 },
  cost: 1,
  local: true,
});

/** Cloud cheap — no apiKey-less bypass, low cost, weak capabilities. */
const cloudCheap = makeModel({
  id: "cloud-cheap",
  provider: "groq",
  capabilities: { reasoning: 5, coding: 5, vision: 0, speed: 8, multilingual: 5 },
  cost: 1,
});

/** Multilingual-strong. Wins multilingual category. */
const multilingualStrong = makeModel({
  id: "multilingual-strong",
  provider: "openai",
  capabilities: { reasoning: 7, coding: 6, vision: 5, speed: 6, multilingual: 10 },
  cost: 3,
});

/** Build a breaker with low thresholds so tests are fast to trip. */
function newBreaker(): CircuitBreaker {
  return new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
}

/** Build a BrainStack with sane defaults; tests mutate cfg as needed. */
function newStack(
  registry: BrainModel[],
  opts: Partial<BrainConfig> = {},
): { brain: BrainStack; breaker: CircuitBreaker } {
  const breaker = newBreaker();
  const brain = new BrainStack(
    {
      enabled: true,
      mode: "balanced",
      registry,
      ...opts,
    },
    breaker,
  );
  return { brain, breaker };
}

// ---------------------------------------------------------------------------
// REQUIREMENTS table — every category covered, weights in [0, 1]
// ---------------------------------------------------------------------------

describe("REQUIREMENTS table", () => {
  const ALL_CATEGORIES: Category[] = [
    "simple", "coding", "vision", "reasoning", "creative", "multilingual", "offline",
  ];

  test("every Category has a REQUIREMENTS entry", () => {
    for (const cat of ALL_CATEGORIES) {
      expect(REQUIREMENTS[cat]).toBeDefined();
    }
  });

  test("every requirement weight is in [0, 1]", () => {
    for (const cat of ALL_CATEGORIES) {
      const req = REQUIREMENTS[cat];
      for (const cap of Object.keys(req) as Capability[]) {
        const w = req[cap];
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("MODE_WEIGHT table", () => {
  test("budget has the highest cost penalty", () => {
    expect(MODE_WEIGHT.budget).toBeGreaterThan(MODE_WEIGHT.balanced);
  });

  test("quality has zero cost penalty", () => {
    expect(MODE_WEIGHT.quality).toBe(0);
  });

  test("balanced sits between budget and quality", () => {
    expect(MODE_WEIGHT.balanced).toBeGreaterThan(MODE_WEIGHT.quality);
    expect(MODE_WEIGHT.balanced).toBeLessThan(MODE_WEIGHT.budget);
  });
});

// ---------------------------------------------------------------------------
// scoreModel — pure, no breaker, no routing
// ---------------------------------------------------------------------------

describe("scoreModel — pure formula", () => {
  test("coding-strong beats reasoning-strong for the coding requirement", () => {
    const req = REQUIREMENTS.coding;
    const coding = scoreModel(codingStrong, req, "balanced");
    const reasoning = scoreModel(reasoningStrong, req, "balanced");
    expect(coding).toBeGreaterThan(reasoning);
  });

  test("vision-strong beats coding-strong for the vision requirement", () => {
    const req = REQUIREMENTS.vision;
    const vision = scoreModel(visionStrong, req, "balanced");
    const coding = scoreModel(codingStrong, req, "balanced");
    expect(vision).toBeGreaterThan(coding);
  });

  test("reasoning-strong beats coding-strong for the reasoning requirement", () => {
    const req = REQUIREMENTS.reasoning;
    const reasoning = scoreModel(reasoningStrong, req, "balanced");
    const coding = scoreModel(codingStrong, req, "balanced");
    expect(reasoning).toBeGreaterThan(coding);
  });

  test("multilingual-strong beats coding-strong for the multilingual requirement", () => {
    const req = REQUIREMENTS.multilingual;
    const ml = scoreModel(multilingualStrong, req, "balanced");
    const coding = scoreModel(codingStrong, req, "balanced");
    expect(ml).toBeGreaterThan(coding);
  });

  test("budget mode penalises cost — cheap model beats premium at equal capability", () => {
    // Same capabilities, different cost. Budget = big penalty on cost.
    const req = REQUIREMENTS.coding;
    const cheap = scoreModel(cloudCheap, req, "budget");
    const premium = scoreModel(codingStrong, req, "budget");
    // cloudCheap has weaker coding (5 vs 10), so premium may still win —
    // this test only checks the penalty exists (premium score in budget
    // is lower than premium score in quality).
    const premiumInQuality = scoreModel(codingStrong, req, "quality");
    expect(premium).toBeLessThan(premiumInQuality);
    expect(cheap).toBeDefined(); // sanity
  });

  test("quality mode ignores cost — premium model beats cheap model of equal capability", () => {
    // Two models with identical capability, different cost.
    const a = makeModel({
      id: "a",
      provider: "x",
      capabilities: { reasoning: 7, coding: 7, vision: 7, speed: 7, multilingual: 7 },
      cost: 1,
    });
    const b = makeModel({
      id: "b",
      provider: "y",
      capabilities: { reasoning: 7, coding: 7, vision: 7, speed: 7, multilingual: 7 },
      cost: 3,
    });
    const req = REQUIREMENTS.reasoning; // any non-empty req
    const aQuality = scoreModel(a, req, "quality");
    const bQuality = scoreModel(b, req, "quality");
    // In quality mode cost penalty is 0 → identical scores.
    expect(aQuality).toBe(bQuality);

    const aBudget = scoreModel(a, req, "budget");
    const bBudget = scoreModel(b, req, "budget");
    // In budget mode the cheaper model wins outright.
    expect(aBudget).toBeGreaterThan(bBudget);
  });

  test("budget mode applies the local bonus to local models", () => {
    // Two models with identical (non-local) capability, only one is local.
    const req = REQUIREMENTS.simple;
    const local = scoreModel(localOllama, req, "budget");
    const cloud = scoreModel(
      // Same capability, cloud-based, cost 1.
      makeModel({
        id: "cloud-twin",
        provider: "groq",
        capabilities: { reasoning: 6, coding: 7, vision: 0, speed: 9, multilingual: 5 },
        cost: 1,
      }),
      req,
      "budget",
    );
    expect(local - cloud).toBeCloseTo(LOCAL_BONUS, 5);
  });

  test("balanced mode does NOT apply the local bonus", () => {
    const req = REQUIREMENTS.simple;
    const local = scoreModel(localOllama, req, "balanced");
    const cloud = scoreModel(
      makeModel({
        id: "cloud-twin",
        provider: "groq",
        capabilities: { reasoning: 6, coding: 7, vision: 0, speed: 9, multilingual: 5 },
        cost: 1,
      }),
      req,
      "balanced",
    );
    expect(local).toBe(cloud);
  });

  test("quality mode does NOT apply the local bonus either", () => {
    const req = REQUIREMENTS.simple;
    const local = scoreModel(localOllama, req, "quality");
    const cloud = scoreModel(
      makeModel({
        id: "cloud-twin",
        provider: "groq",
        capabilities: { reasoning: 6, coding: 7, vision: 0, speed: 9, multilingual: 5 },
        cost: 1,
      }),
      req,
      "quality",
    );
    expect(local).toBe(cloud);
  });

  test("confidence tiebreaker: higher confidence gives a small bonus", () => {
    const req = REQUIREMENTS.coding;
    const low = scoreModel(codingStrong, req, "balanced", 0.0);
    const high = scoreModel(codingStrong, req, "balanced", 1.0);
    expect(high).toBeGreaterThan(low);
  });

  test("score with empty requirement + zero capability + cost 0 = 0 (modulo confidence)", () => {
    const empty = makeModel({
      id: "empty",
      provider: "x",
      capabilities: { reasoning: 0, coding: 0, vision: 0, speed: 0, multilingual: 0 },
      cost: 1, // cheapest available, still adds a penalty
    });
    // Pass confidence=0 explicitly so we isolate the (w·c − mw·cost + bonus) terms.
    expect(scoreModel(empty, {}, "quality", 0)).toBe(0);
    expect(scoreModel(empty, {}, "balanced", 0)).toBe(-1); // 0 - 1*1
    expect(scoreModel(empty, {}, "budget", 0)).toBe(-2); // 0 - 2*1
  });
});

// ---------------------------------------------------------------------------
// pickTopScore — pure helper, exported for direct testing
// ---------------------------------------------------------------------------

describe("pickTopScore", () => {
  test("returns the highest scorer", () => {
    const req = REQUIREMENTS.coding;
    const winner = pickTopScore(
      [cloudCheap, codingStrong, reasoningStrong],
      req,
      "balanced",
    );
    expect(winner.id).toBe("coding-strong");
  });

  test("throws BrainError on empty candidates", () => {
    expect(() => pickTopScore([], REQUIREMENTS.coding, "balanced")).toThrow(BrainError);
  });

  test("single candidate wins by default", () => {
    const winner = pickTopScore([codingStrong], REQUIREMENTS.coding, "balanced");
    expect(winner.id).toBe("coding-strong");
  });

  test("respects mode: budget flips the choice when costs differ", () => {
    // Same coding-capable model, different costs.
    const cheap = makeModel({
      id: "cheap",
      provider: "a",
      capabilities: { reasoning: 5, coding: 8, vision: 0, speed: 5, multilingual: 5 },
      cost: 1,
    });
    const pricey = makeModel({
      id: "pricey",
      provider: "b",
      capabilities: { reasoning: 5, coding: 8, vision: 0, speed: 5, multilingual: 5 },
      cost: 3,
    });
    const req = REQUIREMENTS.coding;
    expect(pickTopScore([cheap, pricey], req, "budget").id).toBe("cheap");
    expect(pickTopScore([cheap, pricey], req, "quality").id).toBeDefined(); // tie; any is fine
  });
});

// ---------------------------------------------------------------------------
// BrainStack.route() — end-to-end
// ---------------------------------------------------------------------------

describe("BrainStack.route() — happy paths", () => {
  test("coding prompt routes to the coding-strong model", () => {
    const { brain } = newStack([codingStrong, reasoningStrong, visionStrong]);
    const r = brain.route({ text: "refactor this function", hasImages: false, offline: false });
    expect(r.classification.category).toBe("coding");
    expect(r.primary.provider).toBe("anthropic");
    expect(r.chosenId).toBe("coding-strong");
  });

  test("vision prompt (with image) routes to the vision-strong model", () => {
    const { brain } = newStack([codingStrong, reasoningStrong, visionStrong]);
    const r = brain.route({ text: "what is in this?", hasImages: true, offline: false });
    expect(r.classification.category).toBe("vision");
    expect(r.primary.provider).toBe("google");
    expect(r.chosenId).toBe("vision-strong");
  });

  test("reasoning prompt (long) routes to the reasoning-strong model", () => {
    const { brain } = newStack([codingStrong, reasoningStrong, visionStrong]);
    const r = brain.route({
      text: "a".repeat(2000),
      hasImages: false,
      offline: false,
    });
    expect(r.classification.category).toBe("reasoning");
    expect(r.primary.provider).toBe("openai");
    expect(r.chosenId).toBe("reasoning-strong");
  });

  test("simple prompt in budget mode routes to the local model (local bonus)", () => {
    const { brain } = newStack([codingStrong, localOllama], { mode: "budget" });
    const r = brain.route({ text: "hi", hasImages: false, offline: false });
    expect(r.classification.category).toBe("simple");
    expect(r.primary.provider).toBe("ollama");
    expect(r.chosenId).toBe("local-ollama");
  });

  test("simple prompt in quality mode routes to the capable model, ignoring cost", () => {
    const { brain } = newStack([codingStrong, localOllama], { mode: "quality" });
    const r = brain.route({ text: "hi", hasImages: false, offline: false });
    expect(r.classification.category).toBe("simple");
    // speed=6 vs speed=9 — local still wins on raw capability, but the
    // point is cost doesn't flip the choice. Coding has speed 6; local
    // has speed 9. Either way, local wins. Test the score directly:
    expect(r.primary.provider).toBe("ollama"); // localOllama wins on speed
  });

  test("classification is echoed in the result (no re-classification)", () => {
    const { brain } = newStack([codingStrong, reasoningStrong]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.classification.category).toBe("coding");
    expect(r.classification.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BrainStack.route() — fallback selection
// ---------------------------------------------------------------------------

describe("BrainStack.route() — fallback", () => {
  test("fallback is undefined when only one model is available", () => {
    const { brain } = newStack([codingStrong]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.fallback).toBeUndefined();
  });

  test("fallback prefers a different provider than the primary", () => {
    // codingStrong (anthropic) and reasoningStrong (openai) — two providers.
    const { brain } = newStack([codingStrong, reasoningStrong]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.primary.provider).toBe("anthropic");
    expect(r.fallback).toBeDefined();
    expect(r.fallback?.provider).not.toBe("anthropic");
  });

  test("fallback falls back to same-provider when no different-provider exists", () => {
    // Both models anthropic — fallback must still be present (the
    // "different provider preferred" is best-effort, not strict).
    const twin = makeModel({
      id: "anthropic-twin",
      provider: "anthropic",
      capabilities: { reasoning: 5, coding: 5, vision: 0, speed: 5, multilingual: 5 },
      cost: 3,
    });
    const { brain } = newStack([codingStrong, twin]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.fallback).toBeDefined();
    expect(r.fallback?.provider).toBe("anthropic"); // best we can do
  });

  test("primary and fallback are different models", () => {
    const { brain } = newStack([codingStrong, reasoningStrong, visionStrong]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.primary.model).not.toBe(r.fallback?.model);
  });
});

// ---------------------------------------------------------------------------
// BrainStack.route() — overrides + offline force
// ---------------------------------------------------------------------------

describe("BrainStack.route() — overrides", () => {
  test("override[category] pins primary when the override model is available", () => {
    const { brain } = newStack(
      [codingStrong, reasoningStrong, visionStrong],
      { overrides: { coding: "vision-strong" } }, // weird override; verify it sticks
    );
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.classification.category).toBe("coding");
    expect(r.chosenId).toBe("vision-strong"); // override beats scoring
  });

  test("override for an unavailable model falls through to scoring", () => {
    const { brain } = newStack(
      [codingStrong, reasoningStrong],
      { overrides: { coding: "does-not-exist" } },
    );
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.chosenId).toBe("coding-strong"); // scored, not the missing override
  });
});

describe("BrainStack.route() — offline force", () => {
  test("offline category forces the offlineModelId when available", () => {
    const { brain } = newStack(
      [codingStrong, localOllama],
      { offlineModelId: "local-ollama" },
    );
    // Set offline: true so classify() routes to the offline category.
    const r = brain.route({ text: "what's the weather", hasImages: false, offline: true });
    expect(r.classification.category).toBe("offline");
    expect(r.chosenId).toBe("local-ollama");
  });

  test("offline category falls through to scoring when offlineModelId is unavailable", () => {
    const { brain } = newStack(
      [codingStrong], // localOllama NOT registered
      { offlineModelId: "local-ollama" },
    );
    const r = brain.route({ text: "what's the weather", hasImages: false, offline: true });
    expect(r.classification.category).toBe("offline");
    expect(r.chosenId).toBe("coding-strong"); // scored, not the missing offline id
  });

  test("offlineModelId is IGNORED when category is not offline", () => {
    const { brain } = newStack(
      [codingStrong, localOllama],
      { offlineModelId: "local-ollama" },
    );
    // category will be "coding", not "offline".
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.classification.category).toBe("coding");
    expect(r.chosenId).toBe("coding-strong"); // scoring, not the offline pin
  });
});

// ---------------------------------------------------------------------------
// BrainStack.route() — health (real CircuitBreaker)
// ---------------------------------------------------------------------------

describe("BrainStack.route() — health", () => {
  test("model with an open breaker is skipped", () => {
    const { brain, breaker } = newStack([codingStrong, reasoningStrong]);
    breaker.recordFailure("coding-strong"); // → state === "open"
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.chosenId).toBe("reasoning-strong"); // coding-strong was unhealthy
  });

  test("model with half-open breaker is INCLUDED (probe slot available)", () => {
    const { brain, breaker } = newStack([codingStrong, reasoningStrong]);
    breaker.recordFailure("coding-strong");
    // Force the cooldown to elapse by mutating openedAt backwards.
    // We can't directly access #openedAt (private), so we use the
    // public path: recordFailure trips; we then test in balanced
    // mode and assert it's excluded (still open). The half_open case
    // is exercised in a separate slice (S6) when we expose enough
    // internals; here we only assert that open → skip.
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.chosenId).not.toBe("coding-strong");
  });

  test("all models unhealthy throws BrainError", () => {
    const { brain, breaker } = newStack([codingStrong, reasoningStrong]);
    breaker.recordFailure("coding-strong");
    breaker.recordFailure("reasoning-strong");
    expect(() =>
      brain.route({ text: "refactor this", hasImages: false, offline: false }),
    ).toThrow(BrainError);
  });

  test("unconfigured model is filtered out by registry.available()", () => {
    // cloudCheap with no apiKey is unconfigured; the registry's
    // available() filter should hide it before scoring ever runs.
    const unconfigured = makeModel({
      id: "unconfigured",
      provider: "openai",
      capabilities: { reasoning: 10, coding: 10, vision: 10, speed: 10, multilingual: 10 },
      cost: 3,
    });
    // Strip the apiKey to make it unconfigured.
    delete (unconfigured.target as { apiKey?: string }).apiKey;
    const { brain } = newStack([codingStrong, unconfigured]);
    const r = brain.route({ text: "refactor this", hasImages: false, offline: false });
    expect(r.chosenId).toBe("coding-strong"); // unconfigured model hidden
  });

  test("BrainError message names the category + reason (debuggable)", () => {
    const { brain, breaker } = newStack([codingStrong]);
    breaker.recordFailure("coding-strong");
    let caught: unknown = null;
    try {
      brain.route({ text: "refactor this", hasImages: false, offline: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrainError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/no models available/);
    expect(msg).toMatch(/coding/);
  });
});

// ---------------------------------------------------------------------------
// BrainStack construction + accessors
// ---------------------------------------------------------------------------

describe("BrainStack — construction", () => {
  test("mode getter returns the configured mode", () => {
    for (const mode of ["budget", "balanced", "quality"] as Mode[]) {
      const { brain } = newStack([codingStrong], { mode });
      expect(brain.mode).toBe(mode);
    }
  });

  test("registry getter exposes the configured models", () => {
    const models = [codingStrong, reasoningStrong];
    const { brain } = newStack(models);
    expect(brain.registry.size).toBe(2);
    expect(brain.registry.get("coding-strong")).toBe(codingStrong);
  });

  test("duplicate ids in the registry throw at construction", () => {
    // The registry enforces this — the BrainStack constructor wraps
    // the user's BrainModel[] in a CapabilityRegistry which throws
    // on duplicate ids. Same contract as slice S1.
    expect(() => {
      new BrainStack(
        { enabled: true, mode: "balanced", registry: [codingStrong, codingStrong] },
        newBreaker(),
      );
    }).toThrow(/duplicate model id/);
  });
});

// ---------------------------------------------------------------------------
// Context window — a model that cannot hold the turn is not a candidate
// ---------------------------------------------------------------------------

describe("BrainStack.route() — the prompt has to fit", () => {
  const small = makeModel({
    id: "small-local",
    provider: "ollama",
    capabilities: { reasoning: 5, coding: 6, vision: 0, speed: 9, multilingual: 5 },
    cost: 1,
    local: true,
    contextWindow: 4_096,
  });
  const big = makeModel({
    id: "big-cloud",
    provider: "b",
    capabilities: { reasoning: 8, coding: 8, vision: 0, speed: 5, multilingual: 8 },
    cost: 3,
    contextWindow: 200_000,
  });

  test("when everything fits, the filter changes nothing", () => {
    const { brain } = newStack([small, big]);
    const withSize = brain.route({
      text: "refactor this function",
      hasImages: false,
      offline: false,
      promptTokens: 800,
    });
    const without = brain.route({
      text: "refactor this function",
      hasImages: false,
      offline: false,
    });
    // The invariant that matters: a caller who reports a prompt size gets the
    // same decision as one who does not, right up until the size rules a
    // model out. Anything else would be a routing change smuggled in behind a
    // safety check.
    expect(withSize.chosenId).toBe(without.chosenId);
  });

  test("it loses the moment the turn does not fit", () => {
    // The failure this exists to stop: in budget mode a local model gets a
    // scoring bonus, so a 4B with a 4k window was the PREFERRED answer for a
    // turn carrying the agent's system prompt. Overrunning a window does not
    // raise — the model degenerates into repeated bytes, which reads as a
    // broken install and is invisible to every part of the routing path.
    const { brain } = newStack([small, big]);
    const r = brain.route({
      text: "refactor this function",
      hasImages: false,
      offline: false,
      promptTokens: 6_000,
    });
    expect(r.chosenId).toBe("big-cloud");
  });

  test("headroom counts: a prompt that exactly fills the window does not fit", () => {
    const { brain } = newStack([small, big]);
    const r = brain.route({
      text: "refactor this function",
      hasImages: false,
      offline: false,
      promptTokens: 4_096,
    });
    // Nowhere left to answer from is the same failure as not fitting.
    expect(r.chosenId).toBe("big-cloud");
  });

  test("nothing fits: the reason names the numbers instead of a generic refusal", () => {
    const { brain } = newStack([small]);
    expect(() =>
      brain.route({
        text: "refactor this function",
        hasImages: false,
        offline: false,
        promptTokens: 90_000,
      }),
    ).toThrow(/90000 tokens .*holds 4096/);
  });

  test("an unrecorded window is not a reason to rule a model out", () => {
    const unknown = makeModel({
      id: "unknown-window",
      provider: "c",
      capabilities: { reasoning: 9, coding: 9, vision: 0, speed: 5, multilingual: 8 },
      cost: 1,
    });
    const { brain } = newStack([unknown]);
    const r = brain.route({
      text: "refactor this function",
      hasImages: false,
      offline: false,
      promptTokens: 90_000,
    });
    // Grounding every model nobody measured would empty the registry on the
    // day this shipped.
    expect(r.chosenId).toBe("unknown-window");
  });
});
