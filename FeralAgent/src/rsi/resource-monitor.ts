/**
 * Faza 4 Slice 5 — real resource measurement for RSI episodes.
 *
 * The §2.5 budget model always CARRIED cpu/ram/disk/energy caps, but until
 * now nothing measured actual usage — the journal reported notional
 * numbers. This module supplies the honest half:
 *
 *   - CPU: `process.cpuUsage()` delta over the sampled window, as a
 *     percentage of one core (can exceed 100 on multi-threaded work).
 *   - RAM: RSS at sample end, MB.
 *   - Disk: recursive size of the RSI state dir, MB (bounded walk).
 *   - Wall clock: the window itself.
 *
 * Deliberately NOT measured (honesty over theatre):
 *   - energy — needs RAPL/SMC access neither Windows nor a sidecar
 *     process has; reporting a made-up kWh would be worse than none.
 *   - VRAM — lives inside llama.cpp on the Rust side; llama-cpp-2
 *     exposes no usage query today. Revisit when the crate grows one.
 *
 * Everything here is best-effort and non-throwing: measurement must never
 * break the engine it observes.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Opaque start marker — pass to `endResourceSample`. */
export interface ResourceSample {
  startedAt: number;
  cpuUserUs: number;
  cpuSystemUs: number;
}

/** Measured usage over one sampled window. */
export interface ResourceUsage {
  /** CPU time / wall time, % of one core. */
  cpuPct: number;
  /** Resident set size at window end, MB. */
  ramMb: number;
  /** Wall-clock length of the window, minutes. */
  wallClockMin: number;
}

export function startResourceSample(now: () => number = Date.now): ResourceSample {
  const cpu = process.cpuUsage();
  return { startedAt: now(), cpuUserUs: cpu.user, cpuSystemUs: cpu.system };
}

export function endResourceSample(
  sample: ResourceSample,
  now: () => number = Date.now,
): ResourceUsage {
  const cpu = process.cpuUsage();
  const wallMs = Math.max(1, now() - sample.startedAt);
  const cpuUs = cpu.user - sample.cpuUserUs + (cpu.system - sample.cpuSystemUs);
  return {
    cpuPct: round1((cpuUs / 1000 / wallMs) * 100),
    ramMb: round1(process.memoryUsage().rss / (1024 * 1024)),
    wallClockMin: round1(wallMs / 60_000),
  };
}

/** Total size of a directory tree in MB. Best-effort: unreadable entries
 *  are skipped, and the walk is capped so a runaway tree can't stall the
 *  caller (ponytail: 20k-entry cap; a streaming du if state dirs ever
 *  outgrow it). Returns 0 for a missing dir. */
export function dirSizeMb(dir: string, maxEntries = 20_000): number {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue; // missing/unreadable dir — skip
    }
    for (const name of entries) {
      if (++seen >= maxEntries) break;
      const p = join(current, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else bytes += st.size;
      } catch {
        // racing deletion / permission — skip the entry
      }
    }
  }
  return round1(bytes / (1024 * 1024));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
