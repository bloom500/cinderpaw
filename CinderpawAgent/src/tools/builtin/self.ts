/**
 * self.* — runtime introspection tools.
 *
 * The agent's mental model of its own substrate. This module exposes a
 * shell-style namespace of read-only tools the agent calls to answer
 * questions about itself without having to memorise any of it:
 *
 *   self_describe    — full runtime identity document (one call, all subsystems)
 *   self_status      — one-line heartbeat per subsystem
 *   self_runtime     — version, boot time, operating mode
 *   self_tools       — list of available tools (compact)
 *   self_providers   — configured inference providers + active primary/fallback
 *   self_memory      — Fractal Memory statistics
 *   self_connectors  — active connectors (NO secrets — names + protocol only)
 *   self_genome      — genome population summary
 *   self_dreams      — dream cycle last episode + state
 *   self_lora        — LoRA registry + active adapter
 *   self_health      — subsystem availability diagnostic
 *   self_subsystem   — deep dive on a specific subsystem by name
 *
 * The RSI ladder is L1..L6 — there is no L0 (`Tier 0` is the frozen eval
 * floor, a different axis entirely; see `infra/tier-loader.ts`):
 *
 *   L1 config     — genome evolution over agent params   (self_genome, self_dreams)
 *   L2 adapt      — personal LoRA adapters               (self_lora)
 *   L3 code       — code-RSI: the agent patches itself   (self_health, self_subsystem)
 *   L4 modules    — architecture evolution at the seams  (self_health, self_subsystem)
 *   L5 governance — the policy every promotion answers to (self_health, self_subsystem)
 *   L6 meta       — evolving the knobs L1 evolves under  (self_health, self_subsystem)
 *
 * Every rung is surfaced through the same three tools: `self_status` for the
 * heartbeat, `self_health` for "is it there?", `self_subsystem` for "how does
 * it work?". Nothing in the substrate may be invisible to the agent — an agent
 * that cannot see a subsystem cannot reason about it, report it, or debug it.
 * A new layer is not done until it has a row here.
 *
 * Mirror of the user's framing: "treat Cinderpaw's substrate like an operating
 * system; the agent doesn't need to memorise the capabilities — it just
 * needs to know it can ask the runtime". Each tool is small, focused, and
 * returns shaped data (not raw JSON dumps), so the LLM can compose a
 * concrete answer without guessing what's in ~/.feral/...
 *
 * Security posture: all reads are from internal TypeScript modules, no
 * user-controlled paths. No `fs:read` permission, no `allowedPaths` —
 * this is internalised data the agent queries, not a privilege boundary.
 * The audit log still records every call so the LLM's introspection can
 * be reconstructed post-hoc.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfgBool, feralHome } from "../../config.ts";
import type { Tool, ToolManifest } from "../../types.ts";
import type { ToolRegistry } from "../registry.ts";
import type { InferenceRouter } from "../../egress/inference-router.ts";

// ── Shared context ─────────────────────────────────────────────────────────
//
// Each tool gets a `SelfContext` (closure-captured) so they share the same
// router/registry/views without having to be re-instantiated. Reads of disk
// state go through small helpers (`readJsonSync`, `tailJsonl`) that swallow
// missing files — a substrate not present yet is a valid answer, not a
// crash.

export interface SelfContext {
  router: InferenceRouter;
  registry: ToolRegistry;
  /** Best-effort accessor for the broker/registry of connectors. The exact
   * type isn't depended on; only its `reload()` capability matters for
   * health checks. May be undefined in headless / test contexts. */
  connectors?: { reload(): Promise<void> } | null;
  /** Whether the agent loop has Brain Stack enabled. Drives `self_subsystem`
   * presence and `self_providers` Brain Stack vs. primary hint. */
  brainStackEnabled: boolean;
  /** Sidecar version — populated from package.json. Cached at construction. */
  version: string;
  /** When the sidecar booted (ms since epoch). */
  bootedAt: number;
}

/** Sync JSON read for hot paths (`self_status` callsite is latency-sensitive). */
function readJsonSync(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Last `n` lines of a (JSONL) file, parsed. Returns [] on a missing file. */
function tailJsonl(path: string, n: number): unknown[] {
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    return lines
      .slice(-Math.max(1, n))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((v): v is unknown => v !== null);
  } catch {
    return [];
  }
}

// ── Path constants (single source of truth) ───────────────────────────────

const RSI_ROOT = join(feralHome(), "rsi");
const P_CHAMPION = join(RSI_ROOT, "champion.json");
const P_POPULATION = join(RSI_ROOT, "population.json");
const P_DREAM = join(RSI_ROOT, "dream.jsonl");
const P_LORA = join(RSI_ROOT, "lora-registry.json");
const P_PENDING_PATCHES = join(RSI_ROOT, "pending-patches.json");
const P_MODULE_REGISTRY = join(RSI_ROOT, "modules", "registry.json");
const P_MODULE_HISTORY = join(RSI_ROOT, "modules", "registry_history.jsonl");
const P_POLICY = join(RSI_ROOT, "governance", "policy.json");
const P_META = join(RSI_ROOT, "meta_genome.json");
const P_META_HISTORY = join(RSI_ROOT, "meta_history.jsonl");
const P_MEMORY_GRAPH = join(feralHome(), "memory-graph.json");
const P_CONNECTORS = join(feralHome(), "connectors.json");
const P_LEAF_STORE = join(feralHome(), "fractal-leaves.json");

// ── Subsystem deep-dive catalog ───────────────────────────────────────────
//
// Per the user: not just "do I have X?" but "how does X work?". The catalog
// is hard-coded — the shape rarely changes and a runtime-rendered version
// would just hide the same knowledge one layer deeper. Cheap to update;
// always available; no schema drift to worry about.

interface SubsystemDoc {
  purpose: string;
  inputs: string[];
  outputs: string[];
  safety: string[];
  promotion: string;
  rollback: string;
  /** Optional: pointers to introspection tools that surface this subsystem
   * live. Hand-rolled so the catalog can evolve independently of the tools. */
  inspect: string[];
}

