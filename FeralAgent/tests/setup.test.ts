/**
 * Setup wizard — slice 5.1 tests.
 *
 * Tests the interactive setup flow with canned answers and a temp homeDir
 * so no real ~/.feral/ is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSetup } from "../src/tui/setup.ts";
import { loadBrainConfig } from "../src/brain/brain-config.ts";

let tempHome: string;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe("runSetup", () => {
  test("writes a brain.json the runtime can actually load (default model)", async () => {
    tempHome = join(tmpdir(), `feral-setup-${Date.now()}-${Math.random()}`);
    mkdirSync(tempHome, { recursive: true });

    const result = await runSetup(["", "", ""], { homeDir: tempHome });
    expect(result.created).toBe(true);
    const brainPath = resolve(tempHome, ".feral", "brain.json");
    expect(existsSync(brainPath)).toBe(true);

    // The contract guard: loadBrainConfig() must accept the wizard output.
    // This is exactly the path `feral chat` / FERAL_BRAIN=1 exercises.
    const cfg = loadBrainConfig({ brainPath });
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.mode).toBe("balanced");
    expect(cfg!.registry).toHaveLength(1);
    expect(cfg!.registry[0]!.id).toBe("local");
    expect(cfg!.registry[0]!.target.model).toBe("qwen2.5:7b");
    expect(cfg!.registry[0]!.local).toBe(true);
  });

  test("accepts custom model name", async () => {
    tempHome = join(tmpdir(), `feral-setup-${Date.now()}-${Math.random()}`);
    mkdirSync(tempHome, { recursive: true });

    const answers = ["llama3:8b", "http://localhost:11434", ""];
    const result = await runSetup(answers, { homeDir: tempHome });
    expect(result.created).toBe(true);
    const brainPath = resolve(tempHome, ".feral", "brain.json");
    const cfg = loadBrainConfig({ brainPath });
    expect(cfg!.registry[0]!.target.model).toBe("llama3:8b");
    expect(cfg!.registry[0]!.target.baseUrl).toBe("http://localhost:11434");
  });

  test("includes cloud model as a second registry entry when provided", async () => {
    tempHome = join(tmpdir(), `feral-setup-${Date.now()}-${Math.random()}`);
    mkdirSync(tempHome, { recursive: true });

    const answers = [
      "llama3:8b",
      "",
      "claude-sonnet-4-20250514",
      "https://api.anthropic.com/v1",
      "sk-ant-xxx",
    ];
    const result = await runSetup(answers, { homeDir: tempHome });
    expect(result.created).toBe(true);
    const brainPath = resolve(tempHome, ".feral", "brain.json");
    const cfg = loadBrainConfig({ brainPath });
    expect(cfg!.registry).toHaveLength(2);
    const cloud = cfg!.registry.find((m) => m.id === "cloud");
    expect(cloud).toBeDefined();
    expect(cloud!.target.model).toBe("claude-sonnet-4-20250514");
    expect(cloud!.target.apiKey).toBe("sk-ant-xxx");
    expect(cloud!.local).toBe(false);
  });

  test("detects existing setup and leaves it untouched on 'n'", async () => {
    tempHome = join(tmpdir(), `feral-setup-${Date.now()}-${Math.random()}`);
    mkdirSync(tempHome, { recursive: true });

    const brainDir = resolve(tempHome, ".feral");
    mkdirSync(brainDir, { recursive: true });
    const brainPath = resolve(brainDir, "brain.json");
    const original = JSON.stringify({ enabled: true, mode: "quality", registry: [] });
    writeFileSync(brainPath, original);

    const result = await runSetup(["n"], { homeDir: tempHome });
    expect(result.created).toBe(false);
    expect(readFileSync(brainPath, "utf8")).toBe(original);
  });

  test("returns brainPath in result", async () => {
    tempHome = join(tmpdir(), `feral-setup-${Date.now()}-${Math.random()}`);
    mkdirSync(tempHome, { recursive: true });

    const result = await runSetup(["", "", ""], { homeDir: tempHome });
    expect(result.brainPath).toBe(resolve(tempHome, ".feral", "brain.json"));
  });
});