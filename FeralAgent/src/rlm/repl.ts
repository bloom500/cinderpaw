/**
 * Persistent JS notebook — Feral's answer to Prime Agent's IPython kernel.
 *
 * The idea is Prime Intellect's RLM (Recursive Language Model): give the model
 * a long-lived interpreter instead of a one-tool-per-turn loop, so it can bind
 * results to variables, write helper functions, and compose tool calls as
 * program logic. See ../../THIRD-PARTY-NOTICES.md.
 *
 * Their kernel is IPython because their stack is Python. Ours is JavaScript
 * because the sidecar already runs on Bun, so the interpreter is free and
 * in-process — no `uv`, no Python, no zeromq, and the sidecar keeps its zero
 * runtime dependencies and its single-binary build.
 *
 * ── The one rule this file exists to keep ──────────────────────────────────
 * `ToolRegistry` is the choke point where the egress proxy, the audit log and
 * the process sandbox are applied: "a tool can never be invoked outside the
 * sandbox and can never exercise an undeclared permission" (registry.ts).
 * A naive `eval` would hand the model ambient `fetch`, `Bun`, `process` and
 * `require`, i.e. every permission at once, and the sandbox would be over.
 *
 * So the code runs in a `node:vm` context whose globals are ONLY what we put
 * there: a curated set of pure builtins plus one async function per registered
 * tool, each of which is a thin wrapper over `registry.call()`. Every tool call
 * from the notebook is audited and permission-checked exactly like a call from
 * the normal agent loop.
 *
 * Removing globals is not enough on its own. `node:vm` is not a security
 * boundary out of the box: every host object reachable from the context leaks
 * host `Function` via `.constructor.constructor`, and `Function("return
 * process")()` compiles in *our* realm — unaudited filesystem and network, past
 * every gate above. During development that escape worked from `this`, from an
 * object literal, from an injected builtin, from a tool wrapper, and from a
 * tool's return value. All of them are closed by severing prototypes (see
 * `severed`) and by injecting no host builtins at all, and each route has a
 * regression test. Those tests are load-bearing: if one starts passing values
 * back out, the sandbox is void.
 *
 * The honest residual: this hardens `vm`, it does not turn it into a jail
 * against an adversary who controls the source. The threat model is a model
 * writing clumsy or careless code, and Feral already exposes `shell-exec`
 * through the same registry, so the notebook widens no permission that was not
 * already reachable. If Feral ever runs code from an untrusted third party
 * here, this needs a real isolate, not prototype surgery.
 *
 * ponytail: no per-tool codegen, no TS transpile step — tools are injected as
 * real function objects. Add a compile step only if the model starts needing
 * type hints inside the notebook.
 */

import { createContext, runInContext } from "node:vm";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolResult } from "../types.ts";
import type { ChildRegistry } from "./children.ts";

/** How long one cell may run before it is abandoned. */
export const DEFAULT_CELL_TIMEOUT_MS = 120_000;

/** Result of evaluating one notebook cell. */
export interface CellResult {
  ok: boolean;
  /** Stringified value of the final expression, when it produced one. */
  value?: string;
  /** Anything the cell wrote with `console.log`/`console.error`, in order. */
  output: string;
  /** Present when the cell threw or timed out. */
  error?: string;
  /** Tool names this cell invoked, in call order. Feeds the audit trail. */
  toolCalls: string[];
}

export type { ChildEntry, ChildHandle } from "./children.ts";

/**
 * Prime Agent defaults `RLM_MAX_DEPTH` to 1 and errors at the limit; we keep
 * both. Depth 1 means the root may spawn children and those children may not
 * spawn further — recursion deep enough to fan out, shallow enough that a
 * confused model cannot open a fork bomb of paid model calls.
 */
export const DEFAULT_MAX_DEPTH = 1;

export interface ReplOptions {
  registry: ToolRegistry;
  sessionId: string;
  /** Session-level abort, so `stop()` reaches a running cell's tool calls. */
  signal?: AbortSignal;
  cellTimeoutMs?: number;
  /**
   * Tool names to leave out. The notebook tool itself must be excluded, or the
   * model can call the notebook from inside the notebook.
   */
  exclude?: readonly string[];
  /** This parent's child registry. Omit to leave `rlm` out of the notebook. */
  children?: ChildRegistry;
  /** This notebook's depth. 0 is the root agent. */
  depth?: number;
  maxDepth?: number;
}

