/**
 * The cell an L4 module runs in (`DockerIsolation` as a `ModuleCell`).
 *
 * Until 26 Sep 2026 generated module code ran as a plain Bun process on the
 * host, and the only barrier was a lexical wall that
 * `globalThis["fe" + "tch"]` walks past. Two layers here. Over a fake exec:
 * the exact `docker run` a module gets (no network, no capabilities, a
 * read-only root, the module and the host script mounted read-only, caps,
 * nothing of the host's environment). Against real Docker, when it answers:
 * the bypass module passes the wall and still reaches nothing, and the cell
 * is gone after stop. The live part skips, loudly, when Docker is not up.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type ExecFn, type ExecResult } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation } from "../src/rsi/l3-code/isolation.ts";
import { spawnModuleHost } from "../src/rsi/l4-modules/module-host-client.ts";
import { wallCheck } from "../src/rsi/l4-modules/module-wall.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

function recorder(answer: (cmd: string[]) => ExecResult = () => ok()) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd) => (calls.push(cmd), answer(cmd));
  return { exec, calls };
}

describe("DockerIsolation as a module cell, over a fake exec", () => {
  test("command(): no network, no capabilities, read-only root and mounts, caps, only the given env", () => {
    const cell = new DockerIsolation({ exec: recorder().exec, baseImage: "oven/bun:test-slim", limits: { cpus: 1, pids: 128 } });
    process.env["CINDERPAW_CELL_SENTINEL"] = "must-not-cross";
    try {
      const { argv, env } = cell.command({
        hostScript: join("tmp", "h", "host.ts"),
        moduleDir: join("mods", "m1"),
        env: { CINDERPAW_MODULE_SEED: "7" },
        memoryMb: 512,
        name: "cinderpaw-module-abc",
      });
      const flag = (f: string) => argv[argv.indexOf(f) + 1];
      expect(argv.slice(0, 4)).toEqual(["docker", "run", "-i", "--rm"]);
      expect(flag("--name")).toBe("cinderpaw-module-abc");
      expect(flag("--network")).toBe("none");
      expect(flag("--cap-drop")).toBe("ALL");
      expect(argv).toContain("--read-only");
      expect(flag("--memory")).toBe("512m");
      expect(flag("--pids-limit")).toBe("128");
      const mounts = argv.filter((_, i) => argv[i - 1] === "--mount");
      expect(mounts).toEqual([
        `type=bind,source=${join("tmp", "h")},target=/host,readonly`,
        `type=bind,source=${join("mods", "m1")},target=/module,readonly`,
      ]);
      // The cell's environment is exactly the -e pairs.
      expect(argv.filter((_, i) => argv[i - 1] === "-e")).toEqual(["CINDERPAW_MODULE_SEED=7"]);
      expect(argv.slice(-4)).toEqual(["oven/bun:test-slim", "bun", "/host/host.ts", "/module"]);
      // The docker CLI's own environment is the allowlist, not ours.
      expect(env["CINDERPAW_CELL_SENTINEL"]).toBeUndefined();
      expect(argv.join(" ")).not.toContain("must-not-cross");
    } finally {
      delete process.env["CINDERPAW_CELL_SENTINEL"];
    }
  });

  test("prepare(): a present image is reused; a missing one is pulled once; a failed pull says so", async () => {
    const have = recorder();
    expect(await new DockerIsolation({ exec: have.exec, baseImage: "img" }).prepare()).toEqual({ ok: true, note: "img" });
    expect(have.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["docker image inspect"]);

    const missing = recorder((cmd) => (cmd[1] === "image" ? fail("No such image") : ok()));
    expect((await new DockerIsolation({ exec: missing.exec, baseImage: "img" }).prepare()).ok).toBe(true);
    expect(missing.calls.map((c) => c[1])).toEqual(["image", "pull"]);

    const offline = recorder((cmd) => fail(cmd[1] === "pull" ? "dial tcp: lookup registry-1.docker.io: no such host" : "No such image"));
    const r = await new DockerIsolation({ exec: offline.exec, baseImage: "img" }).prepare();
    expect(r).toEqual({ ok: false, reason: "Could not download img: dial tcp: lookup registry-1.docker.io: no such host" });
  });

  test("destroy(): by name, forced, and it waits until the cell is really gone", async () => {
    // `--rm` can be mid-removal when `rm -f` returns; measured 26 Sep.
    let inspected = 0;
    const { exec, calls } = recorder((cmd) =>
      cmd[2] === "inspect" ? (++inspected < 3 ? ok("abc123") : fail("No such container")) : ok(),
    );
    await new DockerIsolation({ exec }).destroy("cinderpaw-module-abc");
    expect(calls[0]).toEqual(["docker", "rm", "-f", "cinderpaw-module-abc"]);
    expect(inspected).toBe(3);
  });
});

// ── Real Docker, when it answers ──────────────────────────────────────────

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    return false; // no docker binary at all
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-module-cell: real Docker probes SKIPPED — Docker is not running here");

/** The checkpoint's bypass, made into a probe: it passes the lexical wall
 *  and then tries the network, the environment, its own directory and a
 *  file on the host. */
const PROBE = `
const g = globalThis as any;
const B = g["B" + "un"];
const P = g["pro" + "cess"];
export default {
  async probe(p: { hostFile: string }) {
    let net = "reached";
    try { await g["fe" + "tch"]("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }); } catch { net = "blocked"; }
    let wrote = true;
    try { await B.write("/module/pwned.txt", "x"); } catch { wrote = false; }
    const hostFile = await B.file(p.hostFile).exists();
    return { net, env: Object.keys(P.env), wrote, hostFile, ran: (() => {}).constructor("return 7")() };
  },
};
`;

describe.skipIf(!up)("module cell against real Docker", () => {
  test("the bypass passes the wall and still reaches nothing; the cell is gone after stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-cell-probe-"));
    const secretDir = mkdtempSync(join(tmpdir(), "cinderpaw-cell-secret-"));
    const secret = join(secretDir, "secret.txt");
    writeFileSync(secret, "the user's file\n");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "mod-probe", seam: "retrieval_strategy", entry: "module.ts" }));
    writeFileSync(join(dir, "module.ts"), PROBE);
    expect(wallCheck(PROBE)).toEqual({ ok: true });
    process.env["CINDERPAW_CELL_SENTINEL"] = "must-not-cross";
    try {
      const res = await spawnModuleHost({ moduleDir: dir, limits: { timeoutMs: 20_000, maxRssMb: 256 } });
      if (!res.ok) throw new Error(res.reason);
      const reply = await res.host.request("probe", { hostFile: secret });
      res.host.stop();
      await res.host.exited;
      expect(reply.ok).toBe(true);
      const out = (reply as { result: { net: string; env: string[]; wrote: boolean; hostFile: boolean; ran: number } }).result;
      expect(out.ran).toBe(7); // the code DID run: this is the cell stopping it, not the wall
      expect(out.net).toBe("blocked");
      expect(out.env).toContain("CINDERPAW_MODULE_SEED");
      expect(out.env).not.toContain("CINDERPAW_CELL_SENTINEL");
      expect(out.wrote).toBe(false);
      expect(out.hostFile).toBe(false);
      const left = await bunExec(["docker", "ps", "-aq", "--filter", "label=cinderpaw=module-host"], { cwd: tmpdir(), timeoutMs: 15_000 });
      expect(left.stdout.trim()).toBe("");
    } finally {
      delete process.env["CINDERPAW_CELL_SENTINEL"];
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
