/**
 * Where a code candidate is allowed to RUN.
 *
 * `code-sandbox.ts` used to execute the candidate's test suite on the host,
 * in a disposable git worktree. Disposable is not isolated: a patch the model
 * wrote could read `~/.cinderpaw`, reach the network, fork until the machine
 * choked, or fill the disk, and destroying the worktree afterwards undoes
 * none of that. Astra's audit of 12 Sep 2026 named it; the recursive-learning
 * spec (§10) makes it a prerequisite: generated code runs in an isolated
 * Linux environment with no host directories, no credentials, no network,
 * bounded CPU / memory / processes / disk / wall time, or it does not run.
 *
 * "Or it does not run" is the rule this module enforces. There is no host
 * fallback. On a machine without a working backend the candidate is refused
 * with a reason a person can read, not evaluated a little less safely.
 *
 * First backend: Docker. On Windows and macOS a Docker container lives inside
 * the Docker Desktop Linux VM, so it is the VM the spec asks for. On Linux it
 * is a container on the host kernel, not a VM: weaker, and said so in the
 * `isolationNote` the receipt carries.
 *
 * Two shapes of cell. `run` executes L3 steps to completion. `command` starts
 * a long-lived L4 module host that the runtime talks to over stdin/stdout
 * (`ModuleCell`): same walls, with the module and the host script mounted
 * read-only instead of copied in, because stdin is the protocol channel.
 *
 * This file is on the L3 patch denylist. A candidate that could patch the
 * walls of its own cell has no walls.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { minimalEnv, type ExecFn, type ExecResult } from "./code-sandbox.ts";

/** One measurement command, run inside the sandbox in order. */
export interface IsolatedStep {
  name: string;
  argv: string[];
  timeoutMs: number;
}

/** Hard limits, outside the candidate's reach. */
export interface IsolationLimits {
  /** Docker `--memory`, e.g. "4g". */
  memory: string;
  /** Docker `--cpus`. */
  cpus: number;
  /** Docker `--pids-limit`: forks past this fail. */
  pids: number;
  /** Size of the writable scratch (tmpfs) the source is copied into. */
  scratch: string;
  /** Wall clock for the whole sandbox, all steps included. Past it the
   *  container is killed, not asked. */
  wallMs: number;
}

export const DEFAULT_ISOLATION_LIMITS: IsolationLimits = {
  memory: "4g",
  cpus: 2,
  pids: 512,
  scratch: "2g",
  wallMs: 20 * 60_000,
};

export type Availability = { ok: true; note: string } | { ok: false; reason: string };

/** `lockfile` (default): dependencies installed from the copied tree's
 *  `bun.lock`, for L3 candidates. `base`: the plain base image, for trees
 *  whose content is untrusted (an evaluated workspace): a lockfile the
 *  executor wrote must never be installed, and the build step has network. */
export interface RunOptions {
  image?: "lockfile" | "base";
}

export interface IsolationBackend {
  readonly name: string;
  /** Can this backend run a candidate right now? The reason is shown to the
   *  person, so it says what to do, not just what is missing. */
  available(): Promise<Availability>;
  /**
   * Copy `pkgDir` (a patched package checkout, no node_modules) into a
   * fresh sandbox and run the steps in order. Returns one result per step.
   * A step that times out kills the sandbox; it and every later step are
   * reported as `timedOut`. The sandbox is destroyed on every path.
   */
  run(pkgDir: string, steps: IsolatedStep[], opts?: RunOptions): Promise<ExecResult[]>;
}

/** What an L4 module host needs from a cell. */
export interface ModuleCellSpec {
  /** Host path of the module host script; the cell reads it, nothing more. */
  hostScript: string;
  /** Host path of the module's directory; read-only inside the cell. */
  moduleDir: string;
  /** The whole environment inside the cell. Nothing else crosses. */
  env: Record<string, string>;
  /** Hard memory cap for the cell, in MB. */
  memoryMb: number;
  /** Unique name. Killing the client that started a cell does not stop
   *  it; the name is how it is destroyed. */
  name: string;
}

