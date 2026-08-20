/**
 * L4 seam adapter (spec §1, §8) — the runtime-side bridge between a seam
 * and whatever the registry says serves it.
 *
 * Invariants:
 *   - `active === "builtin"` → the builtin function is called DIRECTLY:
 *     no subprocess, no serialization, no process boundary (AC10 — with
 *     no modules promoted, runtime behavior is byte-identical to today).
 *   - `active === <module id>` → request goes to the module host; ANY
 *     failure (spawn refusal, crash, timeout, malformed reply) returns
 *     the BUILTIN result for that request — the user never sees a module
 *     error (spec §4) — and counts one watchdog strike.
 *   - ≥ `maxStrikes` strikes inside `strikeWindowMs` → automatic
 *     quarantine (§8.2): registry re-pointed to builtin, governance
 *     audit row `module_quarantined`, host stopped. Mirrors the Faza 3
 *     crash→auto-revert watchdog, but cheaper — re-point, no rebuild.
 *   - The registry is re-read on EVERY invoke (§6: promotion re-resolves
 *     on next request, no restart; demotion likewise).
 */

import { join } from "node:path";
import { appendGovernanceAudit } from "../l5-gov/governance-audit.ts";
import { defaultGovernanceDir } from "../l5-gov/governance.ts";
import { spawnModuleHost, type ModuleHost, type ModuleHostLimits, type SpawnResult } from "./module-host-client.ts";
import { defaultModulesDir, type ModuleRegistry } from "./module-registry.ts";

export interface SeamAdapterOpts {
  seam: string;
  registry: ModuleRegistry;
  /** The permanent fallback. Must never throw for inputs the runtime
   *  produces — it is the floor the user stands on. */
  builtin: (method: string, params: unknown) => Promise<unknown>;
  /** Where a module id lives on disk. Default: `<modules dir>/<id>`. */
  moduleDirFor?: (id: string) => string;
  /** Governance dir for the quarantine audit row. */
  governanceDir?: string;
  limits?: ModuleHostLimits;
  /** Watchdog: strikes within the window that trigger quarantine. */
  maxStrikes?: number;
  strikeWindowMs?: number;
  /** Injectable for tests. Production: `spawnModuleHost`. */
  spawn?: typeof spawnModuleHost;
  now?: () => number;
  log?: (msg: string) => void;
  /** Surface for the desktop toast (§8.2). Fired once per quarantine. */
  onQuarantine?: (moduleId: string, reason: string) => void;
}

export class SeamAdapter {
  private readonly o: Required<Pick<SeamAdapterOpts, "seam" | "registry" | "builtin">> & SeamAdapterOpts;
  private readonly limits: ModuleHostLimits;
  private readonly maxStrikes: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private host: ModuleHost | null = null;
  private hostModuleId: string | null = null;
  private spawning: Promise<SpawnResult> | null = null;
  /** Which module `spawning` is actually starting — see `ensureHost`. */
  private spawningModuleId: string | null = null;
  private strikes: number[] = [];

  constructor(opts: SeamAdapterOpts) {
    this.o = opts as typeof this.o;
    this.limits = opts.limits ?? { timeoutMs: 2_000, maxRssMb: 256 };
    this.maxStrikes = opts.maxStrikes ?? 3;
    this.windowMs = opts.strikeWindowMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Resolve + invoke. Always returns a result (module failures fall back
   *  to builtin); only the builtin itself may throw. */
  async invoke(method: string, params: unknown): Promise<unknown> {
    const active = this.o.registry.activeFor(this.o.seam);
    if (active === "builtin") {
      this.stopHost(); // demotion re-resolves here — host is dead weight
      return this.o.builtin(method, params);
    }
    const host = await this.ensureHost(active);
    if (!host) {
      this.strike(active, "host spawn failed");
      return this.o.builtin(method, params);
    }
    const reply = await host.request(method, params);
    if (!reply.ok) {
      this.strike(active, reply.error);
      return this.o.builtin(method, params);
    }
    return reply.result;
  }

  /** Stop the host (demote/quarantine/shutdown paths). Idempotent. */
  stopHost(): void {
    if (this.host) {
      this.host.stop();
      this.host = null;
      this.hostModuleId = null;
    }
  }

  private async ensureHost(moduleId: string): Promise<ModuleHost | null> {
    if (this.host && this.hostModuleId === moduleId && this.host.alive()) return this.host;
    this.stopHost(); // active changed (promotion) or host died — respawn

    // `this.spawning ??= …` reused an in-flight spawn no matter WHICH module it
    // was starting. If the registry re-pointed the seam mid-spawn — which is
    // exactly what a promotion does — the second caller joined the first
    // caller's spawn of the OLD module and then labelled it with the NEW id.
    // Every later invoke went to the old module's code while the UI reported
    // the new one as active: the promotion appeared to happen and did not.
    if (this.spawning && this.spawningModuleId !== moduleId) {
      // Someone else is starting a different module. Let theirs finish and be
      // discarded by the check below rather than adopting it as ours.
      await this.spawning.catch(() => undefined);
      this.spawning = null;
      this.spawningModuleId = null;
      this.stopHost();
    }
    if (!this.spawning) {
      this.spawningModuleId = moduleId;
      this.spawning = (this.o.spawn ?? spawnModuleHost)({
        moduleDir: (this.o.moduleDirFor ?? ((id: string) => join(defaultModulesDir(), id)))(moduleId),
        limits: this.limits,
        log: this.log,
      });
    }
    const spawnedFor = this.spawningModuleId;
    const res = await this.spawning;
    this.spawning = null;
    this.spawningModuleId = null;
    if (!res.ok) {
      this.log(`seam(${this.o.seam}): host spawn failed for ${moduleId} — ${res.reason}`);
      return null;
    }
    if (spawnedFor !== moduleId) {
      // Belt and braces: never attach a host under a name it is not.
      this.log(
        `seam(${this.o.seam}): discarding host for ${spawnedFor} — ${moduleId} is now active`,
      );
      res.host.stop();
      return this.ensureHost(moduleId);
    }
    this.host = res.host;
    this.hostModuleId = moduleId;
    return res.host;
  }

  private strike(moduleId: string, why: string): void {
    const t = this.now();
    this.strikes = this.strikes.filter((s) => t - s < this.windowMs);
    this.strikes.push(t);
    this.log(`seam(${this.o.seam}): strike ${this.strikes.length}/${this.maxStrikes} on ${moduleId} — ${why}`);
    if (this.strikes.length >= this.maxStrikes) {
      this.quarantine(moduleId, why);
    }
  }

  private quarantine(moduleId: string, lastError: string): void {
    this.strikes = [];
    this.stopHost();
    // Audit BEFORE the repoint so the quarantine row precedes the demote
    // row in the chain — forensics read cause then effect.
    appendGovernanceAudit(this.o.governanceDir ?? defaultGovernanceDir(), {
      timestamp: this.now(),
      source: "l4",
      event: "module_quarantined",
      refId: moduleId,
      summary: `${this.o.seam}: ${this.maxStrikes} failures in window — auto-quarantine (last: ${lastError.slice(0, 120)})`,
    });
    this.o.registry.repoint(
      this.o.seam,
      "builtin",
      "watchdog",
      `auto-quarantine: ${this.maxStrikes} failures (last: ${lastError.slice(0, 120)})`,
    );
    this.log(`seam(${this.o.seam}): ${moduleId} QUARANTINED — builtin restored`);
    this.o.onQuarantine?.(moduleId, lastError);
  }
}
