/**
 * Dream Cycle telemetry — best-effort JSONL episode log.
 *
 * One line per completed dream episode, appended to a host-configured
 * path. This is a *soft* layer: a disk error, a permission failure, or a
 * missing parent directory must never break the engine. If telemetry
 * can't be written we drop the record silently — losing one row is much
 * cheaper than letting a transient FS hiccup abort a $20 dream.
 *
 * The format is deliberately simple JSONL (one `JSON.stringify` per record,
 * one `\n` separator). Consumers can `readline` it, `jq` it, or `tail -f`
 * it without needing a schema file. Fields are flat and primitive so the
 * line stays parseable across Feral versions.
 */
import { appendFileSync } from "node:fs";

export interface DreamEpisodeRecord {
  startedAt: number;
  endedAt: number;
  trigger: "idle" | "error" | "manual";
  iterations: number;
  tokens: number;
  ratchets: number;
  stopReason: string;
}

/** Append one JSON line to `path`. Swallows ALL errors — telemetry is a
 *  best-effort audit trail, never a correctness requirement. */
export function appendDreamTelemetry(path: string, rec: DreamEpisodeRecord): void {
  try {
    // appendFileSync creates the file if it doesn't exist and opens with
    // O_APPEND, which is the atomic-enough behaviour we want for a
    // single-process writer (the sidecar emits one episode at a time).
    appendFileSync(path, JSON.stringify(rec) + "\n");
  } catch {
    // Intentionally swallowed — see the file header. Anything thrown by
    // appendFileSync (ENOENT on a missing dir, EACCES, EROFS, EMFILE,
    // JSON.stringify failure on a poisoned rec) is dropped on the floor.
  }
}
