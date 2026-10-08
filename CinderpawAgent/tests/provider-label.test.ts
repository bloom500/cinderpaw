import { describe, expect, test } from "bun:test";
import { providerOf } from "../src/telemetry/provider-label.ts";

describe("providerOf", () => {
  test("loopback is local", () => {
    expect(providerOf("http://127.0.0.1:8080/v1")).toBe("local");
    expect(providerOf("http://localhost:11434")).toBe("local");
  });
  test("cloud host without api./www.", () => {
    expect(providerOf("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(providerOf("https://api.anthropic.com")).toBe("anthropic.com");
  });
  test("garbage is unknown", () => {
    expect(providerOf("not a url")).toBe("unknown");
  });
});
