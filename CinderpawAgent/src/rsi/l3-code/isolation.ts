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
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  run(pkgDir: string, steps: IsolatedStep[]): Promise<ExecResult[]>;
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

export interface DockerIsolationOptions {
  exec: ExecFn;
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

const timedOut = (): ExecResult => ({ exitCode: -1, stdout: "", stderr: "killed: sandbox wall clock", timedOut: true });

export class DockerIsolation implements IsolationBackend, ModuleCell {
  readonly name = "docker";
  readonly #exec: ExecFn;
  readonly #limits: IsolationLimits;
  readonly #scratch: string;
  readonly #base: string;
  readonly #log: (line: string) => void;

  constructor(opts: DockerIsolationOptions) {
    this.#exec = opts.exec;
    this.#limits = { ...DEFAULT_ISOLATION_LIMITS, ...opts.limits };
    this.#scratch = opts.scratchDir ?? join(tmpdir(), "cinderpaw-code-rsi-image");
    // The same bun that runs this agent, not a floating `1-slim`: a
    // candidate's tests must pass under the version the host verified.
    this.#base = opts.baseImage ?? `oven/bun:${Bun.version}-slim`;
    this.#log = opts.log ?? (() => {});
  }

  async available(): Promise<Availability> {
    const r = await this.#exec(["docker", "version", "--format", "{{.Server.Os}}/{{.Client.Os}}"], {
      cwd: tmpdir(),
      timeoutMs: 15_000,
    });
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

  async run(pkgDir: string, steps: IsolatedStep[]): Promise<ExecResult[]> {
    const image = await this.ensureImage(pkgDir);
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

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() ?? "";
}