const SUBSYSTEMS: Record<string, SubsystemDoc> = {
  brsi: {
    purpose:
      "Bounded Reflective Self-Improvement — an evolution engine that optimises a small set of agent-config genomes against the agent's own evaluation corpus.",
    inputs: [
      "Genome population (`~/.feral/rsi/population.json`).",
      "Evolution journal (`~/.feral/rsi/journal/<date>.jsonl`).",
      "Tier 0/1 contract FSM results.",
      "Conversation feedback (acceptance / completion signals).",
    ],
    outputs: [
      "Updated champion (`~/.feral/rsi/champion.json`).",
      "Ratcheted commits in the git substrate.",
      "Taste-miner PBT vectors (`~/.feral/rsi/pbt_state.json`).",
    ],
    safety: [
      "Tier 0 capability gate (must not regress core fitness).",
      "Tier 1 contract gate (must not violate capability contracts).",
      "Confidence threshold per candidate.",
      "Human approval gate on promotion to `champion`.",
    ],
    promotion:
      "A candidate clears Tier 0 + Tier 1 with confidence above the tier threshold AND the user approves the promotion in the host UI. Only then does `champion.json` get rewritten and the agent loop pick the new params up at next session start.",
    rollback:
      "Automatic on Tier 0 regression detected during eval: the candidate is killed and the population falls back to the prior champion. The git substrate's ratchet bar makes accidental regressions impossible to commit — the bar must lift first.",
    inspect: ["self_describe", "self_genome", "self_subsystem"],
  },
  fms: {
    purpose:
      "Fractal Memory Search — a hierarchical, embeddable leaf-tree over captured conversation fragments. Captures are reactive (auto-extracted by the MemoryExtractor each turn); this subsystem owns the search side and the eviction/centroid refresh.",
    inputs: [
      "Per-turn conversation fragments (auto-captured).",
      "Embeddings from the local embedder (CPU bge-small today).",
      "Drift probes that decide when to re-cluster (centroid merge / split).",
    ],
    outputs: [
      "Ranked leaves for `recall` queries (leaf_id + text snippet + score).",
      "Centroid refresh into the active tree.",
      "Evicted summaries into `~/.feral/fractal-evicted.jsonl`.",
    ],
    safety: [
      "Read-only API — `recall` cannot write.",
      "Embedder falls back to FTS5 on missing model (no silent failure).",
      "Cross-session dedup keeps the leaf store from accumulating near-duplicates.",
    ],
    promotion:
      "N/A — FMS is a pure retrieval store; there is no champion to promote. New tiers (Layer 4+) get added by configuration changes in `tree-builder.ts`, not by evolution.",
    rollback:
      "The full leaf store is rebuildable from the source conversation transcripts via the migration runner (`runMigration`). Destructive operations are gated by explicit user invocation of `feral setup`, never by an autonomous agent.",
    inspect: ["self_describe", "self_memory", "recall"],
  },
  lora: {
    purpose:
      "Per-user LoRA personal-adaptation ladder. Trains adapters on a user's accepted completions and promotes them through the same BRSI ladder as config genomes, with champion-per-domain (general, coding, research, writing, planning).",
    inputs: [
      "User acceptance / completion signals (captured by the extractor).",
      "Per-domain dataset builder output (`datasetId`, `datasetHash`).",
      "Hyperparameters from the trainer backend (rank, alpha, lr, epochs).",
    ],
    outputs: [
      "Promoted adapter files (`*.gguf` under `~/.feral/rsi/envelopes/`).",
      "Registry entries (`~/.feral/rsi/lora-registry.json`) with full lineage back to genesis.",
    ],
    safety: [
      "Champion-per-domain isolation (a coding regression cannot retire the writing champion).",
      "Tier 0/1 contract FSM reused from BRSI.",
      "Human approval gate before promotion (`retired` → `champion`).",
      "Rollback-path preserved on every status transition.",
    ],
    promotion:
      "Candidate → eval → confidence → human approval → champion. Same ladder as BRSI; this subsystem mirrors it intentionally so the operator's mental model is one ladder, not two.",
    rollback:
      "Any retired champion is still on disk and loadable — a regression is a status flip back to `champion`, never a deletion. LoRA swap is mediated by the runtime so the live agent picks the swap up without a process restart.",
    inspect: ["self_describe", "self_lora", "self_subsystem"],
  },
  dreaming: {
    purpose:
      "Offline learning — the engine that periodically runs BRSI when the machine is otherwise idle. Triggered by idleness, schedule, budget-availability, or explicit user request.",
    inputs: [
      "A trigger (one of: idle | error | manual | schedule | user | threshold | budget_available).",
      "The current champion + population snapshot.",
      "Remaining budget (wall-clock, tokens, CPU, RAM, disk).",
    ],
    outputs: [
      "New candidate evaluated against Tier 0/1.",
      "Ratcheted commit in the substrate on accept.",
      "Per-episode summary in `~/.feral/rsi/dream.jsonl` (tokens, ratchets, errors, emptyResponses, resources).",
    ],
    safety: [
      "Hard wall-clock ceiling (FERAL_TOTAL_DEADLINE_MS).",
      "Hard token budget per cycle.",
      "Per-cycle eval gates (no candidate escapes Tier 0).",
      "Resource monitor can abort early on disk/RAM pressure.",
    ],
    promotion:
      "A dream that produces a candidate does not promote it on its own — it writes a journal row and waits for the BRSI ladder (manual or auto-eval) to evaluate.",
    rollback:
      "If a dream crashes mid-cycle the journal row goes in with `halt` action — the engine resumes from the last successful snapshot, never from a half-mutated state (atomic write of population.json).",
    inspect: ["self_describe", "self_dreams", "self_subsystem"],
  },
  genomes: {
    purpose:
      "The unit of BRSI evolution — a `GenomeConfig` is a vector of categorical indices (promptTemplateId, systemPromptId, retrievalStrategy) plus bounded reals (temperature, contextWindowUsage) and a simplex point of tool-preference weights.",
    inputs: [
      "Seeding (initial seeds from championSeed or strategy seeds).",
      "Mutation (per-generation crossover / mutation operators).",
      "Tier-specific extension layers (L0..L5).",
    ],
    outputs: [
      "A population of genomes indexed by id.",
      "A best-record (monotonic — never decreases).",
      "A Hall of Fame (extinction-immune ids).",
    ],
    safety: [
      "Niche threshold prevents behavioural-mode collapse.",
      "Hall-of-Fame auto-induction on best-record updates.",
      "Extinction handler with calving / adoption policy.",
    ],
    promotion:
      "A genome is `champion` when it is the live-agent-facing record in `champion.json`. That flip happens via the ratchet handler, which demotes the previous champion to retired rather than deleting.",
    rollback:
      "Each genome carries its lineage back to seed; the LCA adapter can reconstruct the divergence point of any two genomes. `restore()` on a `PopulationSnapshot` brings a fresh manager exactly to a prior state.",
    inspect: ["self_describe", "self_genome", "self_subsystem"],
  },
  connectors: {
    purpose:
      "The ConnectorManager → Connector → Token → Gateway → Session hierarchy that fans the agent's replies out to chat surfaces (Discord / Slack / WhatsApp) and back in. Each surface is an independent connector with its own allowlist, mode, and (optional) inline knowledge-base for the public responder.",
    inputs: [
      "Multi-tenant connector rows (`~/.feral/connectors.json`).",
      "Per-connector allowlist (channel / DM / group IDs).",
      "Per-connector mode (owner = full agent, public = constrained KB).",
    ],
    outputs: [
      "Active connector sockets (Discord gateway WS, Slack Socket Mode, WhatsApp Web session).",
      "Per-message `agent-output` events with conversation trace.",
      "Leads + escalations captured under `~/.feral/leads/`.",
    ],
    safety: [
      "Allowlist enforcement (channels + DM peers).",
      "Mode isolation (public never falls through to the full agent).",
      "LeadDesk gating for escalate / schedule / capture-lead.",
      "`connectors_reload` is the only mutating ingress.",
    ],
    promotion:
      "N/A — connectors do not evolve. They are reconciled against the config file by `ConnectorManager.reload()` which start/stop/restart each connector to match the desired state.",
    rollback:
      "A connector failure tears down its socket cleanly without affecting the other connectors (one surface dying must never kill the others). The manager's #reloading Promise serialises overlapping reloads so a user edit can't double-start a connection.",
    inspect: ["self_describe", "self_connectors"],
  },
  memory: {
    purpose:
      "The tiered memory substrate: working memory (per-session transcript), episodic (Fractal Memory Search), semantic (knowledge graph at `~/.feral/memory-graph.json`), and tool-state memories.",
    inputs: [
      "Conversation turns (auto-captured).",
      "Tool outputs (selectively remembered via extractor policy).",
      "User-curated notes / pinned facts.",
    ],
    outputs: [
      "Per-session working memory (compressed when over budget).",
      "Episodic leaves (FMS — see above).",
      "Knowledge graph nodes + edges.",
      "Cross-session anchors (named memories).",
    ],
    safety: [
      "Working-memory compression is bounded, never lossier than summary tokens reserved.",
      "Recall is opt-in (no wholesale recall each turn).",
      "Knowledge graph writes go through the agent's own tool lifecycle, not autonomous background appenders.",
    ],
    promotion:
      "Memories themselves do not promote — the route by which they come back into context does. Auto-injection is opt-in per memory kind; on-demand query goes through `recall`.",
    rollback:
      "Memory is append-only by default; destructive edits (deleting a fact, scrubbing a leaf) require explicit user action. The extractor is idempotent so a misbehaving run cannot corrupt the transcript.",
    inspect: ["self_describe", "self_memory", "recall"],
  },
  brain_stack: {
    purpose:
      "The Brain Stack — a per-turn task classifier + capability registry that picks the right model for the task (and the right backend). Opt-in; when enabled, it routes every turn through `route()` instead of the primary target.",
    inputs: [
      "Per-turn message + session context.",
      "Capability registry (model → capability scores).",
      "Health signals (per-model / per-backend).",
      "Cost budget state.",
    ],
    outputs: [
      "Chosen {primary, fallback} per turn.",
      "Per-turn audit log (category, confidence, chosen model, cost-relevant samples).",
    ],
    safety: [
      "Routing is policy-only — it can never widen the trusted-base-url set.",
      "Health signals can demote a sick model but cannot promote one the user has not configured.",
      "Cost budget is enforced locally (request is refused, not over-spent).",
    ],
    promotion:
      "Brain Stack tuning changes go through configuration, not through evolution. A future Layer (L5) of BRSI may evolve the routing weights, but the registry + classifier code paths themselves are human-edited.",
    rollback:
      "`brain.route()` is pure (no I/O), so a misbehaving routing is recoverable by configuration reload. Falls back to the primary target on any error.",
    inspect: ["self_describe", "self_providers"],
  },
  notebook: {
    purpose:
      "The RLM notebook — a long-lived JavaScript interpreter (`node:vm`) per session, with every other tool bound as an async function, so tool calls are composed as program logic instead of one per turn. Opt-in via FERAL_ENABLE_NOTEBOOK; absent entirely when off.",
    inputs: [
      "A cell of JavaScript from the model (`notebook` tool, `code` argument).",
      "The session's live tool registry — one injected function per registered tool, itself excluded.",
      "The previous snapshot for this session (`~/.feral/notebooks/<session>.json`), restored on first use.",
    ],
    outputs: [
      "The last expression's value plus anything logged, returned as the tool result.",
      "Variables and helper functions that persist across cells, turns and compaction.",
      "Background workers admitted by `rlm()`, collected via `rlm.list_subagents()` and the `notify_parent` inbox.",
    ],
    safety: [
      "No ambient authority: the vm context gets none of our builtins, so `Function` is unreachable and there is no `fetch`, `require` or `process`.",
      "Host objects and tool results are prototype-severed, closing the `.constructor.constructor` escape (regression-tested — those tests are load-bearing).",
      "Every capability still goes through ToolRegistry, so the egress proxy, audit log and process sandbox apply exactly as they do to a normal tool call.",
      "Workers default to the same read-only tool set as delegate_task; recursion is capped at depth 1, so a child cannot spawn its own.",
      "A hardened vm, NOT a jail against an adversary who controls the source — the threat model is careless model-written code.",
    ],
    promotion:
      "Human decision, not evolution: the notebook is off unless FERAL_ENABLE_NOTEBOOK is set. Nothing promotes it automatically.",
    rollback:
      "Unset FERAL_ENABLE_NOTEBOOK and the tool is never registered; the agent loop, BRSI and FMS are untouched by its absence. Per-session state is a plain JSON file that can be deleted.",
    inspect: ["self_describe", "self_subsystem"],
  },
  rsi: {
    purpose:
      "The parent substrate that owns BRSI's on-disk state — the single " +
      "source of truth for `~/.feral/rsi/*`. Every BRSI/LORA/Genome " +
      "operation touches this directory; dreaming + journaling + the " +
      "audit log live here.",
    inputs: [
      "Tier 0/1 contract FSM signals.",
      "User pin / recall / rollback requests.",
      "Budget notifications from the resource monitor.",
    ],
    outputs: [
      "Champion, population, LoRA registry, journal, dream log, PBT vectors — all persisted atomically.",
      "Substrate commits (ratcheted wins only).",
    ],
    safety: [
      "Atomic writes (temp + rename) on every snapshot.",
      "Best-effort appends on telemetry/journal (one lost row beats an aborted $20 dream).",
      "Git substrate is the ratchet bar — main only ratchets upward.",
    ],
    promotion:
      "Per-layer. The ladder is L1 config (`brsi`/`genomes`) → L2 adapters " +
      "(`lora`) → L3 code (`code`) → L4 architecture (`modules`) → L5 policy " +
      "(`governance`) → L6 meta (`meta`). There is no L0: `Tier 0` is the " +
      "frozen eval floor every layer's promotion must clear, not a rung. " +
      "Every layer answers to the L5 policy for its gate thresholds.",
    rollback:
      "Snapshot-based. `PopulationSnapshot.restore()` brings a fresh " +
      "manager exactly to a prior state; the git substrate's reflog " +
      "is the final safety net.",
    inspect: ["self_describe", "self_health", "self_subsystem"],
  },
  code: {
    purpose:
      "L3 — code-RSI. The agent proposes unified diffs against its OWN source " +
      "tree, evaluates them, and (only through an approval gate) lands them. " +
      "This is the layer where Cinderpaw rewrites its own code rather than just " +
      "its config (L1) or its weights (L2).",
    inputs: [
      "Code leaves + a proposer prompt (the candidate diff).",
      "The TS wall (parse + policy): what a patch is allowed to touch.",
      "Tier 0 / contract FSM results from the sandboxed run.",
    ],
    outputs: [
      "`~/.feral/rsi/pending-patches.json` — every candidate diff and its status (pending → approved/rejected → applied/apply_failed/reverted).",
      "Substrate commits for candidates that won the ratchet.",
    ],
    safety: [
      "A winning patch is NOT applied to live source — it lands as a pending patch and crosses over only via `applyPatchLive`.",
      "The first 10 applied patches REQUIRE an explicit human approval; auto-approve unlocks only after that.",
      "The TS wall is re-checked at apply time, not just at proposal — a wall tightened in between still bites.",
      "The running sidecar is a compiled binary: an applied patch becomes the running agent only at the next rebuild + restart. The process never mutates itself.",
      "`pending-patches.ts` is on both patch denylists — the gate cannot patch the gate.",
    ],
    promotion:
      "Ratchet on the Rust composite score, then the human approval gate, then " +
      "a fresh wall re-check at apply.",
    rollback:
      "`revertPatchLive` — `git apply -R` of the exact same patch text.",
    inspect: ["self_describe", "self_health", "self_status"],
  },
  modules: {
    purpose:
      "L4 — architecture evolution. The runtime exposes a fixed catalog of " +
      "`seams` (swappable interfaces: retrieval, planning, ...). A module is " +
      "a candidate implementation of ONE seam, written by a dream episode or " +
      "an operator, that can be promoted to serve that seam live. Every seam " +
      "always has a builtin fallback, so a module is additive, never load-bearing.",
    inputs: [
      "Candidate module dirs (`~/.feral/rsi/modules/<id>/` — manifest.json + a single .ts entry).",
      "The seam catalog (compiled in; a module targeting an unknown seam is rejected).",
      "L5 gate thresholds — a module promotes only if it beats the builtin by the policy's margin.",
    ],
    outputs: [
      "`modules/registry.json` — which impl serves each seam (`builtin` or a module id).",
      "`modules/registry_history.jsonl` — every lifecycle transition and active-repoint.",
    ],
    safety: [
      "Modules run in a separate module-host process with a timeout + RSS cap (the module wall).",
      "v1 manifests MUST declare zero permissions and zero deps — no fs, no net, no env.",
      "A module that crashes, times out, or exceeds its RSS cap is QUARANTINED and the seam falls back to builtin within the same call.",
      "The capability claims in a manifest are a human hint on the approval card and are NEVER machine-read — routing and promotion ignore them entirely (the two-channel rule).",
    ],
    promotion:
      "Paired eval against the builtin on the same tasks; must clear the L5 " +
      "gates (confidence + margin) before the registry repoints the seam.",
    rollback:
      "Repoint the seam's `active` back to `builtin` — one registry write. " +
      "Quarantine does this automatically on a wall breach.",
    inspect: ["self_describe", "self_health", "self_status"],
  },
  governance: {
    purpose:
      "L5 — the policy that governs every promotion in the system (L1 configs, " +
      "L2 LoRAs, L4 modules, L6 meta-genomes). It is the single place where " +
      "'how strict is the bar?' is answered. Cinderpaw evolves the policy too, but " +
      "only in the tightening direction without a human.",
    inputs: [
      "The genesis policy (bootstrapped on first boot).",
      "Policy proposals from dream episodes.",
      "Operator approval records (required for any loosening).",
    ],
    outputs: [
      "`governance/policy.json` — the active policy: gates, budgets, frozen flags, approvals.",
      "`governance/policy_history.jsonl` — hash-chained; the history is the authority, not the file.",
    ],
    safety: [
      "FAIL-CLOSED: a missing, unparseable, or unsigned policy means NOTHING may promote — it does not fall back to permissive defaults.",
      "A corrupt policy is moved aside as `policy.json.quarantine-<ts>`, never silently repaired.",
      "Tightening auto-adopts; loosening requires a human approval record.",
      "G0 walls are hardcoded ceilings a policy cannot exceed no matter what it claims.",
      "Frozen flags mark gates the policy may never touch.",
    ],
    promotion:
      "History row is appended FIRST, then policy.json is written temp+rename — " +
      "a crash mid-activation is recoverable because history is the authority.",
    rollback:
      "Rewrite policy.json from the last activated history row (done automatically " +
      "on boot if the two diverge).",
    inspect: ["self_describe", "self_health", "self_status"],
  },
  meta: {
    purpose:
      "L6 — meta-evolution. Evolves the knobs that L1 evolution ITSELF runs " +
      "under (mutation rate, exploration, confidence gate, dream batch size, " +
      "selection pressure), scored on journal-derived fitness across an epoch. " +
      "This is Cinderpaw tuning its own learning process.",
    inputs: [
      "The evolution journal over the epoch window (hash-verified; a corrupt day is excluded, not trusted).",
      "The L5 policy — bounds the meta-genome's legal range.",
    ],
    outputs: [
      "`rsi/meta_genome.json` — the live meta-genome + generation + baseline.",
      "`rsi/meta_history.jsonl` — every generation, mirrored into the L5 chained audit log.",
    ],
    safety: [
      "META_BOUNDS clamps every knob; the confidence gate is TIGHTEN-ONLY (it can never be relaxed below the locked strict gate).",
      "Epoch ratchet: a new meta-genome deploys only if it beats the baseline over a full epoch.",
      "Journal rows that fail hash verification are excluded from the fitness window.",
    ],
    promotion:
      "Epoch ratchet on journal-derived fitness vs. the recorded baseline.",
    rollback:
      "Revert to the previous generation's genome from meta_history.jsonl; a " +
      "missing/corrupt state file recovers to neutral defaults (every ratio = 1.0).",
    inspect: ["self_describe", "self_health", "self_status"],
  },
};