/** A cell for a long-lived module host (L4), spoken to over stdin/stdout. */
export interface ModuleCell {
  readonly name: string;
  available(): Promise<Availability>;
  /** Whatever the first start needs (the image). The only step that may
   *  use the network. The reason is worded for the person reading it. */
  prepare(): Promise<Availability>;
  /** The process to spawn for `spec`, and that process's own environment. */
  command(spec: ModuleCellSpec): { argv: string[]; env: Record<string, string> };
  /** Destroy the cell by name. Idempotent; resolves when it is gone. */
  destroy(name: string): Promise<void>;
}

/** Runs a command and returns its stdout as bytes, killing it past `maxBytes`.
 *  The text `ExecFn` would corrupt a tar stream. */
export type SpawnBytes = (
  cmd: string[],
  maxBytes: number,
  timeoutMs: number,
) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }>;

/** What an executor cell (AgentLoop spec S1.3b) is built from. Every tree is
 *  COPIED in, never mounted, and copied whole (only `.git` and symlinks are
 *  skipped): the caller passes trees with no secrets in them. The three tmpfs
 *  trees count against the cell's `memory` limit; size it above their sum. */
export interface ExecutorCellSpec {
  /** Unique container name; the handle and the sweep find it by name/label. */
  name: string;
  /** Holds OUR `bun.lock`: the image's dependency set. Never a tree the
   *  executor wrote. */
  depsDir: string;
  /** Agent source, copied root-owned to `/app/src`: readable, not writable,
   *  by the agent's user. */
  sourceDir: string;
  /** The task's starting files, copied to `/app/work` as the agent's user. */
  workspaceDir: string;
  /** Files planted in the agent's home (`/tmp/home`), as the agent's user. */
  homeDir?: string;
}

export interface TarCaps {
  maxBytes: number;
  maxEntries: number;
}

export interface ExecutorCell {
  readonly name: string;
  /** The `docker exec -i` argv for a process in the cell. Spawned by the
   *  caller, which owns its stdin/stdout. Only the env given here (plus
   *  HOME) reaches the process. */
  processArgv(p: { user: "agent" | "root"; argv: string[]; env: Record<string, string>; workdir?: string }): string[];
  /** Stops every agent process, then copies the workspace out through
   *  `readSafeTar` into a fresh host directory. DATA ONLY: the content is the
   *  executor's (a `.git/config`, `bunfig.toml` or `package.json` script can
   *  be hostile). Nothing on the host may run git, bun, npm or make in it;
   *  it is read, hashed, or copied into another cell. */
  extractWorkspace(caps: TarCaps): Promise<{ ok: true; dir: string; files: number; bytes: number } | { ok: false; reason: string }>;
  destroy(): Promise<void>;
}

export interface DockerIsolationOptions {
  exec: ExecFn;
  spawnBytes?: SpawnBytes;
  limits?: Partial<IsolationLimits>;
  /** Where the throwaway image build context is written. */
  scratchDir?: string;
  /** Base image. Pinned by tag; the lockfile hash pins what is installed
   *  on top of it. */
  baseImage?: string;
  log?: (line: string) => void;
}

/** Inside the container. Dependencies are baked into the image under
 *  `/app/node_modules` (read-only, the candidate cannot alter them); the
 *  source lands on a tmpfs at `/app/work`, and bun resolves imports by
 *  walking up, so `/app/work/src` finds `/app/node_modules`. */
const IMAGE_WORKDIR = "/app/work";
const IMAGE_REPO = "cinderpaw-code-rsi";

/** Executor cells (AgentLoop spec S1.3b): the agent runs as this uid, so its
 *  own shell cannot reach root-owned processes (the model relay) through
 *  `/proc/<pid>/fd`, nor rewrite its source in `/app/src`. */
const AGENT_UID = "1000:1000";
const AGENT_HOME = "/tmp/home";
const AGENT_SRC = "/app/src";
const EXECUTOR_LABEL = "cinderpaw=agent-exec";

