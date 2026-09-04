/**
 * Dream Cycle — population snapshot persistence (disk layer).
 *
 * Persists the full PopulationSnapshot so a dream cycle resumes exactly
 * where the prior episode stopped (genomes, lineage, fitness, the
 * monotonic best-record, and the path-dependent Hall of Fame). This is
 * the superset of the champion fallback: when this snapshot is missing
 * or unreadable, the sidecar's resume cascade falls through to
 * `champion.json` (best-genome only) and finally to cold seeds.
 *
 * Discipline mirrors champion.ts: writes are best-effort (a disk error
 * must never abort the engine) and reads degrade to `null` on a missing,
 * corrupt, or version-mismatched file rather than throwing. Writes are
 * atomic (temp file + rename) so a crash mid-write can't leave a
 * half-written snapshot that would later fail to parse.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cinderpawHome } from "../../config.ts";
import type { PopulationSnapshot } from "./population-manager.ts";

/** The on-disk format version this module reads/writes. A snapshot whose
 *  version differs is rejected (returns null) so an incompatible upgrade
 *  degrades to the champion fallback instead of corrupting a run. */
const SNAPSHOT_VERSION = 1;

/** Default on-disk location: `~/.cinderpaw/rsi/population.json` (sibling of
 *  champion.json + the git substrate). */
export function defaultPopulationSnapshotPath(): string {
  return join(cinderpawHome(), "rsi", "population.json");
}

/**
 * Persist `snap` atomically. Returns true on success, false on any error
 * (best-effort: the caller never has to try/catch — a failed snapshot
 * just means the next resume falls back to the champion). Creates the
 * parent directory if needed.
 */
export function writePopulationSnapshot(
  path: string,
  snap: PopulationSnapshot,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a snapshot. Returns null for a missing, corrupt, or
 * version-mismatched file — a bad snapshot must never crash a resume; the
 * caller degrades to the champion fallback.
 */
export function readPopulationSnapshot(path: string): PopulationSnapshot | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as PopulationSnapshot).version === SNAPSHOT_VERSION &&
      Array.isArray((parsed as PopulationSnapshot).genomes)
    ) {
      return parsed as PopulationSnapshot;
    }
  } catch {
    // Missing / corrupt — treat as "no snapshot yet".
  }
  return null;
}
