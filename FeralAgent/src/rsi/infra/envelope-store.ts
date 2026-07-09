/**
 * Envelope storage — the write path for `ArtifactEnvelope` (BRSI §2.6,
 * refactor step 6; L4 spec §9). The `envelopes/` dir was reserved by
 * `instance-paths.ts`; L4 module candidates are its first real citizens.
 *
 * One JSON file per envelope id, temp+rename (same crash-safe discipline
 * as the registry / L6 persist). Reads are fail-soft (`null` on missing
 * or corrupt — callers decide whether that is fatal); writes are
 * fail-loud (a throw here means the artifact record could not be made
 * durable, and promotion evidence must never be silently lost).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./instance-paths.ts";
import type { ArtifactEnvelope } from "./provenance.ts";

export function defaultEnvelopesDir(): string {
  return paths().envelopes;
}

/** Envelope ids are file names — refuse anything that could escape. */
function assertSafeId(id: string): void {
  if (!id || /[\\/]|\.\./.test(id)) {
    throw new Error(`envelope id unsafe for storage: ${JSON.stringify(id)}`);
  }
}

export function envelopePath(id: string, dir = defaultEnvelopesDir()): string {
  assertSafeId(id);
  return join(dir, `${id}.json`);
}

/** Read an envelope. Missing or corrupt → null (fail-soft read side). */
export function readEnvelope(id: string, dir = defaultEnvelopesDir()): ArtifactEnvelope | null {
  const p = envelopePath(id, dir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ArtifactEnvelope;
    if (!raw || typeof raw !== "object" || raw.id !== id) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Write an envelope durably (temp+rename). Fail-loud. */
export function writeEnvelope(env: ArtifactEnvelope, dir = defaultEnvelopesDir()): void {
  const p = envelopePath(env.id, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(env, null, 2), "utf8");
  renameSync(tmp, p);
}

/** Read-modify-write. `patch` receives the current envelope (or a fresh
 *  one built by `create` when none exists) and returns what to persist. */
export function updateEnvelope(
  id: string,
  create: () => ArtifactEnvelope,
  patch: (env: ArtifactEnvelope) => ArtifactEnvelope,
  dir = defaultEnvelopesDir(),
): ArtifactEnvelope {
  const next = patch(readEnvelope(id, dir) ?? create());
  writeEnvelope(next, dir);
  return next;
}
