/**
 * Child registry — the async half of RLM.
 *
 * Ported from Prime Agent's `core/rlm-runtime.ts` at commit 965941c (MIT,
 * Copyright (c) 2025 Mario Zechner; see ../../../THIRD-PARTY-NOTICES.md). The
 * validation rules, the name-slug algorithm and the admission semantics are
 * theirs and are reproduced faithfully; only the host bindings are ours.
 *
 * Their `rlm()` does NOT return the child's answer. It *admits* the child and
 * returns a handle immediately, so the parent can fan out several workers in
 * one cell and end its turn instead of blocking on them. The parent recovers
 * children later through `rlm.list_subagents()`. That is the semantic this
 * module restores — the first port blocked on the child, which made fan-out
 * a lie: three `await rlm(...)` calls ran one after another.
 *
 * Deliberate difference: Prime Agent delivers answers over an agent-messaging
 * capability and says the handle "never returns the child's answer". Feral has
 * no mailbox, so the answer is parked on the registry entry and read back via
 * `list_subagents()`. Same shape — admission is instant, collection is a
 * separate step — without inventing a message bus we do not have.
 */

/** Their cap, reproduced: a name must fit an agent-message selector. */
const NAME_MAX_LENGTH = 64;

export type ChildStatus = "running" | "completed" | "error";

/** What a child looks like to the notebook. */
export interface ChildEntry {
  rlm_child_id: string;
  name: string;
  status: ChildStatus;
  /** Present once the child settles. */
  answer?: string;
  toolCalls?: number;
  durationMs?: number;
  error?: string;
}

/** What `rlm()` hands back the instant a child is admitted. */
export interface ChildHandle {
  rlm_child_id: string;
  name: string;
  status: "running";
}

/** The work a child actually does. Supplied by the host. */
export type RunChild = (
  task: string,
  allowedTools: string[] | undefined,
) => Promise<{
  status: "completed" | "failed" | "timeout" | "budget_exceeded";
  answer: string;
  toolCalls: number;
  durationMs: number;
  subagentId: string;
}>;

/**
 * Validate an orchestrator-supplied name. Ported from
 * `normalizeRequestedRlmSubagentSessionName` — same checks, same messages, so a
 * model that learned the upstream errors reads ours identically.
 */
export function normalizeRequestedName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("rlm.run name must be a string");
  const name = value.trim();
  if (!name) throw new Error("rlm.run name must not be empty");
  if (name.length > NAME_MAX_LENGTH) {
    throw new Error(`rlm.run name must be at most ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

/**
 * Readable, collision-resistant default name, usable as a message selector.
 * Ported from `createDefaultRlmSubagentSessionName`, including the NFKD
 * normalisation and diacritic strip — without it a Romanian or French task
 * string yields a name full of dropped characters.
 */
export function defaultChildName(prompt: string, childId: string): string {
  const promptSlug = prompt
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const idSuffix =
    childId
      .replace(/^sub-|^sa-/, "")
      .replace(/[^A-Za-z0-9]+/g, "")
      .slice(-8) || "child";
  const fixedLength = "subagent--".length + idSuffix.length;
  const promptPart = (promptSlug || "worker")
    .slice(0, Math.max(1, NAME_MAX_LENGTH - fixedLength))
    .replace(/-+$/g, "");
  return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

/**
 * One parent's direct children. Not shared between sessions: a parent may only
 * see and delete its own, which is upstream's rule too.
 */
export class ChildRegistry {
  readonly #entries = new Map<string, ChildEntry>();
  readonly #byName = new Map<string, string>();
  readonly #inflight = new Set<Promise<void>>();
  #seq = 0;

  constructor(private readonly run: RunChild) {}

  /**
   * Admit a child and return immediately. The run continues in the background;
   * an unhandled rejection here would take the whole sidecar down, so the
   * promise catches everything and parks it on the entry.
   */
  admit(task: string, opts: { name?: string; allowedTools?: string[] } = {}): ChildHandle {
    const requested = normalizeRequestedName(opts.name);
    const id = `sa-${(++this.#seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = requested ?? defaultChildName(task, id);

    // Upstream requires names unique among siblings.
    if (this.#byName.has(name)) throw new Error(`rlm.run name "${name}" is already used by a sibling`);

    const entry: ChildEntry = { rlm_child_id: id, name, status: "running" };
    this.#entries.set(id, entry);
    this.#byName.set(name, id);

    const p = this.run(task, opts.allowedTools)
      .then((r) => {
        entry.status = r.status === "completed" ? "completed" : "error";
        entry.answer = r.answer;
        entry.toolCalls = r.toolCalls;
        entry.durationMs = r.durationMs;
        if (r.status !== "completed") entry.error = r.status;
      })
      .catch((e) => {
        entry.status = "error";
        entry.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.#inflight.delete(p);
      });
    this.#inflight.add(p);

    return { rlm_child_id: id, name, status: "running" };
  }

  list(): ChildEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  /** Accepts either an id or a name, as upstream's `delete_subagent` does. */
  delete(target: string): { subagent: ChildEntry; outcome: "deleted" | "skipped_running" } {
    const id = this.#entries.has(target) ? target : this.#byName.get(target);
    const entry = id ? this.#entries.get(id) : undefined;
    if (!entry || !id) throw new Error(`rlm.delete_subagent: no child matches "${target}"`);
    if (entry.status === "running") return { subagent: { ...entry }, outcome: "skipped_running" };
    this.#entries.delete(id);
    this.#byName.delete(entry.name);
    return { subagent: { ...entry }, outcome: "deleted" };
  }

  /** Test/shutdown helper: settle every in-flight child. */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }
}