// ── Shape helpers ─────────────────────────────────────────────────────────

interface ConnectorShape {
  id: string;
  enabled: boolean;
  /** Whether a connector instance is actually started (config enabled + token present). */
  active: boolean;
  mode?: string;
  allowlist_count: number;
  channels_count: number;
  /** Which secret keys the row declared, never the values. */
  secret_fields: string[];
}

/** Override hooks let tests inject a temp dir; production callers pass
 *  no argument and the helpers resolve the real `~/.feral/...` paths. */
interface ShapePaths {
  connectors?: string;
  lora?: string;
  champion?: string;
  population?: string;
  dream?: string;
  leafStore?: string;
  memoryGraph?: string;
}

const DEFAULT_PATHS: Required<ShapePaths> = {
  connectors: P_CONNECTORS,
  lora: P_LORA,
  champion: P_CHAMPION,
  population: P_POPULATION,
  dream: P_DREAM,
  leafStore: P_LEAF_STORE,
  memoryGraph: P_MEMORY_GRAPH,
};

function shapeConnectors(paths: ShapePaths = {}): ConnectorShape[] {
  type Row = {
    id: string;
    enabled?: boolean;
    secrets?: Record<string, string>;
    allowlist?: string[];
    channels?: string[];
    mode?: string;
    token?: string;
  };
  const parsed = readJsonSync(paths.connectors ?? DEFAULT_PATHS.connectors) as { connectors?: Row[] } | null;
  if (!parsed || !Array.isArray(parsed.connectors)) return [];
  return parsed.connectors
    .filter((r): r is Row => !!r && typeof r === "object" && typeof r.id === "string")
    .map((r): ConnectorShape => {
      const hasSecrets = r.secrets && Object.values(r.secrets).some((v) => !!String(v).trim());
      const hasLegacyToken = !!r.token?.trim();
      const active = !!r.enabled && (hasSecrets || hasLegacyToken);
      return {
        id: r.id,
        enabled: !!r.enabled,
        active,
        mode: r.mode,
        allowlist_count: r.allowlist?.length ?? 0,
        channels_count: r.channels?.length ?? 0,
        secret_fields: Object.keys(r.secrets ?? {}),
      };
    });
}