const timedOut = (): ExecResult => ({ exitCode: -1, stdout: "", stderr: "killed: sandbox wall clock", timedOut: true });

export class DockerIsolation implements IsolationBackend, ModuleCell {
  readonly name = "docker";
  readonly #exec: ExecFn;
  readonly #limits: IsolationLimits;
  readonly #scratch: string;
  readonly #base: string;
  readonly #log: (line: string) => void;
  readonly #spawnBytes: SpawnBytes;

  constructor(opts: DockerIsolationOptions) {
    this.#exec = opts.exec;
    this.#spawnBytes = opts.spawnBytes ?? spawnBytes;
    this.#limits = { ...DEFAULT_ISOLATION_LIMITS, ...opts.limits };
    this.#scratch = opts.scratchDir ?? join(tmpdir(), "cinderpaw-code-rsi-image");
    // The same bun that runs this agent, not a floating `1-slim`: a
    // candidate's tests must pass under the version the host verified.
    this.#base = opts.baseImage ?? `oven/bun:${Bun.version}-slim`;
    this.#log = opts.log ?? (() => {});
  }

  async available(): Promise<Availability> {
    let r: ExecResult;
    try {
      r = await this.#exec(["docker", "version", "--format", "{{.Server.Os}}/{{.Client.Os}}"], {
        cwd: tmpdir(),
        timeoutMs: 15_000,
      });
    } catch (e) {
      // No docker binary at all: Bun.spawn throws instead of exiting non-zero.
      r = { exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false };
    }
    if (r.timedOut) return { ok: false, reason: "Docker did not answer in 15 seconds. Is Docker Desktop still starting?" };
    if (r.exitCode !== 0) {
      const err = (r.stderr + r.stdout).toLowerCase();
      if (err.includes("not found") || err.includes("not recognized") || err.includes("enoent")) {
        return { ok: false, reason: "Docker is not installed. Install Docker Desktop (or Docker Engine on Linux) to let the improvement loop test its own patches." };
      }
      return { ok: false, reason: "Docker is installed but not running. Start Docker Desktop, then the loop will resume on its own." };
    }
    const [server, client] = r.stdout.trim().split("/");
    if (server !== "linux") return { ok: false, reason: `Docker is in ${server ?? "unknown"} container mode; the sandbox needs Linux containers.` };
    const note =
      client === "linux"
        ? "docker container on the host kernel (not a VM: no hypervisor boundary)"
        : `docker container inside the Docker Desktop Linux VM (client: ${client})`;
    return { ok: true, note };
  }

  /** The image is the pinned dependency set. One per lockfile hash: a
   *  changed lockfile builds a new image, an unchanged one reuses it, and
   *  the candidate never installs anything (the network is off). */
  async ensureImage(pkgDir: string): Promise<{ ok: true; tag: string } | { ok: false; reason: string }> {
    const lock = join(pkgDir, "bun.lock");
    if (!existsSync(lock)) return { ok: false, reason: `no bun.lock in ${pkgDir}; the sandbox pins dependencies from it` };
    const hash = createHash("sha256").update(readFileSync(lock)).update(this.#base).digest("hex").slice(0, 12);
    const tag = `${IMAGE_REPO}:${hash}`;
    const have = await this.#exec(["docker", "image", "inspect", tag], { cwd: tmpdir(), timeoutMs: 30_000 });
    if (have.exitCode === 0) return { ok: true, tag };

    const ctx = join(this.#scratch, hash);
    mkdirSync(ctx, { recursive: true });
    for (const f of ["package.json", "bun.lock", "bunfig.toml"]) {
      const src = join(pkgDir, f);
      if (existsSync(src)) writeFileSync(join(ctx, f), readFileSync(src));
    }
    writeFileSync(
      join(ctx, "Dockerfile"),
      [
        `FROM ${this.#base}`,
        "WORKDIR /app",
        "COPY package.json bun.lock* bunfig.toml* ./",
        // `--ignore-scripts`: lifecycle scripts of third-party packages do not
        // get to run at image build any more than they did on the host.
        "RUN bun install --frozen-lockfile --ignore-scripts",
        `RUN mkdir -p ${IMAGE_WORKDIR}`,
        `WORKDIR ${IMAGE_WORKDIR}`,
        "",
      ].join("\n"),
    );
    this.#log(`isolation: building ${tag} (lockfile changed or first run; needs the network once)`);
    // The only step with network access, and it runs OUR lockfile, not the
    // candidate's code. Ten minutes: a cold bun install of this tree.
    const built = await this.#exec(["docker", "build", "-t", tag, ctx], { cwd: ctx, timeoutMs: 10 * 60_000 });
    if (built.exitCode !== 0) {
      return { ok: false, reason: built.timedOut ? "docker build timed out after 10 minutes" : lastLine(built.stderr) || `docker build exited ${built.exitCode}` };
    }
    return { ok: true, tag };
  }

  async run(pkgDir: string, steps: IsolatedStep[], opts: RunOptions = {}): Promise<ExecResult[]> {
    const image = opts.image === "base" ? await this.#baseImage() : await this.ensureImage(pkgDir);
    if (!image.ok) return steps.map(() => ({ exitCode: -1, stdout: "", stderr: `isolation: ${image.reason}`, timedOut: false }));

    const L = this.#limits;
    const created = await this.#exec(
      [
        "docker", "create",
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", `${IMAGE_WORKDIR}:rw,exec,size=${L.scratch}`,
        "--tmpfs", "/tmp:rw,exec,size=512m",
        "--tmpfs", "/root/.bun:rw,size=256m",
        "--memory", L.memory,
        "--cpus", String(L.cpus),
        "--pids-limit", String(L.pids),
        "--workdir", IMAGE_WORKDIR,
        "--label", "cinderpaw=code-rsi",
        image.tag,
        "sleep", "infinity",
      ],
      { cwd: tmpdir(), timeoutMs: 60_000 },
    );
    if (created.exitCode !== 0) {
      const reason = `docker create failed: ${lastLine(created.stderr)}`;
      return steps.map(() => ({ exitCode: -1, stdout: "", stderr: reason, timedOut: false }));
    }
    const cid = created.stdout.trim();
    const deadline = Date.now() + L.wallMs;
    const results: ExecResult[] = [];
    try {
      const started = await this.#exec(["docker", "start", cid], { cwd: tmpdir(), timeoutMs: 60_000 });
      if (started.exitCode !== 0) throw new Error(`docker start failed: ${lastLine(started.stderr)}`);
      // The source goes in by copy, never by mount: the container has no
      // path back to the host filesystem. Not `docker cp`: the daemon refuses
      // it on a read-only root even when the target is a tmpfs (measured,
      // 13 Sep). A tar through stdin lands in the tmpfs like any write.
      const copied = await this.#exec(["docker", "exec", "-i", cid, "tar", "-x", "-C", IMAGE_WORKDIR], {
        cwd: pkgDir,
        timeoutMs: 120_000,
        stdin: await tarOf(pkgDir),
      });
      if (copied.exitCode !== 0) throw new Error(`copying the candidate in failed: ${lastLine(copied.stderr)}`);

      let dead = false;
      for (const step of steps) {
        if (dead) { results.push(timedOut()); continue; }
        const budget = Math.min(step.timeoutMs, deadline - Date.now());
        if (budget <= 0) { dead = true; results.push(timedOut()); continue; }
        const r = await this.#exec(["docker", "exec", "-w", IMAGE_WORKDIR, cid, ...step.argv], {
          cwd: tmpdir(),
          timeoutMs: budget,
        });
        if (r.timedOut) {
          // Killing the CLI does not kill what it started. Kill the cell.
          await this.#exec(["docker", "kill", cid], { cwd: tmpdir(), timeoutMs: 30_000 });
          dead = true;
        }
        results.push(r);
      }
      return results;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      while (results.length < steps.length) results.push({ exitCode: -1, stdout: "", stderr: reason, timedOut: false });
      return results;
    } finally {
      await this.#exec(["docker", "rm", "-f", cid], { cwd: tmpdir(), timeoutMs: 60_000 });
    }
  }

  // ── executor cells (AgentLoop spec S1.3b) ──────────────────────────────

  /**
   * A long-lived cell for one AgentLoop task: the same walls as `run()` (no
   * network, no capabilities, read-only root, caps), three tmpfs trees and
   * nothing mounted from the host. The caller spawns processes into it with
   * `processArgv` and must `destroy()` it on every path; `sweepExecutorCells`
   * clears any a crashed host left behind.
   */
  async openExecutorCell(spec: ExecutorCellSpec): Promise<{ ok: true; cell: ExecutorCell } | { ok: false; reason: string }> {
    const avail = await this.available();
    if (!avail.ok) return avail;
    const image = await this.ensureImage(spec.depsDir);
    if (!image.ok) return image;

    const L = this.#limits;
    const [uid, gid] = AGENT_UID.split(":");
    const created = await this.#exec(
      [
        "docker", "create",
        "--name", spec.name,
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", `${IMAGE_WORKDIR}:rw,exec,size=${L.scratch},uid=${uid},gid=${gid},mode=0755`,
        "--tmpfs", "/tmp:rw,exec,size=512m,mode=1777",
        "--tmpfs", `${AGENT_SRC}:rw,size=256m,mode=0755`,
        "--memory", L.memory,
        "--cpus", String(L.cpus),
        "--pids-limit", String(L.pids),
        "--workdir", IMAGE_WORKDIR,
        "--label", EXECUTOR_LABEL,
        image.tag,
        "sleep", "infinity",
      ],
      { cwd: tmpdir(), timeoutMs: 60_000 },
    );
    if (created.exitCode !== 0) return { ok: false, reason: `docker create failed: ${lastLine(created.stderr)}` };

    const name = spec.name;
    const remove = async () => {
      const r = await this.#exec(["docker", "rm", "-f", name], { cwd: tmpdir(), timeoutMs: 60_000 }).catch((e: unknown) => ({
        exitCode: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
      }));
      if (r.exitCode !== 0) this.#log(`isolation: could not remove executor cell ${name}: ${lastLine(r.stderr) || `exit ${r.exitCode}`}; sweepExecutorCells clears it`);
    };
    const step = async (what: string, argv: string[], stdin?: Uint8Array): Promise<string | null> => {
      const r = await this.#exec(argv, { cwd: tmpdir(), timeoutMs: 120_000, stdin });
      return r.exitCode === 0 ? null : `${what} failed: ${lastLine(r.stderr) || `exit ${r.exitCode}`}`;
    };
    let failed: string | null;
    try {
      failed =
        (await step("docker start", ["docker", "start", name])) ??
        // Root writes the source: the agent's user can read it, not change it.
        (await step("copying the agent source in", ["docker", "exec", "-i", name, "tar", "-x", "-C", AGENT_SRC], await tarOf(spec.sourceDir))) ??
        (await step("creating the agent home", ["docker", "exec", "--user", AGENT_UID, name, "mkdir", "-p", AGENT_HOME])) ??
        (spec.homeDir
          ? await step("copying the agent home in", ["docker", "exec", "-i", "--user", AGENT_UID, name, "tar", "-x", "-C", AGENT_HOME], await tarOf(spec.homeDir))
          : null) ??
        (await step("copying the workspace in", ["docker", "exec", "-i", "--user", AGENT_UID, name, "tar", "-x", "-C", IMAGE_WORKDIR], await tarOf(spec.workspaceDir)));
    } catch (e) {
      // An unreadable source file or a spawn error: the container exists, so
      // it must still go.
      failed = `filling the executor cell failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (failed) {
      await remove();
      return { ok: false, reason: failed };
    }

    const exec = this.#exec;
    const spawn = this.#spawnBytes;
    const cell: ExecutorCell = {
      name,
      processArgv: (p) => [
        "docker", "exec", "-i",
        "--user", p.user === "agent" ? AGENT_UID : "0:0",
        // Root never starts inside the agent's tree, nor with a writable
        // HOME: bun reads bunfig.toml and .env from both, and the agent could
        // plant one there.
        "-w", p.workdir ?? (p.user === "agent" ? IMAGE_WORKDIR : "/"),
        "-e", `HOME=${p.user === "agent" ? AGENT_HOME : "/root"}`,
        ...Object.entries(p.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        name,
        ...p.argv,
      ],
      async extractWorkspace(caps) {
        // Stop every agent process first: killing the docker client does not
        // stop what it started, and a tree that changes mid-read fails tar.
        // `kill -9 -1` as the agent's uid reaches only the agent's processes.
        await exec(["docker", "exec", "--user", AGENT_UID, name, "sh", "-c", "kill -9 -1"], { cwd: tmpdir(), timeoutMs: 30_000 }).catch(() => undefined);
        // Headers and padding ride on top of the content: 1 KiB per entry plus
        // GNU tar's 10 KiB record is an upper bound, so the stream cap never
        // cuts a tar the caps allow.
        const streamCap = caps.maxBytes + (caps.maxEntries + 4) * 1024 + 10_240;
        // Read as the agent's user: root holds no capabilities in the cell and
        // cannot read a 0600 file the agent made.
        const out = await spawn(["docker", "exec", "--user", AGENT_UID, name, "tar", "-c", "-C", IMAGE_WORKDIR, "."], streamCap, 120_000);
        if (!out.ok) return out;
        const tarred = readSafeTar(out.bytes, caps);
        if (!tarred.ok) return tarred;
        const dir = mkdtempSync(join(tmpdir(), "cp-exec-out-"));
        let bytes = 0;
        try {
          for (const [rel, body] of Object.entries(tarred.files)) {
            const target = join(dir, ...rel.split("/"));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, body);
            bytes += body.length;
          }
        } catch (e) {
          // e.g. a path past Windows' MAX_PATH once the temp prefix is added.
          rmSync(dir, { recursive: true, force: true });
          return { ok: false, reason: `workspace could not be written on this host: ${e instanceof Error ? e.message : String(e)}` };
        }
        return { ok: true, dir, files: Object.keys(tarred.files).length, bytes };
      },
      destroy: remove,
    };
    return { ok: true, cell };
  }

  /** Remove every executor cell, running or not. For the start of a
   *  campaign: a host that crashed leaves `sleep infinity` containers behind.
   *  ponytail: it removes ALL executor cells on this Docker, including a
   *  second campaign's; campaigns run one at a time on a machine (spec §7).
   *  Label cells per campaign if that ever changes. */
  async sweepExecutorCells(): Promise<void> {
    const r = await this.#exec(["docker", "ps", "-aq", "--filter", `label=${EXECUTOR_LABEL}`], { cwd: tmpdir(), timeoutMs: 30_000 });
    for (const id of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      await this.#exec(["docker", "rm", "-f", id], { cwd: tmpdir(), timeoutMs: 60_000 });
    }
  }

  async #baseImage(): Promise<{ ok: true; tag: string } | { ok: false; reason: string }> {
    const p = await this.prepare();
    return p.ok ? { ok: true, tag: this.#base } : p;
  }

  // ── L4 module cells ────────────────────────────────────────────────────

  /** A module host needs bun and node builtins only, so the cell runs the
   *  plain base image: no lockfile, no dependency layer. */
  async prepare(): Promise<Availability> {
    const have = await this.#exec(["docker", "image", "inspect", this.#base], { cwd: tmpdir(), timeoutMs: 30_000 });
    if (have.exitCode === 0) return { ok: true, note: this.#base };
    this.#log(`isolation: pulling ${this.#base} for module cells (first run; needs the network once)`);
    const pulled = await this.#exec(["docker", "pull", this.#base], { cwd: tmpdir(), timeoutMs: 10 * 60_000 });
    if (pulled.exitCode === 0) return { ok: true, note: this.#base };
    return {
      ok: false,
      reason: pulled.timedOut
        ? `Downloading ${this.#base} timed out after 10 minutes. Check the internet connection; modules run once it is there.`
        : `Could not download ${this.#base}: ${lastLine(pulled.stderr) || `exit ${pulled.exitCode}`}`,
    };
  }

  /** `docker run -i`: stdin and stdout are the module protocol. The cell
   *  sees two read-only mounts (the host script and the module), no
   *  network, no capabilities, a read-only root, and the caps.
   *  ponytail: a bind source containing a comma breaks `--mount`; module
   *  and temp paths do not have one. */
  command(spec: ModuleCellSpec): { argv: string[]; env: Record<string, string> } {
    const L = this.#limits;
    return {
      argv: [
        "docker", "run", "-i", "--rm",
        "--name", spec.name,
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,size=64m",
        "--tmpfs", "/root/.bun:rw,size=64m",
        "--memory", `${spec.memoryMb}m`,
        "--cpus", String(L.cpus),
        "--pids-limit", String(L.pids),
        "--label", "cinderpaw=module-host",
        // Bind mounts keep host ownership, and root with every capability
        // dropped cannot read a 0700 dir it does not own (mkdtemp makes
        // exactly those): "CouldntReadCurrentDirectory" on the Linux CI
        // runner, 26 Sep. So run as the owner. Docker Desktop on Windows
        // maps ownership itself, and Windows has no uid.
        ...(process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : []),
        // bun keeps a cache under $HOME, and the root is read-only.
        "-e", "HOME=/tmp",
        "--mount", `type=bind,source=${dirname(spec.hostScript)},target=/host,readonly`,
        "--mount", `type=bind,source=${spec.moduleDir},target=/module,readonly`,
        "--workdir", "/module",
        ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        this.#base,
        "bun", `/host/${basename(spec.hostScript)}`, "/module",
      ],
      // The docker CLI's own environment, not the cell's: the cell gets
      // only the `-e` pairs above.
      env: minimalEnv(),
    };
  }

  async destroy(name: string): Promise<void> {
    await this.#exec(["docker", "rm", "-f", name], { cwd: tmpdir(), timeoutMs: 60_000 });
    // `--rm` may already be removing it (the host exits when its stdin
    // closes, which is what killing the client does), and then `rm -f`
    // returns while it is still there. "Gone" has to mean gone.
    for (let i = 0; i < 50; i++) {
      const r = await this.#exec(["docker", "container", "inspect", "--format", "{{.Id}}", name], {
        cwd: tmpdir(),
        timeoutMs: 15_000,
      });
      if (r.exitCode !== 0) return;
      await Bun.sleep(200);
    }
    this.#log(`isolation: module cell ${name} still listed 10s after removal`);
  }
}

