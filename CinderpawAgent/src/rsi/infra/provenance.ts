/**
 * Knowledge Provenance — the queryable graph that backs BRSI §2.6.
 *
 * Why this exists:
 *   Every artifact Cinderpaw produces — every genome commit, every code
 *   patch, every LoRA adapter, every UIA demo, every personal eval
 *   task — has parents. "Where did this come from?" is the most
 *   important question in a system that improves itself. Without an
 *   answer, rollback is impossible, debugging is archaeology, and the
 *   user cannot trust what the engine shipped.
 *
 *   The git substrate (`src-tauri/src/rsi/repo.rs`) already records
 *   parent_lineage for genome / config / code-patch commits in the
 *   commit body. This module is the READ-SIDE graph layer: it walks
 *   `rsi_log` once, caches the result, and answers `show` /
 *   `descendants` / `commonAncestor` queries in O(parents + children).
 *
 *   Non-code artifacts (LoRA, demo, eval-task) use a typed envelope
 *   that this module also defines. Storage for envelopes is TODO
 *   (BRSI refactor sequence step 6); the type ships today so the
 *   other modules (Journal, PersonalFitness) can refer to it.
 *
 * Discipline: pure data structure + bridge I/O. The two graph
 * constructors (`rsiProvenanceGraph` for production, `inMemoryProvenanceGraph`
 * for tests) share the same shape. Tests pass synthetic commits; the
 * live engine uses the bridge.
 */

import type { RsiBridge } from "./bridge.ts";

/** A node in the provenance graph. The same shape works for code
 *  commits (git-backed) and non-code artifacts (envelope-backed). */
export interface ProvenanceNode {
  /** Canonical id. Git SHA for code/config; envelope id for LoRA/demo/eval. */
  id: string;
  /** What kind of artifact this is. */
  kind: ProvenanceKind;
  /** Parent ids. Empty for the root. May have > 1 for merge commits. */
  parents: string[];
  /** Parsed metadata, if present (commit body for code; `data` for envelopes). */
  metadata?: Record<string, unknown>;
  /** Optional human-readable summary (e.g., the commit summary line). */
  summary?: string;
  /** Unix epoch ms, if available. */
  timestamp?: number;
}

/** The kinds of artifacts the provenance graph tracks. */
export type ProvenanceKind =
  | "genome" // config genome (Faza 1)
  | "code_patch" // Faza 2 — TS code change
  | "config" // raw config (rare, today mostly via genome.kind)
  | "lora" // LoRA adapter (Layer 2+)
  | "demo" // UIA demonstration (Layer 2+)
  | "eval_task" // personal eval task (Layer 2+)
  | "module" // L4 architecture module (Layer 4)
  | "unknown"; // kind not in metadata — defensive

/** Typed envelope for non-code artifacts. Storage is TODO; the type
 *  ships today so the rest of the engine can reference it. */
export interface ArtifactEnvelope {
  /** Stable id, e.g. "lora-v8" or "demo-2026-07-14-001". */
  id: string;
  /** What kind of artifact. */
  kind: "lora" | "demo" | "eval_task" | "module";
  /** Parent envelope ids (BRSI §2.6: "LoRA v8 → LoRA v5 → LoRA v3 → Base Gemma"). */
  parents: string[];
  /** When it was created. */
  timestamp: number;
  /** Artifact-specific payload. */
  data: Record<string, unknown>;
}

// INVARIANT I12: Provenance graph acyclic — git substrate + BFS seen set prevents cycles (docs/invariants.md I12).

/** The provenance-graph interface. Two constructors below. */
export interface ProvenanceGraph {
  /** Walk from `id` up the parent chain. Returns the chain in order:
   *  `id` first, then its parent, then grandparent, … Stops at the
   *  root or when a parent is not in the cache. The result length
   *  tells you the depth of `id`. */
  show(id: string): Promise<ProvenanceNode[]>;

  /** Walk from `root` down — find every descendant in the cache.
   *  BFS, parents before children. Useful for "what did this LoRA
   *  produce?" queries. */
  descendants(root: string): Promise<ProvenanceNode[]>;

  /** LCA of two nodes. Uses the bridge `rsi_lca` for production;
   *  implemented inline for the in-memory variant. */
  commonAncestor(a: string, b: string): Promise<string | null>;
}

/** Minimal commit shape we accept. Mirrors `repo::CommitMeta` but
 *  stays dependency-free so tests can construct one from a literal. */
export interface CommitMetaLike {
  commit_hash: string;
  parent_hashes: string[];
  metadata_json?: string | null;
  summary?: string;
  timestamp?: number;
}

/** Build a graph backed by the live RSI bridge. Caches `rsi_log(N)`
 *  on first use; subsequent queries operate on the cache. */