interface LoRAShape {
  active_path: string | null;
  by_domain: Record<string, { champion: string | null; candidates: number; retired: number }>;
  total: number;
}

function shapeLora(paths: ShapePaths = {}): LoRAShape {
  type Envelope = {
    version: 1;
    adapters: Array<{
      id: string;
      domain: string;
      status: string;
      adapterPath: string;
    }>;
  };
  const env = readJsonSync(paths.lora ?? DEFAULT_PATHS.lora) as Envelope | null;
  const activePath = env?.adapters?.find((a) => a.status === "champion")?.adapterPath ?? null;
  const by_domain: LoRAShape["by_domain"] = {};
  for (const a of env?.adapters ?? []) {
    const d = (by_domain[a.domain] ??= { champion: null, candidates: 0, retired: 0 });
    if (a.status === "champion") d.champion = a.id;
    else if (a.status === "candidate" || a.status === "evaluating") d.candidates++;
    else d.retired++;
  }
  return { active_path: activePath, by_domain, total: env?.adapters?.length ?? 0 };
}

interface ChampionShape {
  genomeId: string;
  score: number;
  config: Record<string, unknown>;
  updatedAt: number;
}

function shapeChampion(paths: ShapePaths = {}): ChampionShape | null {
  type RecordShape = { genomeId: string; score: number; config: Record<string, unknown>; updatedAt: number };
  const r = readJsonSync(paths.champion ?? DEFAULT_PATHS.champion) as RecordShape | null;
  if (!r || typeof r.genomeId !== "string") return null;
  return r;
}

