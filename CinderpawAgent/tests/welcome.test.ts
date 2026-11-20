import { describe, expect, test } from "bun:test";
import { fallbackWelcome, welcomePrompt, writeWelcome } from "../src/core/welcome.ts";

const base = { agentName: "Pixel", userName: "Ana", apps: ["Visual Studio Code", "Figma", "Steam"], local: false };
const reply = "Hi Ana! I'm Pixel. Looks like you build things and play hard.\n- **\"Explain this error.\"** We fix it together.";

describe("the welcome the model writes", () => {
  test("the model gets the names and the rules, including never naming an app", () => {
    const { system, user } = welcomePrompt(base);
    expect(user).toContain("Visual Studio Code");
    expect(system).toContain("NEVER name");
    expect(system).toContain('Start with "Hi Ana! I\'m Pixel"');
    expect(system).not.toContain("Cubby");
  });

  test("a cloud model: its words, then our line that says where the list went", async () => {
    const text = await writeWelcome({ ...base, complete: async () => reply });
    expect(text.startsWith(reply)).toBe(true);
    expect(text).toContain("went only to the AI you connected");
  });

  test("a model on this computer: the line says the list stayed here", async () => {
    const text = await writeWelcome({ ...base, local: true, complete: async () => reply });
    expect(text).toContain("They stayed here");
  });

  test("its private thinking is never shown", async () => {
    const text = await writeWelcome({ ...base, complete: async () => `<think>they code</think>${reply}` });
    expect(text).not.toContain("they code");
  });

  test("the model fails, answers nothing or runs away: the fixed welcome, no claim about apps", async () => {
    for (const complete of [async () => { throw new Error("401"); }, async () => "", async () => "x".repeat(2000)]) {
      const text = await writeWelcome({ ...base, complete });
      expect(text).toBe(fallbackWelcome("Pixel", "Ana"));
      expect(text).not.toContain("apps");
    }
  });

  test("no list could be read: no line about apps", async () => {
    const text = await writeWelcome({ ...base, apps: [], complete: async () => reply });
    expect(text).toBe(reply);
  });
});