export function rsiProvenanceGraph(
  bridge: RsiBridge,
  opts: { maxLog?: number; timeoutMs?: number } = {},
): ProvenanceGraph {
  const maxLog = opts.maxLog ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let cache: Map<string, CommitMetaLike> | null = null;

  async function loadCache(): Promise<Map<string, CommitMetaLike>> {
    if (cache) return cache;
    const commits = await bridge.request<CommitMetaLike[]>(
      "rsi_log",
      maxLog,
      timeoutMs,
    );
    cache = new Map();
    for (const c of commits) cache.set(c.commit_hash, c);
    return cache;
  }

  return {
    async show(id) {
      const m = await loadCache();
      return walkAncestors(m, id);
    },
    async descendants(root) {
      const m = await loadCache();
      return walkDescendants(m, root);
    },
    async commonAncestor(a, b) {
      return bridge.request<string | null>("rsi_lca", { a, b }, timeoutMs);
    },
  };
}

/** Build a graph from an in-memory commit list. Used by tests and
 *  by tooling that has already materialised the log (e.g., a UI
 *  inspector). */
export function inMemoryProvenanceGraph(
  commits: ReadonlyArray<CommitMetaLike>,
): ProvenanceGraph {
  const m = new Map<string, CommitMetaLike>();
  for (const c of commits) m.set(c.commit_hash, c);

  return {
    async show(id) {
      return walkAncestors(m, id);
    },
    async descendants(root) {
      return walkDescendants(m, root);
    },
    async commonAncestor(a, b) {
      return lca(m, a, b);
    },
  };
}

/** Convert a CommitMeta into a ProvenanceNode, parsing metadata_json
 *  when present. */
function toNode(c: CommitMetaLike): ProvenanceNode {
  let metadata: Record<string, unknown> | undefined;
  if (c.metadata_json) {
    try {
      const parsed = JSON.parse(c.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed metadata — leave undefined rather than poison the node.
    }
  }
  const kind = inferKind(metadata);
  return {
    id: c.commit_hash,
    kind,
    parents: [...c.parent_hashes],
    metadata,
    summary: c.summary,
    timestamp: c.timestamp,
  };
}

/** Best-effort kind inference. Looks at the parsed metadata's
 *  `mutation_type`, `kind`, or `type` field — the three names the
 *  engine has used for this purpose across versions. Defaults to
 *  `"unknown"` so callers can detect misclassification. */
function inferKind(metadata: Record<string, unknown> | undefined): ProvenanceKind {
  if (!metadata) return "unknown";
  const candidate =
    (metadata["kind"] as string | undefined) ??
    (metadata["type"] as string | undefined) ??
    (metadata["mutation_type"] as string | undefined);
  switch (candidate) {
    case "genome":
      return "genome";
    case "code_patch":
    case "code":
      return "code_patch";
    case "config":
      return "config";
    case "lora":
      return "lora";
    case "demo":
      return "demo";
    case "eval_task":
      return "eval_task";
    default:
      return "unknown";
  }
}

function walkAncestors(
  cache: Map<string, CommitMetaLike>,
  id: string,
): ProvenanceNode[] {
  const out: ProvenanceNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const c = cache.get(cur);
    if (!c) break;
    out.push(toNode(c));
    // Walk primary lineage. For merge commits (parent_hashes.length > 1)
    // the caller can invoke `show(parent[1])` etc. separately to walk the
    // other branches — keeps the API simple.
    cur = c.parent_hashes[0];
  }
  return out;
}

function walkDescendants(
  cache: Map<string, CommitMetaLike>,
  root: string,
): ProvenanceNode[] {
  // Build the parent → children reverse map.
  const childMap = new Map<string, string[]>();
  for (const c of cache.values()) {
    for (const p of c.parent_hashes) {
      const list = childMap.get(p);
      if (list) list.push(c.commit_hash);
      else childMap.set(p, [c.commit_hash]);
    }
  }
  // BFS from root.
  const out: ProvenanceNode[] = [];
  const seen = new Set<string>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    const c = cache.get(cur);
    if (!c) continue;
    out.push(toNode(c));
    const children = childMap.get(cur);
    if (children) {
      for (const ch of children) queue.push(ch);
    }
  }
  return out;
}

/** In-memory LCA: walk both ancestors, return the deepest common node.
 *  O(depth_a + depth_b). Fine for the log sizes we see in practice. */
function lca(
  cache: Map<string, CommitMetaLike>,
  a: string,
  b: string,
): string | null {
  const ancestorsA = new Set<string>();
  for (const n of walkAncestors(cache, a)) ancestorsA.add(n.id);
  for (const n of walkAncestors(cache, b)) {
    if (ancestorsA.has(n.id)) return n.id;
  }
  return null;
}