interface PopulationShape {
  alive: number;
  dead: number;
  best_score: number | null;
  best_genome: string | null;
  hall_of_fame: number;
  concurrency: number;
  niche_threshold: number;
}

function shapePopulation(paths: ShapePaths = {}): PopulationShape | null {
  type Snapshot = {
    version: 1;
    concurrency: number;
    nicheThreshold: number;
    genomes: Array<{ id: string; alive: boolean; fitnessScore: number | null }>;
    bestRecord: { genomeId: string; score: number } | null;
    hallOfFameIds: string[];
  };
  const snap = readJsonSync(paths.population ?? DEFAULT_PATHS.population) as Snapshot | null;
  if (!snap || !Array.isArray(snap.genomes)) return null;
  let alive = 0,
    dead = 0;
  for (const g of snap.genomes) (g.alive ? alive++ : dead++);
  return {
    alive,
    dead,
    best_score: snap.bestRecord?.score ?? null,
    best_genome: snap.bestRecord?.genomeId ?? null,
    hall_of_fame: snap.hallOfFameIds?.length ?? 0,
    concurrency: snap.concurrency ?? 1,
    niche_threshold: snap.nicheThreshold ?? 0.85,
  };
}

interface DreamShape {
  last_episode: null | {
    startedAt: number;
    endedAt: number;
    trigger: string;
    iterations: number;
    tokens: number;
    ratchets: number;
    stopReason: string;
    emptyResponses: number;
    errors: number;
    durationMin: number;
  };
  total_episodes: number;
}

function shapeDreams(n: number = 5, paths: ShapePaths = {}): DreamShape {
  const lines = tailJsonl(paths.dream ?? DEFAULT_PATHS.dream, Math.max(50, n));
  const total = lines.length;
  const last = lines.at(-1) as
    | {
        startedAt: number;
        endedAt: number;
        trigger: string;
        iterations: number;
        tokens: number;
        ratchets: number;
        stopReason: string;
        emptyResponses?: number;
        errors?: string[];
      }
    | undefined;
  if (!last) return { last_episode: null, total_episodes: total };
  return {
    last_episode: {
      startedAt: last.startedAt,
      endedAt: last.endedAt,
      trigger: last.trigger,
      iterations: last.iterations,
      tokens: last.tokens,
      ratchets: last.ratchets,
      stopReason: last.stopReason,
      emptyResponses: last.emptyResponses ?? 0,
      errors: last.errors?.length ?? 0,
      durationMin: Math.max(0, Math.round((last.endedAt - last.startedAt) / 60000)),
    },
    total_episodes: total,
  };
}

interface MemoryShape {
  leaf_store_exists: boolean;
  leaf_store_bytes: number;
  graph_exists: boolean;
  graph_nodes_hint: number | null;
  estimators: { leaf_count_estimate: number };
}

function shapeMemory(paths: ShapePaths = {}): MemoryShape {
  const leafPath = paths.leafStore ?? DEFAULT_PATHS.leafStore;
  let leafExists = false;
  let leafBytes = 0;
  try {
    if (existsSync(leafPath)) {
      leafExists = true;
      leafBytes = statSync(leafPath).size;
    }
  } catch {
    // stat may throw on permission errors; swallow.
  }
  let graphExists = false;
  let graphNodesHint: number | null = null;
  const g = readJsonSync(paths.memoryGraph ?? DEFAULT_PATHS.memoryGraph) as { nodes?: unknown[] } | null;
  if (g && Array.isArray(g.nodes)) {
    graphExists = true;
    graphNodesHint = g.nodes.length;
  }
  // Rough rule of thumb: each leaf averages ~480 bytes on disk. For a
  // real number we'd read the summary; ~480 is good enough for a heartbeat.
  const leafEstimate = leafExists ? Math.max(0, Math.round(leafBytes / 480)) : 0;
  return {
    leaf_store_exists: leafExists,
    leaf_store_bytes: leafBytes,
    graph_exists: graphExists,
    graph_nodes_hint: graphNodesHint,
    estimators: { leaf_count_estimate: leafEstimate },
  };
}

/** L3 — code-RSI: patches the agent proposed for its own source, and where
 *  each one sits in the approval gate. */
function shapeCode(): {
  patches: Record<string, number>;
  total: number;
  pending_approval: number;
  applied: number;
  store_path: string;
} {
  const store = readJsonSync(P_PENDING_PATCHES) as { patches?: { status?: string }[] } | null;
  const rows = Array.isArray(store?.patches) ? store.patches : [];
  const byStatus: Record<string, number> = {};
  for (const p of rows) {
    const s = typeof p?.status === "string" ? p.status : "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return {
    patches: byStatus,
    total: rows.length,
    pending_approval: byStatus.pending ?? 0,
    applied: byStatus.applied ?? 0,
    store_path: P_PENDING_PATCHES,
  };
}

/** L4 — module registry: which seams are served by a promoted module vs the
 *  builtin, and how many candidates are queued behind each. */
function shapeModules(): {
  seams: { seam: string; active: string; is_builtin: boolean; candidates: number }[];
  promoted: number;
  quarantined: string[];
  registry_path: string;
} {
  const reg = readJsonSync(P_MODULE_REGISTRY) as
    | { seams?: Record<string, { active?: string; candidates?: string[] }> }
    | null;
  const seams = Object.entries(reg?.seams ?? {}).map(([seam, e]) => {
    const active = typeof e?.active === "string" ? e.active : "builtin";
    return {
      seam,
      active,
      is_builtin: active === "builtin",
      candidates: Array.isArray(e?.candidates) ? e.candidates.length : 0,
    };
  });
  // Quarantines are lifecycle rows in the history; the last state per module wins.
  const state = new Map<string, string>();
  for (const row of tailJsonl(P_MODULE_HISTORY, 500) as { moduleId?: string; to?: string }[]) {
    if (typeof row?.moduleId === "string" && typeof row.to === "string") state.set(row.moduleId, row.to);
  }
  return {
    seams,
    promoted: seams.filter((s) => !s.is_builtin).length,
    quarantined: [...state].filter(([, s]) => s === "quarantined").map(([id]) => id),
    registry_path: P_MODULE_REGISTRY,
  };
}