/** The candidate's tree as a tar, built in-process so no host `tar` is
 *  needed (Windows ships bsdtar, Git Bash ships GNU tar, and they disagree
 *  on `C:` paths). `.git` stays behind. Symlinks are skipped: one could name
 *  a host file, and following it would copy that file into the cell.
 *  ponytail: file modes are not kept (everything lands 0644); steps run
 *  through `bun`/`sh`, add modes when a step needs an executable script. */
async function tarOf(dir: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    const rel = relative(dir, full).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    files[rel] = readFileSync(full);
  }
  return new Bun.Archive(files).bytes();
}

/** Default `SpawnBytes`: stdout read as it streams, the process killed the
 *  moment it passes `maxBytes`, so an oversized tar never lands in memory. */
const spawnBytes: SpawnBytes = async (cmd, maxBytes, timeoutMs) => {
  const proc = Bun.spawn({ cmd, env: minimalEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of proc.stdout) {
      total += chunk.length;
      if (total > maxBytes) {
        proc.kill();
        return { ok: false, reason: `output passed ${maxBytes} bytes; stopped` };
      }
      chunks.push(chunk);
    }
    const code = await proc.exited;
    if (code !== 0) return { ok: false, reason: lastLine(await stderr) || `exit ${code}` };
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { ok: true, bytes };
  } finally {
    clearTimeout(timer);
  }
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A path every host can write without surprise: plain ASCII segments (with
 *  `@`, `+`, `,` and inner spaces, so `@types/x.d.ts` and `my file.txt` pass),
 *  no `..`, no drive or stream colon, no backslash, no leading or trailing
 *  space, no trailing dot, no reserved device name. */
function safeRelPath(rel: string): boolean {
  if (rel.length === 0 || rel.length > 200) return false;
  return rel.split("/").every(
    (seg) =>
      /^[A-Za-z0-9._@+,-][A-Za-z0-9._@+, -]*$/.test(seg) &&
      !seg.endsWith(" ") &&
      seg !== "." &&
      seg !== ".." &&
      !seg.endsWith(".") &&
      !WINDOWS_RESERVED.test(seg.split(".")[0]!.trimEnd()),
  );
}

/**
 * Parse a tar that came out of a cell. Hostile by assumption: anything but a
 * regular file or a directory (links, devices, fifos, PAX or GNU long-name
 * headers) refuses the whole archive, as do unsafe names, duplicates, case
 * collisions, a file where a directory is (or the reverse), a bad checksum,
 * and passing the caps. Fail closed: a workspace is all or nothing.
 *
 * ponytail: names over 100 characters arrive as GNU long-name entries and are
 * refused; accept them when a task genuinely needs deep paths.
 */
export function readSafeTar(
  bytes: Uint8Array,
  caps: TarCaps,
): { ok: true; files: Record<string, Uint8Array> } | { ok: false; reason: string } {
  const text = (at: number, len: number) => {
    const slice = bytes.subarray(at, at + len);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
  };
  const fail = (reason: string) => ({ ok: false as const, reason: `workspace refused: ${reason}` });
  // No prototype: a file named `__proto__` must be a key, not a setter.
  const files: Record<string, Uint8Array> = Object.create(null);
  const fileKeys = new Set<string>();
  const dirKeys = new Set<string>();
  let entries = 0;
  let total = 0;

  const claimAncestors = (rel: string): string | null => {
    const parts = rel.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      const a = parts.slice(0, i).join("/");
      if (fileKeys.has(a)) return `"${rel}" sits under a file`;
      dirKeys.add(a);
    }
    return null;
  };

  for (let off = 0; off + 512 <= bytes.length; ) {
    const header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (Number.parseInt(text(off + 148, 8).trim(), 8) !== sum) return fail("corrupted header");
    const size = Number.parseInt(text(off + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) return fail("bad size field");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    let name = text(off, 100);
    if (text(off + 257, 6) === "ustar" && text(off + 263, 2) === "00") {
      const prefix = text(off + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataAt = off + 512;
    if (dataAt + size > bytes.length) return fail("truncated archive");
    off = dataAt + Math.ceil(size / 512) * 512;

    if (++entries > caps.maxEntries) return fail(`more than ${caps.maxEntries} entries`);
    let rel = name;
    while (rel.startsWith("./")) rel = rel.slice(2);
    if (type === "5") {
      rel = rel.replace(/\/+$/, "");
      if (rel === "" || rel === ".") continue;
      if (!safeRelPath(rel)) return fail(`unsafe name "${name}"`);
      if (fileKeys.has(rel.toLowerCase())) return fail(`"${rel}" is both a file and a directory`);
      const bad = claimAncestors(rel);
      if (bad) return fail(bad);
      dirKeys.add(rel.toLowerCase());
      continue;
    }
    if (type !== "0") return fail(`"${name}" is not a plain file (tar type ${type})`);
    if (!safeRelPath(rel)) return fail(`unsafe name "${name}"`);
    const key = rel.toLowerCase();
    if (fileKeys.has(key)) return fail(`"${rel}" appears twice (or twice up to letter case)`);
    if (dirKeys.has(key)) return fail(`"${rel}" is both a file and a directory`);
    const bad = claimAncestors(rel);
    if (bad) return fail(bad);
    total += size;
    if (total > caps.maxBytes) return fail(`more than ${caps.maxBytes} bytes`);
    fileKeys.add(key);
    files[rel] = bytes.slice(dataAt, dataAt + size);
  }
  return { ok: true, files };
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() ?? "";
}
