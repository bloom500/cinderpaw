import { expect, test } from "bun:test";
import { codeFrom, startSession } from "./session";

const res = (ok: boolean) => ({ ok } as Response);

test("the code is read from the fragment only", () => {
  expect(codeFrom("#code=abc123")).toBe("abc123");
  expect(codeFrom("")).toBeNull();
  expect(codeFrom("#other=1")).toBeNull();
});

test("a good code signs in", async () => {
  const calls: string[] = [];
  const screen = await startSession("#code=abc", async (url) => { calls.push(String(url)); return res(true); });
  expect(screen).toBe("signed-in");
  expect(calls[0]).toBe("/web/session");
});

test("a used code with a still-valid cookie stays signed in", async () => {
  const screen = await startSession("#code=old", async (url) => res(String(url) === "/web/me"));
  expect(screen).toBe("signed-in");
});

test("no code and no cookie shows the shortcut hint, never an error", async () => {
  expect(await startSession("", async () => res(false))).toBe("signed-out");
  expect(await startSession("", async () => { throw new Error("offline"); })).toBe("signed-out");
});