/** L5 — the active governance policy. Gates/budgets only; the approval record
 *  can carry operator identity, so it is reduced to a boolean. */
function shapeGovernance(): {
  active: boolean;
  policy_id: string | null;
  parent_id: string | null;
  activated_at: number | null;
  auto_adopted: boolean | null;
  gates: unknown;
  budgets: unknown;
  frozen: unknown;
  policy_path: string;
} {
  const p = readJsonSync(P_POLICY) as Record<string, unknown> | null;
  return {
    active: p !== null,
    policy_id: typeof p?.policyId === "string" ? p.policyId : null,
    parent_id: typeof p?.parentId === "string" ? p.parentId : null,
    activated_at: typeof p?.activatedAt === "number" ? p.activatedAt : null,
    auto_adopted: p ? p.approval === null : null,
    gates: p?.gates ?? null,
    budgets: p?.budgets ?? null,
    frozen: p?.frozen ?? null,
    policy_path: P_POLICY,
  };
}

/** L6 — the live meta-genome: the knobs L1 evolution itself runs under. */
function shapeMeta(): {
  active: boolean;
  generation: number | null;
  genome: unknown;
  deployed_at: number | null;
  baseline: unknown;
  generations_logged: number;
  state_path: string;
} {
  const s = readJsonSync(P_META) as Record<string, unknown> | null;
  return {
    active: s !== null,
    generation: typeof s?.generation === "number" ? s.generation : null,
    genome: s?.genome ?? null,
    deployed_at: typeof s?.deployedAt === "number" ? s.deployedAt : null,
    baseline: s?.baseline ?? null,
    generations_logged: tailJsonl(P_META_HISTORY, 10_000).length,
    state_path: P_META,
  };
}

interface SubsystemHealth {
  available: boolean;
  detail?: string;
}

function healthCode(): SubsystemHealth {
  const c = shapeCode();
  if (c.total === 0) return { available: false, detail: "no code patches proposed yet" };
  return {
    available: true,
    detail: `${c.total} patch(es): ${c.pending_approval} awaiting approval, ${c.applied} applied`,
  };
}

function healthModules(): SubsystemHealth {
  const m = shapeModules();
  if (m.seams.length === 0) return { available: false, detail: "no module registry yet — every seam runs its builtin" };
  const q = m.quarantined.length ? `, ${m.quarantined.length} quarantined` : "";
  return {
    available: true,
    detail: `${m.seams.length} seam(s), ${m.promoted} served by a promoted module${q}`,
  };
}

function healthGovernance(): SubsystemHealth {
  const g = shapeGovernance();
  return g.active
    ? { available: true, detail: `policy ${g.policy_id} active${g.auto_adopted ? " (auto-adopted)" : " (operator-approved)"}` }
    : { available: false, detail: "no policy.json — governance is FAIL-CLOSED (nothing may promote)" };
}

function healthMeta(): SubsystemHealth {
  const m = shapeMeta();
  return m.active
    ? { available: true, detail: `generation ${m.generation}, ${m.generations_logged} logged` }
    : { available: false, detail: "no meta-genome yet — L1 runs on neutral defaults" };
}

function healthConnectors(paths: ShapePaths = {}): SubsystemHealth {
  const rows = shapeConnectors(paths);
  if (rows.length === 0) return { available: true, detail: "no connectors configured" };
  const enabled = rows.filter((r) => r.enabled).length;
  return {
    available: true,
    detail: `${rows.length} configured (${enabled} enabled, ${rows.filter((r) => r.active).length} active)`,
  };
}

function healthLora(paths: ShapePaths = {}): SubsystemHealth {
  const env = readJsonSync(paths.lora ?? DEFAULT_PATHS.lora) as { version: number; adapters: unknown[] } | null;
  if (!env) return { available: false, detail: "no LoRA registry on disk yet" };
  return { available: true, detail: `registry v${env.version}, ${env.adapters.length} adapter(s)` };
}

function healthChampion(paths: ShapePaths = {}): SubsystemHealth {
  const c = shapeChampion(paths);
  return c
    ? { available: true, detail: `champion ${c.genomeId} @ score ${c.score}` }
    : { available: false, detail: "no champion written yet — BRSI hasn't promoted" };
}

function healthPopulation(paths: ShapePaths = {}): SubsystemHealth {
  const p = shapePopulation(paths);
  return p
    ? {
        available: true,
        detail: `${p.alive} alive, ${p.dead} dead, best ${p.best_score ?? "—"}`,
      }
    : { available: false, detail: "no population snapshot persisted yet" };
}

function healthDreams(paths: ShapePaths = {}): SubsystemHealth {
  const d = shapeDreams(1, paths);
  return d.last_episode
    ? {
        available: true,
        detail: `${d.total_episodes} episode(s) on disk; last ${d.last_episode.trigger} ${d.last_episode.durationMin}m`,
      }
    : { available: false, detail: "no dream episodes logged" };
}

/**
 * The notebook is opt-in and off by default, so "no state on disk" is the
 * normal, correct condition rather than a fault. `available` therefore means
 * "nothing is wrong here" and the detail line carries the truth — reporting a
 * `·` for a subsystem the user deliberately left off would flip the whole
 * diagnostic's banner to "some subsystems not yet persisted" on every install
 * that never wanted a notebook, which is how a health check stops being read.
 */
function healthNotebook(): SubsystemHealth {
  if (!cfgBool("FERAL_ENABLE_NOTEBOOK")) {
    return { available: true, detail: "disabled (FERAL_ENABLE_NOTEBOOK unset)" };
  }
  let snapshots = 0;
  try {
    snapshots = readdirSync(join(feralHome(), "notebooks")).filter((f) => f.endsWith(".json")).length;
  } catch {
    // No directory yet: enabled but never used. Not a fault either.
  }
  return { available: true, detail: `enabled; ${snapshots} session snapshot(s) on disk` };
}

function healthConnectorsMgr(ctx: SelfContext): SubsystemHealth {
  if (!ctx.connectors) return { available: false, detail: "ConnectorManager not in scope (headless?)" };
  return { available: true, detail: "ConnectorManager live; reload() is the only mutating entry point" };
}

// ── Tool factories ────────────────────────────────────────────────────────

function makeSelfDescribe(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_describe",
    description:
      "Return the full runtime identity document: version, model, providers, " +
      "connectors, BRSI champion, LoRA adapters, dream log summary, memory " +
      "stats, available tools, and per-subsystem introspect pointers. " +
      "One call when the user asks anything broad about the runtime.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const tools = ctx.registry.list().map((t) => t.manifest.name).sort();
      const primary = ctx.router.currentModel;
      const runtime = buildRuntimeSnapshot(ctx, primary);
      const subsystems = Object.fromEntries(
        Object.entries(SUBSYSTEMS).map(([k, v]) => [k, summariseSubsystem(v)]),
      );
      const document = {
        runtime,
        providers: {
          primary: { provider: primary.provider, model: primary.model, base_url: primary.baseUrl },
          cloud_reachable: ctx.router.cloudReachable,
        },
        connectors: shapeConnectors(),
        memory: shapeMemory(),
        brsi: {
          champion: shapeChampion(),
          population: shapePopulation(),
        },
        lora: shapeLora(),
        dreaming: shapeDreams(5),
        code: shapeCode(),
        modules: shapeModules(),
        governance: shapeGovernance(),
        meta: shapeMeta(),
        subsystems,
        tools,
        brain_stack_enabled: ctx.brainStackEnabled,
      };
      return {
        ok: true,
        content: JSON.stringify(document, null, 2),
        data: document,
      };
    },
  };
}

