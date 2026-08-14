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
  /** Bounded tail of what the child has been doing, newest last. */
  trail?: TrailEntry[];
}

/** What `rlm()` hands back the instant a child is admitted. */
export interface ChildHandle {
  rlm_child_id: string;
  name: string;
  status: "running";
}

/**
 * How many trail entries a child keeps. Upstream's `agent_observe` inspects a
 * child's rollout; we cannot stream one into a notebook cell, so each child
 * keeps a bounded tail of what it did. Bounded because a runaway child would
 * otherwise grow this without limit inside a long-lived gateway.
 */
const TRAIL_MAX = 40;

/** One line of a child's rollout, as the parent sees it. */
export interface TrailEntry {
  at: number;
  kind: string;
  detail: string;
}

/** The work a child actually does. Supplied by the host. */
export type RunChild = (
  task: string,
  allowedTools: string[] | undefined,
  onEvent: (kind: string, detail: string) => void,
  /** The registry's id for this child. The host must use it as the subagent
   *  id, so a tool the child calls can be traced back to this entry. */
  childId: string,
  /**
   * Cancellation for THIS child. The host must honour it or Stop is a lie.
   *
   * It may ALREADY be aborted on arrival — the parent's turn can be stopped
   * between the model asking for a worker and the worker starting. Check
   * `signal.aborted` before doing any work; an implementation that only
   * subscribes to `abort` will wait forever for an event that already fired.
   */
  signal: AbortSignal,
) => Promise<{
  status: "completed" | "failed" | "timeout" | "budget_exceeded" | "cancelled";
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

/** A message from a child to the parent that spawned it. */
export interface ChildMessage {
  at: number;
  from: string;
  text: string;
}

/** How many unread messages a parent's inbox holds before the oldest drop. */
const INBOX_MAX = 100;

/**
 * One parent's direct children. Not shared between sessions: a parent may only
 * see and delete its own, which is upstream's rule too.
 */
export class ChildRegistry {
  readonly #entries = new Map<string, ChildEntry>();
  readonly #byName = new Map<string, string>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #aborts = new Map<string, AbortController>();
  readonly #inbox: ChildMessage[] = [];
  #seq = 0;

  constructor(private readonly run: RunChild) {}

  /**
   * Admit a child and return immediately. The run continues in the background;
   * an unhandled rejection here would take the whole sidecar down, so the
   * promise catches everything and parks it on the entry.
   *
   * `opts.signal` is the PARENT's cancellation — the user's Stop. Because a
   * child is detached from the turn that spawned it, this is the only thread
   * connecting the two: without it, Stop ended the parent's turn while its
   * workers kept calling a paid model in the background, invisibly and with
   * nothing left in the UI able to reach them.
   */
  admit(
    task: string,
    opts: { name?: string; allowedTools?: string[]; signal?: AbortSignal } = {},
  ): ChildHandle {
    const requested = normalizeRequestedName(opts.name);
    const id = `sa-${(++this.#seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = requested ?? defaultChildName(task, id);

    // Upstream requires names unique among siblings.
    if (this.#byName.has(name)) throw new Error(`rlm.run name "${name}" is already used by a sibling`);

    const entry: ChildEntry = { rlm_child_id: id, name, status: "running", trail: [] };
    this.#entries.set(id, entry);
    this.#byName.set(name, id);

    const push = (kind: string, detail: string) => {
      const t = entry.trail!;
      t.push({ at: Date.now(), kind, detail: detail.slice(0, 200) });
      if (t.length > TRAIL_MAX) t.splice(0, t.length - TRAIL_MAX);
    };

    // One controller per child, chained to the parent's. Per-child rather than
    // shared so `delete_subagent` can grow the ability to stop just one later
    // without every sibling dying with it.
    const ac = new AbortController();
    const parent = opts.signal;
    const onParentAbort = () => ac.abort("parent stopped");
    if (parent?.aborted) ac.abort("parent stopped");
    else parent?.addEventListener("abort", onParentAbort, { once: true });
    this.#aborts.set(id, ac);

    const p = this.run(task, opts.allowedTools, push, id, ac.signal)
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
        // The parent's signal outlives this child; leaving the listener on it
        // leaks one per worker ever spawned in the session.
        parent?.removeEventListener("abort", onParentAbort);
        this.#aborts.delete(id);
        this.#inflight.delete(p);
      });
    this.#inflight.add(p);

    return { rlm_child_id: id, name, status: "running" };
  }

  list(): ChildEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  /**
   * Deliver a message from a child. This is the half of upstream's agent
   * messaging that actually changes what an agent can do: a worker can report
   * a partial finding, or ask for a decision, without waiting to finish.
   *
   * Only children of THIS parent may post, checked by id — a worker cannot
   * address a stranger's inbox, which is upstream's family rule reduced to the
   * one relationship we have.
   */
  post(childId: string, text: string): void {
    const entry = this.#entries.get(childId);
    if (!entry) throw new Error(`unknown child ${childId}`);
    const body = text.trim();
    if (!body) return;
    this.#inbox.push({ at: Date.now(), from: entry.name, text: body.slice(0, 4000) });
    // Oldest go first: a parent reading its inbox wants the recent traffic,
    // and an unbounded queue in a long-lived gateway is a slow leak.
    if (this.#inbox.length > INBOX_MAX) this.#inbox.splice(0, this.#inbox.length - INBOX_MAX);
  }

  /**
   * Read and clear the inbox. Draining on read is deliberate: the parent is a
   * model that re-reads its own transcript, so leaving messages in place would
   * make it act on the same report every turn.
   */
  drainInbox(): ChildMessage[] {
    const out = [...this.#inbox];
    this.#inbox.length = 0;
    return out;
  }

  /** Non-destructive count, so a parent can check without consuming. */
  get pending(): number {
    return this.#inbox.length;
  }

  /**
   * Upstream's `agent_observe`, in the shape a notebook can use. A child runs
   * in the background, so a parent that only sees `running` is blind for
   * however long the work takes — this returns what the child has been doing
   * so far, which is the point of observing rather than waiting.
   */
  observe(target: string): ChildEntry {
    const id = this.#entries.has(target) ? target : this.#byName.get(target);
    const entry = id ? this.#entries.get(id) : undefined;
    if (!entry) throw new Error(`rlm.observe: no child matches "${target}"`);
    return { ...entry, trail: [...(entry.trail ?? [])] };
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
