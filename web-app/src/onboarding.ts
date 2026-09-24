// The scripted onboarding (spec 2026-09-24 §5), as plain functions so every
// path is a unit test. Every call goes to routes the engine already has:
// setup/detect, setup/verify (a REAL completion; the key reaches the OS
// keychain only if it works), providers/catalog and /runtime/model.

import { COPY } from "./copy";

export type Step = "name" | "brain" | "show-me" | "pick-provider" | "key" | "done";
export type Candidate = {
  kind: string;
  id: string;
  label: string;
  provider_id?: string;
  model?: string;
  base_url?: string;
  [k: string]: unknown;
};
export type Provider = { id: string; name: string; default_model: string; default_base_url: string; console_url?: string };
export type Outcome = { ok: boolean; status: string; message: string };
export type Saved = { step: Step; name: string; providerId?: string };
export type KeyResult = { ok: true; mask: string } | { ok: false; line: string; details?: string };

export interface Api {
  detect(): Promise<Candidate[]>;
  catalog(): Promise<Provider[]>;
  verify(c: Candidate, key?: string): Promise<Outcome>;
  activate(c: Candidate): Promise<void>;
}

/** The real API: same origin, the session cookie rides along. */
export function fetchApi(f: typeof fetch = fetch): Api {
  const json = async (r: Response) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  };
  const post = (url: string, body: unknown) =>
    f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    detect: async () => (await json(await f("/runtime/setup/detect"))).candidates ?? [],
    catalog: async () => json(await f("/runtime/providers/catalog")),
    verify: async (c, key) => {
      const r = await post("/runtime/setup/verify", { candidate: c, api_key: key, persist: true });
      // A 4xx/5xx here is the engine refusing the request itself, not a
      // verdict on the key: surface it as "something else" with details.
      if (!r.ok) return { ok: false, status: "unknown", message: `${r.status} ${await r.text()}` };
      return r.json();
    },
    activate: async (c) => {
      if (c.kind === "local_gguf" || !c.provider_id || !c.model) return;
      await post("/runtime/model", { id: `${c.provider_id}:${c.model}` });
    },
  };
}

/** A key typed by hand, shaped the way `cinderpaw setup` sends it. */
export function manualCandidate(p: Provider): Candidate {
  return {
    kind: "env_key",
    id: `manual:${p.id}`,
    label: `${p.name} (${p.default_model})`,
    detail: "manual key",
    provider_id: p.id,
    model: p.default_model,
    base_url: p.default_base_url,
  };
}

export function mask(key: string): string {
  return key.length < 12 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function failureLine(o: Outcome): { line: string; details?: string } {
  switch (o.status) {
    case "auth":
      return { line: COPY.badKey };
    case "billing":
      return { line: COPY.noCredit };
    case "rate_limit":
      return { line: COPY.busy };
    case "timeout":
    case "unavailable":
      return { line: COPY.offline, details: o.message };
    default:
      return { line: COPY.somethingElse, details: o.message };
  }
}

async function verifyAndActivate(api: Api, c: Candidate, key?: string): Promise<KeyResult> {
  try {
    const o = await api.verify(c, key);
    if (!o.ok) return { ok: false, ...failureLine(o) };
    await api.activate(c);
    return { ok: true, mask: key ? mask(key) : "" };
  } catch {
    return { ok: false, line: COPY.offline };
  }
}

export async function tryKey(api: Api, c: Candidate, raw: string): Promise<KeyResult> {
  // Keys copied from a web page arrive with spaces and newlines around them.
  const key = raw.trim();
  if (!key) return { ok: false, line: COPY.badKey };
  return verifyAndActivate(api, c, key);
}

export function tryCandidate(api: Api, c: Candidate): Promise<KeyResult> {
  return verifyAndActivate(api, c);
}

/** What detect found that needs no key: a brain from before, a running Ollama. */
export async function firstOffers(api: Api): Promise<{ existing?: Candidate; local?: Candidate }> {
  try {
    const found = await api.detect();
    const out: { existing?: Candidate; local?: Candidate } = {};
    const existing = found.find((c) => c.kind === "existing_config");
    const local = found.find((c) => c.kind === "ollama");
    if (existing) out.existing = existing;
    if (local) out.local = local;
    return out;
  } catch {
    return {};
  }
}

const KEY = "cinderpaw.onboarding";
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function load(storage: Store): Saved | null {
  try {
    const raw = storage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

/** Step, name and provider only: the key is never written here. */
export function save(storage: Store, s: Saved): void {
  try {
    storage.setItem(KEY, JSON.stringify({ step: s.step, name: s.name, providerId: s.providerId }));
  } catch {
    // Private window or blocked storage: the flow still works, it just won't resume.
  }
}