function makeSelfStatus(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_status",
    description:
      "Cheap one-line heartbeat per subsystem. Use this when the user " +
      "asks 'how is X going?' and you want a quick read without the full " +
      "document. Returns: model, champion, population, last dream, LoRA " +
      "champion, connectors, memory.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const lines: string[] = [];
      const primary = ctx.router.currentModel;
      lines.push(`runtime     : v${ctx.version}, booted ${new Date(ctx.bootedAt).toISOString()}`);
      lines.push(`model       : ${primary.provider}/${primary.model} @ ${primary.baseUrl}`);
      const c = shapeChampion();
      lines.push(
        `champion    : ${c ? `${c.genomeId} (score ${c.score}, updated ${new Date(c.updatedAt).toISOString()})` : "—"}`,
      );
      const p = shapePopulation();
      lines.push(
        `population  : ${p ? `${p.alive} alive, ${p.dead} dead, best ${p.best_score ?? "—"}` : "—"}`,
      );
      const d = shapeDreams(1);
      lines.push(
        `last dream  : ${d.last_episode ? `${d.last_episode.trigger} ${d.last_episode.durationMin}m, ${d.last_episode.iterations} iter, ${d.last_episode.ratchets} ratchet(es)` : "—"} (${d.total_episodes} total)`,
      );
      const l = shapeLora();
      lines.push(
        `lora        : ${l.total} adapter(s)${l.active_path ? `; active ${l.active_path}` : ""}`,
      );
      const code = shapeCode();
      lines.push(
        `code        : ${code.total} patch(es), ${code.pending_approval} awaiting approval, ${code.applied} applied`,
      );
      const mods = shapeModules();
      lines.push(
        `modules     : ${mods.seams.length} seam(s), ${mods.promoted} promoted${mods.quarantined.length ? `, ${mods.quarantined.length} quarantined` : ""}`,
      );
      const gov = shapeGovernance();
      lines.push(
        `governance  : ${gov.active ? `policy ${gov.policy_id}` : "no policy — FAIL-CLOSED"}`,
      );
      const meta = shapeMeta();
      lines.push(
        `meta        : ${meta.active ? `generation ${meta.generation}` : "neutral defaults (no meta-genome yet)"}`,
      );
      const conns = shapeConnectors();
      lines.push(
        `connectors  : ${conns.length} configured (${conns.filter((r) => r.active).length} active)`,
      );
      const m = shapeMemory();
      lines.push(
        `memory      : leaves ${m.estimators.leaf_count_estimate}; graph ${m.graph_exists ? `yes (${m.graph_nodes_hint} nodes)` : "no"}`,
      );
      return { ok: true, content: lines.join("\n"), data: { lines } };
    },
  };
}

function makeSelfRuntime(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_runtime",
    description:
      "Runtime identity: version, boot time, operating mode (gateway vs. " +
      "desktop), active model, base URL, brain-stack enabled, available " +
      "tool count. Static for the lifetime of the process.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const primary = ctx.router.currentModel;
      return {
        ok: true,
        content: JSON.stringify(buildRuntimeSnapshot(ctx, primary), null, 2),
        data: buildRuntimeSnapshot(ctx, primary),
      };
    },
  };
}

function makeSelfTools(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_tools",
    description:
      "List the tools currently exposed to this agent. Returns a compact " +
      "table of `name — description` rows. Use when the user asks what the " +
      "agent can do or what tools are available.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      query: {
        type: "string",
        description:
          "Optional filter — only tools whose name or description contains this substring (case-insensitive).",
        required: false,
      },
    },
    async execute(args) {
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const rows = ctx.registry
        .list()
        .map((t) => `- \`${t.manifest.name}\` — ${t.manifest.description}`)
        .filter((row) => !q || row.toLowerCase().includes(q))
        .sort();
      if (rows.length === 0) {
        return { ok: true, content: q ? `No tools match "${q}".` : "No tools registered." };
      }
      return {
        ok: true,
        content: `Available tools (${rows.length}):\n${rows.join("\n")}`,
        data: { count: rows.length, query: q || null },
      };
    },
  };
}

