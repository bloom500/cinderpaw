/**
 * Spec 2026-09-24 §8.4: what a person reads is grade 6 or below. The steps
 * for the five connectors a beginner is offered first are read out loud to
 * them, so they are held to it too, scored the way the page's own copy is.
 * Links are clicked, not read, and scopes like chat:write are typed, not
 * understood, so neither counts.
 */
import { expect, test } from "bun:test";
import { stepsFor } from "../src/tools/builtin/connectors-manage.ts";
import { fkGrade } from "../../web-app/src/readability.ts";

const FIRST_OFFERED = ["discord", "telegram", "slack", "whatsapp", "matrix"];

test("the first connectors' steps read at grade 6 or below", () => {
  const hard: string[] = [];
  for (const id of FIRST_OFFERED) {
    for (const step of stepsFor(id, true)) {
      const read = step
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !s.includes("request_secret") && !/^Never ask/.test(s))
        .join(" ")
        .replace(/https?:\/\/\S+/g, "link")
        .replace(/\b[\w/]+:[\w_:]+\b/g, "scope");
      const g = fkGrade(read);
      if (read.trim() && g > 6) hard.push(`${id} ${g.toFixed(1)}  ${read}`);
    }
  }
  expect(hard).toEqual([]);
});

test("they end with the person messaging the bot, not hunting for a user id", () => {
  for (const id of ["discord", "telegram", "slack", "matrix"]) {
    const steps = stepsFor(id, true).join(" ");
    expect(steps).toContain("is that you?");
    expect(steps.toLowerCase()).not.toContain("allowlist");
  }
});
