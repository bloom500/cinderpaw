import { expect, test } from "bun:test";
import { COPY } from "./copy";
import {
  commonFirst, failureLine, firstOffers, load, manualCandidate, mask, save, tryCandidate, tryKey,
  type Api, type Candidate, type KeyResult, type Outcome, type Provider,
} from "./onboarding";

const openrouter: Provider = {
  id: "openrouter", name: "OpenRouter", default_model: "openai/gpt-4o",
  default_base_url: "https://openrouter.ai/api/v1", console_url: "https://openrouter.ai/keys",
};
const ok: Outcome = { ok: true, status: "ok", message: "The model replied." };
const lineOf = (r: KeyResult) => (r.ok ? "" : r.line);
const fail = (status: string): Outcome => ({ ok: false, status, message: `raw ${status} message` });

function fakeApi(verifyResult: Outcome | Error, detected: Candidate[] = []) {
  const calls = { verify: [] as { c: Candidate; key?: string }[], activate: [] as Candidate[] };
  const api: Api = {
    detect: async () => detected,
    catalog: async () => [openrouter],
    verify: async (c, key) => {
      calls.verify.push({ c, key });
      if (verifyResult instanceof Error) throw verifyResult;
      return verifyResult;
    },
    activate: async (c) => { calls.activate.push(c); },
  };
  return { api, calls };
}

test("a good key is verified, trimmed, made active, and only its mask comes back", async () => {
  const { api, calls } = fakeApi(ok);
  const r = await tryKey(api, manualCandidate(openrouter), "  sk-or-v1-abcdef1234\n");
  expect(r).toEqual({ ok: true, mask: "sk-…1234" });
  expect(calls.verify[0].key).toBe("sk-or-v1-abcdef1234");
  expect(calls.activate.length).toBe(1);
});

test("each failure is a plain sentence, never a code", async () => {
  expect(lineOf(await tryKey(fakeApi(fail("auth")).api, manualCandidate(openrouter), "k"))).toBe(COPY.badKey);
  expect(lineOf(await tryKey(fakeApi(fail("billing")).api, manualCandidate(openrouter), "k"))).toBe(COPY.noCredit);
  expect(lineOf(await tryKey(fakeApi(fail("rate_limit")).api, manualCandidate(openrouter), "k"))).toBe(COPY.busy);
  expect(lineOf(await tryKey(fakeApi(new Error("fetch failed")).api, manualCandidate(openrouter), "k"))).toBe(COPY.offline);
  const other = await tryKey(fakeApi(fail("format")).api, manualCandidate(openrouter), "k");
  expect(lineOf(other)).toBe(COPY.somethingElse);
  expect(other.ok ? "" : other.details).toBe("raw format message");
});

test("a failed key is never made active", async () => {
  const { api, calls } = fakeApi(fail("auth"));
  await tryKey(api, manualCandidate(openrouter), "k");
  expect(calls.activate.length).toBe(0);
});

test("an empty paste is refused without calling the engine", async () => {
  const { api, calls } = fakeApi(ok);
  expect((await tryKey(api, manualCandidate(openrouter), "   ")).ok).toBe(false);
  expect(calls.verify.length).toBe(0);
});

test("a brain from before is offered first, and Ollama only when it is running", async () => {
  const existing: Candidate = { kind: "existing_config", id: "byok:openrouter", label: "OpenRouter (openai/gpt-4o)" };
  const ollama: Candidate = { kind: "ollama", id: "ollama:qwen3", label: "Ollama (qwen3)" };
  const other: Candidate = { kind: "hardware_download", id: "dl", label: "download" };
  expect(await firstOffers(fakeApi(ok, [other, ollama, existing]).api)).toEqual({ existing, local: ollama });
  expect(await firstOffers(fakeApi(ok, [other]).api)).toEqual({});
  expect(await firstOffers({ ...fakeApi(ok).api, detect: async () => { throw new Error("down"); } })).toEqual({});
});

test("a detected brain is verified without asking for a key", async () => {
  const { api, calls } = fakeApi(ok);
  const r = await tryCandidate(api, { kind: "ollama", id: "ollama:qwen3", label: "Ollama" });
  expect(r.ok).toBe(true);
  expect(calls.verify[0].key).toBeUndefined();
});

test("closing the page mid-way resumes at the same step, and no key is ever saved", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  save(storage, { step: "key", name: "Ana", providerId: "openrouter" });
  expect(load(storage)).toEqual({ step: "key", name: "Ana", providerId: "openrouter" });
  expect([...mem.values()].join("")).not.toContain("sk-");
  expect(load({ getItem: () => "{not json", setItem: () => {} })).toBeNull();
  expect(load({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} })).toBeNull();
});

test("the mask shows only the ends", () => {
  expect(mask("sk-or-v1-0123456789abcdef")).toBe("sk-…cdef");
  expect(mask("short")).toBe("…");
});

test("unknown statuses fall back to the plain sentence with details", () => {
  expect(failureLine(fail("unknown"))).toEqual({ line: COPY.somethingElse, details: "raw unknown message" });
});

test("a beginner sees four common providers first, in a fixed order, the rest behind a button", () => {
  const p = (id: string): Provider => ({ ...openrouter, id, name: id });
  const all = ["openai", "anthropic", "google", "kimi", "glm", "openrouter", "nvidia"].map(p);
  const { common, rest } = commonFirst(all);
  expect(common.map((x) => x.id)).toEqual(["openrouter", "openai", "anthropic", "google"]);
  expect(rest.map((x) => x.id)).toEqual(["kimi", "glm", "nvidia"]);
});