function makeSelfProviders(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_providers",
    description:
      "Configured inference providers. Returns the active primary and " +
      "fallback targets with provider/model/base_url (no API keys). When " +
      "Brain Stack is on, also returns `cloud_reachable` and a hint about " +
      "the policy engine.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const primary = ctx.router.currentModel;
      const out = {
        primary: { provider: primary.provider, model: primary.model, base_url: primary.baseUrl },
        fallback: readFallbackProvider(ctx),
        cloud_reachable: ctx.router.cloudReachable,
        brain_stack_enabled: ctx.brainStackEnabled,
        note:
          "Trust set is enforced by the router; an api key may be configured " +
          "but is never surfaced through this tool.",
      };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfMemory(_ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_memory",
    description:
      "Memory substrate stats. Returns Fractal Memory leaf-store size " +
      "(bytes + leaf-count estimate), knowledge-graph presence + node " +
      "count, and the location of each file. Use when the user asks " +
      "what is remembered, how big the corpus is, or how to inspect a " +
      "specific memory.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const m = shapeMemory();
      const out = {
        ...m,
        leaf_store_path: P_LEAF_STORE,
        knowledge_graph_path: P_MEMORY_GRAPH,
        fractal_recall: "use the `recall` tool to query the leaf store semantically",
      };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfConnectors(_ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_connectors",
    description:
      "Active connectors, without secrets. Returns id, enabled, active, " +
      "mode (owner/public), allowlist and channels counts, and which " +
      "secret fields the row declared (never the values). Use when the " +
      "user asks which chat surfaces are wired up.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const rows = shapeConnectors();
      const out = { configured: rows, config_path: P_CONNECTORS };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfGenome(_ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_genome",
    description:
      "Genome population summary: alive/dead counts, best score, best " +
      "genome id, Hall of Fame size, concurrency + niche threshold. Use " +
      "when the user asks about BRSI's current population or wants to " +
      "see how the evolution is going.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const p = shapePopulation();
      const out = { population: p, snapshot_path: P_POPULATION, champion: shapeChampion() };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfDreams(_ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_dreams",
    description:
      "Dream cycle status. Returns the last episode (trigger, duration, " +
      "iterations, tokens, ratchets, errors) and the total episode count. " +
      "Use when the user asks about dreaming, offline learning, or " +
      "whether anything has been evolving.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      n: {
        type: "number",
        description: "How many of the most recent episodes to include (default 5, max 50).",
        required: false,
      },
    },
    async execute(args) {
      let n = 5;
      if (typeof args.n === "number" && Number.isFinite(args.n)) {
        n = Math.max(1, Math.min(50, Math.floor(args.n)));
      }
      const last = shapeDreams(n);
      const out = { ...last, recent: tailJsonl(P_DREAM, n), log_path: P_DREAM };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfLora(_ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_lora",
    description:
      "LoRA registry summary. Per-domain champion id (or null), candidate " +
      "and retired counts, the currently active adapter path, and the " +
      "registry path on disk. Use when the user asks about personal " +
      "adapters or which LoRA is loaded for which domain.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const out = { ...shapeLora(), registry_path: P_LORA };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfHealth(ctx: SelfContext): Tool {
  const manifest: ToolManifest = {
    name: "self_health",
    description:
      "Subsystem availability diagnostic. For each subsystem (champion, " +
      "population, dreams, LoRA, connectors), returns whether its " +
      "persisted state is present, with a one-line detail. Use when " +
      "something 'isn't working' — narrows the search to the broken piece.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const health = {
        champion: healthChampion(),
        population: healthPopulation(),
        dreams: healthDreams(),
        lora: healthLora(),
        code: healthCode(),
        modules: healthModules(),
        governance: healthGovernance(),
        meta: healthMeta(),
        connectors: healthConnectors(),
        connectors_manager: healthConnectorsMgr(ctx),
        notebook: healthNotebook(),
        memory: {
          available: shapeMemory().leaf_store_exists || shapeMemory().graph_exists,
          detail: `leaves ${shapeMemory().estimators.leaf_count_estimate}; graph ${shapeMemory().graph_exists ? "yes" : "no"}`,
        },
      };
      const allOk = Object.values(health).every((s) => s.available);
      const lines = Object.entries(health).map(
        ([k, v]) => `${allOk ? "✓" : v.available ? "✓" : "·"} ${k.padEnd(18)} : ${v.detail ?? "—"}`,
      );
      lines.unshift(
        allOk
          ? "all subsystems present"
          : "some subsystems not yet persisted (this is normal on a fresh install)",
      );
      return {
        ok: true,
        content: lines.join("\n"),
        data: { health, all_present: allOk },
      };
    },
  };
}

function makeSelfProgress(): Tool {
  const manifest: ToolManifest = {
    name: "self_progress",
    description:
      "Longitudinal self-improvement telemetry: per-day dream-cycle counts, " +
      "accept/reject/halt split, mean candidate score, and the overall " +
      "trend (is the evolution actually climbing?). This is the evidence " +
      "curve behind 'the agent that builds itself'. Use when the user asks " +
      "whether Cinderpaw is improving over time or wants the RSI progress plot.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      days: {
        type: "number",
        description: "How many past days to aggregate (default 30, max 365).",
        required: false,
      },
    },
    async execute(args) {
      const days =
        typeof args.days === "number" && Number.isFinite(args.days)
          ? Math.max(1, Math.min(365, Math.floor(args.days)))
          : 30;
      const { improvementSeries } = await import("../../rsi/infra/progress.ts");
      const series = improvementSeries(join(RSI_ROOT, "journal"), days);
      const out = {
        ...series,
        champion: shapeChampion(),
        journal_dir: join(RSI_ROOT, "journal"),
        note:
          series.aggregateTrend === null
            ? "Not enough measured days yet for a trend — the curve needs at least 2 active days."
            : series.aggregateTrend >= 0
              ? "Mean candidate score is flat-to-rising across the window."
              : "Mean candidate score fell across the window — worth inspecting recent journal rows.",
      };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

function makeSelfSubsystem(): Tool {
  const manifest: ToolManifest = {
    name: "self_subsystem",
    description:
      "Deep dive on a specific subsystem. Pass one of: brsi, fms, lora, " +
      "dreaming, genomes, connectors, memory, brain_stack, rsi. Returns a " +
      "structured doc: Purpose, Inputs, Outputs, Safety, Promotion, " +
      "Rollback, and which self.* tools surface it live.",
    permissions: [],
    networkAccess: false,
  };
  const SUBSYSTEM_NAMES = Object.keys(SUBSYSTEMS);
  return {
    manifest,
    parameters: {
      name: {
        type: "string",
        description:
          `One of: ${SUBSYSTEM_NAMES.join(", ")}. ` +
          "Pass `list` to enumerate the available subsystems.",
        required: true,
      },
    },
    async execute(args) {
      const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      if (!name) return { ok: false, content: "self_subsystem requires a 'name' string.", error: "bad_args" };
      if (name === "list") {
        return {
          ok: true,
          content: `Available subsystems: ${SUBSYSTEM_NAMES.join(", ")}`,
          data: { subsystems: SUBSYSTEM_NAMES },
        };
      }
      const doc = SUBSYSTEMS[name];
      if (!doc) {
        return {
          ok: false,
          content:
            `unknown subsystem "${name}". Available: ${SUBSYSTEM_NAMES.join(", ")}. ` +
            `Call self_subsystem with name=list to enumerate.`,
          error: "bad_args",
        };
      }
      const out = { name, ...doc };
      return { ok: true, content: JSON.stringify(out, null, 2), data: out };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildRuntimeSnapshot(
  ctx: SelfContext,
  primary: { provider: string; model: string; baseUrl: string },
): Record<string, unknown> {
  return {
    name: "Cinderpaw",
    version: ctx.version,
    booted_at_ms: ctx.bootedAt,
    booted_at_iso: new Date(ctx.bootedAt).toISOString(),
    uptime_ms: Date.now() - ctx.bootedAt,
    active_model: `${primary.provider}/${primary.model}`,
    active_base_url: primary.baseUrl,
    brain_stack_enabled: ctx.brainStackEnabled,
    cloud_reachable: ctx.router.cloudReachable,
    sidecar_lifecycle: "supervised by the host runtime (Tauri or feral-cli gateway)",
  };
}

function summariseSubsystem(d: SubsystemDoc): Record<string, unknown> {
  return {
    purpose: d.purpose,
    inputs: d.inputs,
    outputs: d.outputs,
    safety: d.safety,
    promotion: d.promotion,
    rollback: d.rollback,
    introspect_with: d.inspect,
  };
}

/**
 * Read the configured fallback target via the router's public getter
 * (`currentFallback`). The router hides the api key; we surface
 * {provider, model, base_url} only. Returns null when no fallback is
 * configured — that is a valid state (single-model installs) and not an
 * error.
 */
function readFallbackProvider(
  ctx: SelfContext,
): { provider: string; model: string; base_url: string } | null {
  const f = ctx.router.currentFallback;
  if (!f) return null;
  return { provider: f.provider, model: f.model, base_url: f.baseUrl };
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build the full self.* tool set. Returned in registration order so callers
 * can `.forEach(t => registry.register(t))` or pick a subset.
 */
export function createSelfTools(ctx: SelfContext): Tool[] {
  return [
    makeSelfDescribe(ctx),
    makeSelfStatus(ctx),
    makeSelfRuntime(ctx),
    makeSelfTools(ctx),
    makeSelfProviders(ctx),
    makeSelfMemory(ctx),
    makeSelfConnectors(ctx),
    makeSelfGenome(ctx),
    makeSelfDreams(ctx),
    makeSelfLora(ctx),
    makeSelfHealth(ctx),
    makeSelfSubsystem(),
    makeSelfProgress(),
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────

export const __testInternals = {
  readJsonSync,
  tailJsonl,
  shapeChampion,
  shapePopulation,
  shapeDreams,
  shapeMemory,
  shapeLora,
  shapeConnectors,
  healthChampion,
  healthPopulation,
  healthDreams,
  healthLora,
  healthConnectors,
  healthNotebook,
  SUBSYSTEMS,
};
