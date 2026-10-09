import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_PROVIDERS, providerOf, publicProvider } from "../src/telemetry/provider-label.ts";

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

describe("publicProvider", () => {
  // The app's own BYOK catalog (Rust, pinned by catalog_snapshots.rs and the
  // TUI). Every host it can send to gets its catalog id, and no host outside
  // it is known: anything else a person typed in leaves as `custom`.
  const catalog = JSON.parse(
    readFileSync(join(import.meta.dir, "../../crates/cinderpaw-core/tests/testdata/provider_catalog.golden.json"), "utf8"),
  ) as Array<{ id: string; default_base_url: string }>;

  test("every catalog host maps to its catalog id, and nothing else is known", () => {
    for (const p of catalog) expect(publicProvider(providerOf(p.default_base_url))).toBe(p.id);
    expect(Object.keys(CLOUD_PROVIDERS).length).toBe(catalog.length);
  });

  test("loopback, private and LAN addresses are local", () => {
    for (const url of [
      "http://127.0.0.1:8080", "http://localhost:11434", "http://[::1]:1234", "http://127.0.0.2:1",
      "http://10.0.0.5:11434", "http://172.16.0.1", "http://172.31.255.1", "http://192.168.1.20:11434",
      "http://169.254.10.1", "http://[fd12:3456::1]:8080", "http://[fe80::1]", "http://0.0.0.0:8000",
      "http://gpu.local:8080", "http://box.lan", "http://ai.home.arpa", "http://host.docker.internal:1234",
      "http://llm.corp.internal",
    ]) expect(publicProvider(providerOf(url))).toBe("local");
  });

  test("any other host is custom, never its name", () => {
    for (const url of [
      "https://gpu.popescu-family.ro/v1", "https://acme-corp.openai.azure.com", "http://172.32.0.1",
      "http://8.8.8.8", "https://api.custom.com/v1", "not a url",
    ]) expect(publicProvider(providerOf(url))).toBe("custom");
  });
});