/**
 * Cut a host object's prototype chain so the notebook cannot walk it back into
 * our realm.
 *
 * This is the subtle part, and getting it wrong silently voids the sandbox. A
 * fresh `vm` context has its own complete set of standard builtins from its own
 * realm, so we must inject NONE of ours: handing over host `JSON`, `Object` or
 * `Array` would also hand over host `Function` via `.constructor.constructor`,
 * and `Function("return process")()` compiles in the *host* realm — full
 * filesystem and network, straight past the registry. The same applies to the
 * tool wrappers and `console`, which are unavoidably host functions.
 *
 * Nulling their prototype removes `.constructor` entirely, which is what closes
 * the door. Verified by the escape tests in tests/rlm-notebook.test.ts; treat
 * those as load-bearing, not decorative.
 */
function severed<T extends object>(o: T): T {
  Object.setPrototypeOf(o, null);
  return o;
}

/** JS identifier for a tool name (`read_file` → `read_file`, `read-file` → `read_file`). */
export function toIdentifier(toolName: string): string {
  const id = toolName.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/**
 * A long-lived notebook. One instance per session: the context object survives
 * between cells, which is the whole point — variables, helper functions and
 * parsed data stay available across turns and across compaction.
 */
export class Notebook {
  readonly #ctx: Record<string, unknown>;
  readonly #timeoutMs: number;
  #log: string[] = [];
  #calls: string[] = [];
  #children: string[] = [];
  #injected = new Set<string>();

  constructor(opts: ReplOptions) {
    this.#timeoutMs = opts.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;

    const logLines: string[] = [];
    const write = (a: unknown[]) => {
      logLines.push(a.map(render).join(" "));
    };
    // Start from nothing: the context supplies its own JSON/Math/Array/etc.
    const sandbox: Record<string, unknown> = {
      console: severed({
        log: severed((...a: unknown[]) => write(a)),
        error: severed((...a: unknown[]) => write(a)),
        warn: severed((...a: unknown[]) => write(a)),
      }),
    };

    // One async function per tool. `registry.call` never throws, so a bad tool
    // surfaces as a returned ToolResult the model can branch on rather than an
    // exception that kills the cell.
    const excluded = new Set(opts.exclude ?? []);
    for (const tool of opts.registry.list()) {
      const name = tool.manifest.name;
      if (excluded.has(name)) continue;
      sandbox[toIdentifier(name)] = severed(async (args: Record<string, unknown> = {}) => {
        this.#calls.push(name);
        const res: ToolResult = await opts.registry.call(name, args ?? {}, opts.sessionId, {
          signal: opts.signal,
        });
        // Sever the result too: handing back an object with host
        // `Object.prototype` would reopen the `.constructor` route we just
        // closed. Own properties still read normally with a null prototype.
        return severed({ ok: res.ok, content: res.content, data: res.data, error: res.error });
      });
    }

    // ── the "R" in RLM ───────────────────────────────────────────────────
    // Recursion is what separates a notebook from a Recursive Language Model:
    // the model spawns workers *from code*, so it can fan out inside one cell
    // instead of one-per-turn. Feral already has bounded child agents
    // (core/subagent.ts) with their own filtered tool set and budget, so this
    // is a binding, not a new execution path.
    //
    // Divergence from Prime Agent, deliberate: their `rlm()` admits the child
    // and returns a handle immediately, with results arriving later over a
    // messaging capability. Feral has no parent/child mailbox, so a handle
    // would be a promise of a result nobody can collect. Ours awaits the child
    // and returns its answer. Revisit if a mailbox ever lands.
    const depth = opts.depth ?? 0;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (opts.children) {
      const kids = opts.children;
      const guard = () => {
        if (depth >= maxDepth) {
          throw new Error(`RLM recursion depth limit reached (depth=${depth}, maxDepth=${maxDepth})`);
        }
      };
      // `rlm` is a callable with methods hung off it, exactly as upstream
      // exposes it (`rlm(...)`, `rlm.list_subagents()`, `rlm.delete_subagent()`).
      const rlm = severed(async (task: unknown, options?: unknown) => {
        guard();
        if (typeof task !== "string" || !task.trim()) {
          throw new Error("rlm(task) requires a non-empty string");
        }
        const o = (options ?? {}) as { name?: unknown; allowedTools?: unknown };
        const tools = Array.isArray(o.allowedTools)
          ? o.allowedTools.filter((t): t is string => typeof t === "string")
          : undefined;
        const h = kids.admit(task.trim(), { name: o.name as string | undefined, allowedTools: tools });
        this.#children.push(h.rlm_child_id);
        return severed({ ...h });
      }) as ((task: unknown, options?: unknown) => Promise<unknown>) & Record<string, unknown>;

      rlm.list_subagents = severed(async () => severed({ subagents: kids.list().map((e) => severed({ ...e })) }));
      rlm.observe = severed(async (target: unknown) => {
        if (typeof target !== "string" || !target.trim()) {
          throw new Error("rlm.observe target must be a non-empty string");
        }
        const e = kids.observe(target.trim());
        return severed({ ...e, trail: (e.trail ?? []).map((t) => severed({ ...t })) });
      });
      rlm.delete_subagent = severed(async (target: unknown) => {
        if (typeof target !== "string" || !target.trim()) {
          throw new Error("rlm.delete_subagent target must be a non-empty string");
        }
        const r = kids.delete(target.trim());
        return severed({ subagent: severed({ ...r.subagent }), outcome: r.outcome });
      });
      sandbox.rlm = rlm;
    }

    // Everything we put in is ours, not the user's — snapshot must skip these.
    this.#injected = new Set(Object.keys(sandbox));

    // The contextified global IS this host object, so top-level `this` in a
    // cell would otherwise expose host `Object.prototype` — the last escape
    // route, and the one a model hits by writing plain `this`.
    this.#ctx = createContext(severed(sandbox));
    // The log array is read back after each cell; keep it on our side only.
    this.#log = logLines;
  }

  /** Tool names invoked since construction, in order. */
  get toolCalls(): readonly string[] {
    return this.#calls;
  }

  /** Ids of child agents this notebook spawned, in order. */
  get children(): readonly string[] {
    return this.#children;
  }

  /**
   * Serialise the user's variables so a notebook survives a restart.
   *
   * Upstream snapshots the IPython namespace with `dill` under a size cap,
   * skipping variables that are too large (`KernelSnapshotConfig.maxBytes`,
   * default 256 MiB). Same contract here, different mechanism: JavaScript has
   * no dill, so this keeps what JSON round-trips and drops the rest. A closure,
   * a class instance or a live handle cannot be revived honestly, and silently
   * restoring a broken shell of one is worse than admitting it is gone —
   * `restore` reports what came back so the model can be told.
   *
   * Injected names (tools, `rlm`, `console`) are never captured: they are
   * rebuilt on construction and would otherwise be resurrected as dead data.
   */
  snapshot(maxBytes = 8 * 1024 * 1024): { vars: Record<string, unknown>; skipped: string[] } {
    const vars: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const key of Object.keys(this.#ctx)) {
      if (this.#injected.has(key)) continue;
      const v = this.#ctx[key];
      if (typeof v === "function") {
        skipped.push(key);
        continue;
      }
      try {
        const s = JSON.stringify(v);
        if (s === undefined) {
          skipped.push(key);
          continue;
        }
        if (s.length > maxBytes) {
          skipped.push(key);
          continue;
        }
        vars[key] = JSON.parse(s);
      } catch {
        skipped.push(key); // cyclic, a BigInt, a live handle — not revivable
      }
    }
    return { vars, skipped };
  }

  /** Put a snapshot's variables back. Never overwrites an injected name. */
  restore(snap: { vars?: Record<string, unknown> } | null | undefined): string[] {
    const restored: string[] = [];
    for (const [k, v] of Object.entries(snap?.vars ?? {})) {
      if (this.#injected.has(k)) continue;
      this.#ctx[k] = v;
      restored.push(k);
    }
    return restored;
  }

  /**
   * Run one cell. Top-level `await` works: the source is wrapped in an async
   * IIFE, and the completion value of the last expression is returned the way
   * a REPL would, so `x = await read_file({path})` both binds and echoes.
   */
  async run(source: string): Promise<CellResult> {
    const before = this.#calls.length;
    const log = this.#log;
    log.length = 0;

    let lastError: unknown;
    for (const body of cellBodies(source)) {
      try {
        const value = await withTimeout(
          runInContext(`(async () => { ${body} })()`, this.#ctx, {
            timeout: this.#timeoutMs,
          }) as Promise<unknown>,
          this.#timeoutMs,
        );
        return {
          ok: true,
          value: value === undefined ? undefined : render(value),
          output: log.join("\n"),
          toolCalls: this.#calls.slice(before),
        };
      } catch (err) {
        lastError = err;
        // A candidate that does not parse is our transform guessing wrong, not
        // the model's mistake — fall through and try the plainer form. Any
        // other failure is real and must not be retried: the cell may already
        // have called tools, and re-running would call them twice.
        // Name, not `instanceof`: the error is constructed inside the vm's
        // realm, so it is not an instance of *our* SyntaxError and the
        // fallback would never fire.
        if ((err as Error | undefined)?.name === "SyntaxError") continue;
        break;
      }
    }
    return {
      ok: false,
      output: log.join("\n"),
      error: lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError),
      toolCalls: this.#calls.slice(before),
    };
  }
}

/**
 * Candidate bodies for one cell, in the order they should be tried. The first
 * that parses wins; a SyntaxError means the transform guessed wrong, not that
 * the model wrote bad code.
 *
 * Two problems have to be solved at once, and they pull against each other:
 *
 *  1. **Declarations must survive the cell.** The body runs inside an async
 *     IIFE (top-level `await` has to work), which makes `const`/`let`/`var`
 *     function-scoped — so a naive wrap silently drops every variable the
 *     moment the cell ends, destroying the one property the notebook exists
 *     for. Stripping the keyword at top level turns the declaration into an
 *     implicit global assignment, which lands on the context object and
 *     therefore persists. The context is non-strict, so this is legal.
 *  2. **The last expression should echo**, the way a REPL prints it.
 *
 * ponytail: a brace/quote scanner, not a parser. It understands strings,
 * templates and comments, which covers real cells; it does not understand
 * regex literals containing unbalanced braces. Reach for a real parser only if
 * that actually bites.
 */
export function cellBodies(source: string): string[] {
  const trimmed = source.trim();
  if (!trimmed) return [""];
  const hoisted = hoistTopLevelDeclarations(trimmed);
  const out: string[] = [];

  // A trailing semicolon suppresses the echo, the way it does in a Node REPL:
  // `const b = 7;` is a declaration the user did not ask to see printed.
  const suppressed = /;\s*$/.test(hoisted);
  const core = hoisted.replace(/;\s*$/, "");
  const cut = lastTopLevelBreak(core);
  const head = cut === -1 ? "" : core.slice(0, cut + 1);
  const tail = (cut === -1 ? core : core.slice(cut + 1)).trim();

  if (tail && !suppressed && !/^(return|throw|if|for|while|switch|try|do)\b/.test(tail)) {
    out.push(`${head}\nreturn (${tail});`);
  }

  out.push(hoisted);
  return out;
}

/** Strip `const`/`let`/`var` and de-declare `function`/`class` at depth 0 only. */
function hoistTopLevelDeclarations(src: string): string {
  let out = "";
  let i = 0;
  for (const { index, depth, atStatementStart } of scan(src)) {
    if (index < i) continue;
    if (depth !== 0 || !atStatementStart) continue;

    const rest = src.slice(index);
    const decl = /^(const|let|var)\s+/.exec(rest);
    if (decl) {
      out += src.slice(i, index);
      const after = rest.slice(decl[0].length);
      // `const {a} = o` → `({a} = o)`; a bare `{` would parse as a block.
      out += /^[[{]/.test(after) ? "(" : "";
      i = index + decl[0].length;
      if (/^[[{]/.test(after)) {
        const end = statementEnd(src, i);
        out += `${src.slice(i, end)})`;
        i = end;
      }
      continue;
    }
    const fn = /^function\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (fn) {
      out += `${src.slice(i, index)}${fn[1]} = function ${fn[1]}`;
      i = index + fn[0].length;
      continue;
    }
    const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (cls) {
      out += `${src.slice(i, index)}${cls[1]} = class ${cls[1]}`;
      i = index + cls[0].length;
      continue;
    }
  }
  return out + src.slice(i);
}

/** Index of the last top-level `;` or newline that ends a statement, or -1. */
function lastTopLevelBreak(src: string): number {
  let last = -1;
  for (const { index, depth, isBreak } of scan(src)) {
    if (isBreak && depth === 0 && index < src.length - 1) last = index;
  }
  return last;
}

function statementEnd(src: string, from: number): number {
  for (const { index, depth, isBreak } of scan(src)) {
    if (index >= from && isBreak && depth === 0) return index;
  }
  return src.length;
}

/**
 * Walk the source once, yielding a record per interesting position: bracket
 * depth, whether a statement could start here, and whether this char ends one.
 * Strings, templates and comments are skipped so their contents never count.
 */
function* scan(src: string): Generator<{
  index: number;
  depth: number;
  atStatementStart: boolean;
  isBreak: boolean;
}> {
  let depth = 0;
  let fresh = true; // no code seen yet on this statement
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i === -1) return;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      fresh = false;
      continue;
    }
    yield { index: i, depth, atStatementStart: fresh, isBreak: c === ";" || c === "\n" };
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;

    if (c === ";" || c === "\n" || c === "}") fresh = true;
    else if (!/\s/.test(c)) fresh = false;
  }
}

/** `vm`'s own timeout does not cover work awaited after the sync frame returns. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`cell timed out after ${ms}ms`)), ms)),
  ]);
}

/** Compact, deterministic rendering — the model reads these, so no [object Object]. */
function render(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}
