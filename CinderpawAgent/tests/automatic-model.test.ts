/**
 * Automatic (the model menu's "Let Cinderpaw choose", 4 Nov 2026).
 *
 * Before it, the derived brain held only the picked model and its fallback, so
 * "Automatic" was a word on a button with nothing to choose from. Now the host
 * sends every other model the person has; the router must trust them and the
 * brain must be able to route to them, and an operator allowlist still wins.
 */

import { describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { rebuildDerivedBrain } from "../src/brain/brain-config.ts";
import { classify } from "../src/brain/task-classifier.ts";
import { profileFor } from "../src/brain/model-profiles.ts";
import type { InferenceConfig, ModelTarget } from "../src/types.ts";

const HAIKU: ModelTarget = { provider: "anthropic", model: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com", apiKey: "a" };
const SOL: ModelTarget = { provider: "chatgpt", model: "gpt-6.1-sol", baseUrl: "http://127.0.0.1:11435/chatgpt", apiKey: "t" };
const FREE: ModelTarget = { provider: "openrouter", model: "muse-spark-1.3:free", baseUrl: "https://openrouter.ai/api", apiKey: "o" };

function router(trustedBaseUrls: string[] | null) {
  const db = openDatabase(":memory:");
  const config: InferenceConfig = {
    primary: HAIKU,
    ...(trustedBaseUrls ? { trustedBaseUrls } : {}),
    tokenBudget: { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" },
  };
  return new InferenceRouter(config, new AuditLog(db.raw).logger, db.raw);
}

describe("Automatic", () => {
  test("the router trusts every model the person has, and says which may be used", () => {
    const r = router(null);
    expect(r.reconfigure(HAIKU, undefined, undefined, [SOL, FREE])).toEqual([SOL, FREE]);
  });

  test("an operator allowlist still wins: a model outside it is dropped, not trusted", () => {
    const r = router([HAIKU.baseUrl, SOL.baseUrl]);
    expect(r.reconfigure(HAIKU, undefined, undefined, [SOL, FREE])).toEqual([SOL]);
  });

  test("one model picked by hand: nothing extra, as before", () => {
    expect(router(null).reconfigure(HAIKU)).toEqual([]);
  });

  test("the brain chooses among all of them", () => {
    const cfg = rebuildDerivedBrain(true, HAIKU, undefined, [SOL, FREE])!;
    expect(cfg.registry.map((m) => m.target.model)).toEqual([HAIKU.model, SOL.model, FREE.model]);
    // A hand-written brain.json is the person's own choice and is never rebuilt.
    expect(rebuildDerivedBrain(false, HAIKU, undefined, [SOL])).toBeNull();
  });

  // Without these, every Romanian message was "simple" and every Claude scored
  // alike, so Automatic always answered from the same model (4 Nov).
  test("a Romanian message is read for the job it asks", () => {
    const of = (text: string) => classify({ text, hasImages: false, offline: false }).category;
    expect(of("Scrie-mi un script Python care sorteaza un CSV")).toBe("coding");
    expect(of("Rezolva 3x+5=20 pas cu pas")).toBe("reasoning");
    expect(of("Compara 3 laptopuri sub 4000 lei")).toBe("reasoning");
    expect(of("Scrie-mi o poveste despre o vulpe")).toBe("creative");
    expect(of("salut")).toBe("simple");
    // His Voxel Bench test went to Gemini Flash as "simple" (4 Nov evening).
    expect(of("Imi poti genera un castel in Voxel bench?")).toBe("coding");
    expect(of("Fa-mi o scena 3D cu three.js")).toBe("coding");
  });

  test("a fast model and a top model of one family are told apart", () => {
    const haiku = profileFor(HAIKU);
    const opus = profileFor({ ...HAIKU, model: "claude-opus-5-5" });
    expect(haiku.capabilities.speed).toBeGreaterThan(opus.capabilities.speed);
    expect(opus.capabilities.reasoning).toBeGreaterThan(haiku.capabilities.reasoning);
    expect(haiku.cost).toBeLessThan(opus.cost);
    // The ChatGPT plan is on loopback, but it answers from the cloud.
    expect(profileFor(SOL).local).toBe(false);
  });
});
