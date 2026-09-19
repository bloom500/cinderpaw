/**
 * The cell a code candidate runs in (`isolation.ts`).
 *
 * Two layers. Over a fake exec: the exact docker arguments (no network, no
 * capabilities, read-only root, tmpfs scratch, limits), kill-on-timeout,
 * remove-on-every-path, and the words a person reads when Docker is missing.
 * Against real Docker, when it answers: the walls hold. Network is off, the
 * host filesystem is not there, a fork bomb hits the pid limit, a runaway
 * step is killed and the container is gone afterwards. Those probes are the
 * spec's §10 list and they skip, loudly, when Docker is not running.
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type ExecFn, type ExecResult } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation } from "../src/rsi/l3-code/isolation.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: "", stderr, timedOut: false });

function fakeDocker(answers: (cmd: string[]) => ExecResult | undefined) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    return answers(cmd) ?? ok();
  };
  return { exec, calls };
}

const sub = (cmd: string[]) => cmd.slice(0, 3).join(" ");

describe("DockerIsolation over a fake exec", () => {
  test("available(): the three ways Docker is not there, each with an instruction", async () => {
    const notInstalled = new DockerIsolation({ exec: async () => fail("'docker' is not recognized as an internal or external command") });
    const a = await notInstalled.available();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toContain("not installed");

    const notRunning = new DockerIsolation({ exec: async () => fail("error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.") });
    const b = await notRunning.available();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toContain("Start Docker Desktop");

    const windowsContainers = new DockerIsolation({ exec: async () => ok("windows/windows\n") });
    const c = await windowsContainers.available();
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("Linux containers");

    const fine = new DockerIsolation({ exec: async () => ok("linux/windows\n") });
    const d = await fine.available();
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.note).toContain("Linux VM");
  });

  test("run(): the cell has no network, no capabilities, a read-only root and limits; source goes in by copy", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "iso-pkg-"));
    try {
      writeFileSync(join(pkg, "bun.lock"), "lock\n");
      writeFileSync(join(pkg, "package.json"), "{}\n");
      const { exec, calls } = fakeDocker((cmd) => {
        if (sub(cmd) === "docker image inspect") return ok(); // image exists
        if (sub(cmd).startsWith("docker create")) return ok("cid123\n");
        if (cmd[0] === "docker" && cmd[1] === "exec") return ok(" 3 pass\n");
        return undefined;
      });
      const iso = new DockerIsolation({ exec, limits: { memory: "1g", cpus: 1, pids: 64, scratch: "256m" } });
      const out = await iso.run(pkg, [
        { name: "tests", argv: ["bun", "test"], timeoutMs: 1000 },
        { name: "tsc", argv: ["bunx", "tsc", "--noEmit"], timeoutMs: 1000 },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0]!.stdout).toContain("3 pass");

      const create = calls.find((c) => c[1] === "create")!;
      const joined = create.join(" ");
      expect(joined).toContain("--network none");
      expect(joined).toContain("--cap-drop ALL");
      expect(joined).toContain("--security-opt no-new-privileges");
      expect(joined).toContain("--read-only");
      expect(joined).toContain("--memory 1g");
      expect(joined).toContain("--cpus 1");
      expect(joined).toContain("--pids-limit 64");
      expect(joined).toContain("size=256m");
      // No `-v` / `--mount`: the host filesystem is not in the cell.
      expect(create).not.toContain("-v");
      expect(create).not.toContain("--mount");
      // Copied in as a tar on stdin, not mounted (and not `docker cp`, which a
      // read-only root refuses).
      expect(calls.some((c) => c.join(" ") === "docker exec -i cid123 tar -x -C /app/work")).toBe(true);
      expect(calls.some((c) => c[1] === "cp")).toBe(false);
      // Every step runs in the cell, in order, and the cell is removed last.
      const execs = calls.filter((c) => c[1] === "exec" && c[2] === "-w").map((c) => c.slice(5).join(" "));
      expect(execs).toEqual(["bun test", "bunx tsc --noEmit"]);
      expect(calls[calls.length - 1]!.slice(0, 3)).toEqual(["docker", "rm", "-f"]);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  test("run(): a step past its time kills the WHOLE cell; later steps are reported dead; rm -f still runs", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "iso-pkg-"));
    try {
      writeFileSync(join(pkg, "bun.lock"), "lock\n");
      const { exec, calls } = fakeDocker((cmd) => {
        if (sub(cmd) === "docker image inspect") return ok();
        if (sub(cmd).startsWith("docker create")) return ok("cid9\n");
        if (cmd[1] === "exec" && cmd.includes("test")) return { exitCode: -2, stdout: "", stderr: "", timedOut: true };
        return undefined;
      });
      const iso = new DockerIsolation({ exec });
      const out = await iso.run(pkg, [
        { name: "tests", argv: ["bun", "test"], timeoutMs: 5 },
        { name: "tsc", argv: ["bunx", "tsc"], timeoutMs: 5 },
      ]);
      expect(out[0]!.timedOut).toBe(true);
      expect(out[1]!.timedOut).toBe(true);
      expect(calls.some((c) => c[1] === "kill" && c[2] === "cid9")).toBe(true);
      // tsc never ran: the cell was dead.
      expect(calls.filter((c) => c[1] === "exec" && c[2] === "-w")).toHaveLength(1);
      expect(calls[calls.length - 1]!.slice(0, 3)).toEqual(["docker", "rm", "-f"]);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  test("ensureImage(): a missing lockfile refuses; a known image is reused; a new one is built from OUR lockfile", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "iso-pkg-"));
    try {
      const none = new DockerIsolation({ exec: async () => ok() });
      const r0 = await none.ensureImage(pkg);
      expect(r0.ok).toBe(false);

      writeFileSync(join(pkg, "bun.lock"), "lock-a\n");
      writeFileSync(join(pkg, "package.json"), "{}\n");
      const scratch = mkdtempSync(join(tmpdir(), "iso-ctx-"));
      const { exec, calls } = fakeDocker((cmd) => (sub(cmd) === "docker image inspect" ? fail("No such image") : undefined));
      const iso = new DockerIsolation({ exec, scratchDir: scratch });
      const r1 = await iso.ensureImage(pkg);
      expect(r1.ok).toBe(true);
      const build = calls.find((c) => c[1] === "build")!;
      expect(build).toBeDefined();
      const ctx = build[build.length - 1]!;
      expect(existsSync(join(ctx, "Dockerfile"))).toBe(true);
      expect(existsSync(join(ctx, "bun.lock"))).toBe(true);
      const dockerfile = require("node:fs").readFileSync(join(ctx, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("--frozen-lockfile --ignore-scripts");
      rmSync(scratch, { recursive: true, force: true });
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });
});

// ── Real Docker, when it answers ──────────────────────────────────────────
// The probes use THIS package's manifest and lockfile, so the image under
// test is the one L3 really builds. bun writes no lockfile for a package with
// no dependencies, and a hand-written one fails `--frozen-lockfile`.

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    // No `docker` binary at all (the macOS CI runner): bun's spawn throws
    // instead of returning an exit code, and that is still "not up".
    return false;
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-isolation: real Docker probes SKIPPED — Docker is not running here");

describe.skipIf(!up)("DockerIsolation against real Docker (spec §10 probes)", () => {
  const pkg = mkdtempSync(join(tmpdir(), "iso-real-"));
  for (const f of ["package.json", "bun.lock"]) copyFileSync(join(import.meta.dir, "..", f), join(pkg, f));
  writeFileSync(join(pkg, "secret-on-host.txt"), "should never be readable from inside\n");
  const iso = new DockerIsolation({ exec: bunExec, limits: { pids: 64, memory: "512m", cpus: 1, scratch: "128m" }, log: (l) => console.error(l) });

  test("network is off, the host is not there, a fork bomb hits the pid wall, a runaway is killed", async () => {
    const out = await iso.run(pkg, [
      { name: "net", argv: ["bun", "-e", "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(3))"], timeoutMs: 30_000 },
      { name: "host", argv: ["sh", "-c", "ls /host 2>/dev/null; test -e /app/work/secret-on-host.txt && cat /app/work/secret-on-host.txt; ls / | grep -c Users"], timeoutMs: 30_000 },
      // Deps live in /app/node_modules, the tree in /app/work: tsc must resolve.
      { name: "tsc", argv: ["bunx", "tsc", "--version"], timeoutMs: 60_000 },
      { name: "fork", argv: ["sh", "-c", "i=0; while [ $i -lt 200 ]; do sleep 30 & i=$((i+1)); done; wait"], timeoutMs: 30_000 },
    ]);
    // A second cell: the fork bomb's sleeps keep the first one's pid table
    // full, so nothing after them could even start (measured: exec exit 128).
    const wall = await iso.run(pkg, [
      { name: "runaway", argv: ["sh", "-c", "while true; do :; done"], timeoutMs: 3_000 },
      { name: "after", argv: ["true"], timeoutMs: 5_000 },
    ]);
    // 1. No route out.
    expect({ code: out[0]!.exitCode, err: out[0]!.stderr }).toEqual({ code: 3, err: expect.any(String) });
    // 2. The copied file IS there (that is the candidate's own tree); the host
    //    is not: no /Users, no drive letters, nothing above /app/work.
    expect(out[1]!.stdout).toContain("should never be readable");
    expect(out[1]!.stdout.trim().split("\n").pop()).toBe("0");
    // 3. tsc resolves from the image's node_modules, offline.
    expect({ code: out[2]!.exitCode, out: out[2]!.stdout + out[2]!.stderr }).toEqual({ code: 0, out: expect.stringMatching(/Version/) });
    // 4. The pid limit bit: some sleeps failed to spawn.
    expect(out[3]!.stderr.toLowerCase()).toMatch(/resource|fork|cannot/);
    // 5. Killed at the wall, and everything after it is dead too.
    expect({ t: wall[0]!.timedOut, c: wall[0]!.exitCode, e: wall[0]!.stderr }).toEqual({ t: true, c: expect.any(Number), e: expect.any(String) });
    expect(wall[1]!.timedOut).toBe(true);
    // 6. Nothing left running.
    const left = await bunExec(["docker", "ps", "-aq", "--filter", "label=cinderpaw=code-rsi"], { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(left.stdout.trim()).toBe("");
    rmSync(pkg, { recursive: true, force: true });
  }, 15 * 60_000);
});
