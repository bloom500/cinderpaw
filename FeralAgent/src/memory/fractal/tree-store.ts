/**
 * Tree-store — persistence for the RAPTOR tree.
 *
 * The fractal tree is built offline/incrementally (never at query time) and
 * reused across recalls, so it must survive a process restart. This module
 * (de)serializes a `TreeNode` to a JSON-safe shape and reads/writes it to a
 * single file under a versioned envelope.
 *
 * Why a custom serializer: `TreeNode.centroid` is a `Float32Array`, which
 * `JSON.stringify` turns into `{"0":..,"1":..}` (an object, not an array) and
 * `JSON.parse` never restores. We convert centroids to/from plain `number[]`
 * on the way out/in so the round-trip is lossless (modulo Float32 precision,
 * which is the storage type anyway).
 *
 * The envelope carries a `version`: a load whose version doesn't match the
 * current builder is treated as absent (return `null`), so a schema change
 * silently forces a rebuild instead of feeding a stale/incompatible tree to
 * the query path. Any read error (missing file, corrupt JSON) also yields
 * `null` — the caller falls back to FTS5 and/or rebuilds.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname } from "node:path";
import type { TreeNode } from "./types.ts";

/**
 * Bump when the serialized shape or the tree-builder semantics change in a way
 * that makes an on-disk tree incompatible. Old trees then load as `null` and
 * are rebuilt.
 */
export const TREE_STORE_VERSION = 1;

/** JSON-safe mirror of `TreeNode` (centroid as plain `number[]`). */
export interface SerializedNode {
  id: string;
  level: number;
  centroid: number[];
  summary: string;
  children: SerializedNode[];
  leafIds: number[];
}

/** Versioned on-disk envelope around a serialized tree. */
export interface PersistedTree {
  version: number;
  /** ms since epoch when the tree was built. */
  builtAt: number;
  /** Number of distinct episodic leaves under the root (root.leafIds.length). */
  leafCount: number;
  tree: TreeNode;
}

/** Recursively convert a `TreeNode` (Float32Array centroids) to JSON-safe form. */
export function serializeTree(node: TreeNode): SerializedNode {
  return {
    id: node.id,
    level: node.level,
    centroid: Array.from(node.centroid),
    summary: node.summary,
    children: node.children.map(serializeTree),
    leafIds: node.leafIds,
  };
}

/** Recursively restore a `TreeNode` (centroids back to Float32Array). */
export function deserializeTree(node: SerializedNode): TreeNode {
  return {
    id: node.id,
    level: node.level,
    centroid: new Float32Array(node.centroid),
    summary: node.summary,
    children: node.children.map(deserializeTree),
    leafIds: node.leafIds,
  };
}

/**
 * Write `tree` to `path` (creating parent dirs) in the versioned envelope.
 * Throws on I/O failure — callers that build trees should surface that;
 * read-side failures are the ones we swallow (see `loadTree`).
 */
export function saveTree(path: string, tree: TreeNode): void {
  const envelope = {
    version: TREE_STORE_VERSION,
    builtAt: Date.now(),
    leafCount: tree.leafIds.length,
    tree: serializeTree(tree),
  };
  mkdirSync(dirname(path), { recursive: true });
  // Atomic: losing this file does not just cost a load — `loadTree` returning
  // null forces a full rebuild, which re-embeds every leaf and re-summarises
  // every cluster through a paid model. A crash mid-write should not send the
  // user a bill.
  atomicWriteFileSync(path, JSON.stringify(envelope));
}

/**
 * Load a persisted tree from `path`. Returns `null` — never throws — when the
 * file is missing, unparseable, or carries a different `version`, so the
 * caller treats it as "no tree yet" and rebuilds / falls back to FTS5.
 */
export function loadTree(path: string): PersistedTree | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // missing/unreadable
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== TREE_STORE_VERSION
  ) {
    return null; // absent or stale schema → force rebuild
  }
  const env = parsed as {
    version: number;
    builtAt?: number;
    leafCount?: number;
    tree: SerializedNode;
  };
  return {
    version: env.version,
    builtAt: env.builtAt ?? 0,
    leafCount: env.leafCount ?? 0,
    tree: deserializeTree(env.tree),
  };
}
