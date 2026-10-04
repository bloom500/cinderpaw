/**
 * S1.3b1 of the AgentLoop evolution spec: the executor cell. The real
 * sidecar will run in it (S1.3c), so what it must prove here is the walls,
 * the ownership the agent needs to work, and that what comes OUT is treated
 * as hostile: only plain files with plain names, under a size cap.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type ExecResult } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, readSafeTar, type SpawnBytes } from "../src/rsi/l3-code/isolation.ts";

// ── a hand-built tar, so the hostile shapes can be made on purpose ─────────

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function entry(name: string, body = "", type = "0", link = ""): Uint8Array {
  const data = new TextEncoder().encode(body);
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
  put(name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(data.length, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put(type, 156);
  put(link, 157);
  put("ustar\u000000", 257);
  const sum = h.reduce((a, b) => a + b, 0);
  put(octal(sum, 7) + " ", 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return new Uint8Array([...h, ...padded]);
}

const tar = (...entries: Uint8Array[]): Uint8Array => new Uint8Array([...entries.flatMap((e) => [...e]), ...new Uint8Array(1024)]);
const caps = { maxBytes: 1_000_000, maxEntries: 100 };

describe("readSafeTar: what comes out of a cell", () => {
  test("plain files come out with their content; directories and ./ prefixes are accepted", () => {
    const r = readSafeTar(tar(entry("./", "", "5"), entry("./out/", "", "5"), entry("./out/report.md", "Total: 1,240"), entry("a.txt", "x")), caps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.files).sort()).toEqual(["a.txt", "out/report.md"]);
      expect(new TextDecoder().decode(r.files["out/report.md"])).toBe("Total: 1,240");
    }
  });

  test("names that could escape or misbehave on a Windows host are refused", () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "a\\b", "C:x", "con.txt", "NUL", "lpt1.log", "trailing.", "has space", "a:stream"]) {
      const r = readSafeTar(tar(entry(bad, "x")), caps);
      expect({ bad, ok: r.ok }).toEqual({ bad, ok: false });
    }
  });

  test("links, devices, and long-name or PAX headers are refused", () => {
    for (const type of ["1", "2", "3", "4", "6", "x", "g", "L", "K"]) {
      const r = readSafeTar(tar(entry("thing", "", type, "/etc/passwd")), caps);
      expect({ type, ok: r.ok }).toEqual({ type, ok: false });
    }
  });

  test("duplicates, case collisions and file-versus-directory collisions are refused", () => {
    expect(readSafeTar(tar(entry("a.txt", "1"), entry("a.txt", "2")), caps).ok).toBe(false);
    expect(readSafeTar(tar(entry("A.txt", "1"), entry("a.txt", "2")), caps).ok).toBe(false);
    expect(readSafeTar(tar(entry("a", "1"), entry("a/b", "2")), caps).ok).toBe(false);
    expect(readSafeTar(tar(entry("a/b", "2"), entry("a", "1")), caps).ok).toBe(false);
  });

  test("size and entry caps", () => {
    expect(readSafeTar(tar(entry("big", "x".repeat(2_000))), { maxBytes: 1_000, maxEntries: 10 }).ok).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => entry(`f${i}`, "x"));
    expect(readSafeTar(tar(...many), { maxBytes: 1_000_000, maxEntries: 10 }).ok).toBe(false);
  });

  test("a corrupted header is refused, not guessed", () => {
    const t = tar(entry("a.txt", "x"));
    t[0] = "b".charCodeAt(0); // name changed after the checksum was written
    expect(readSafeTar(t, caps).ok).toBe(false);
  });
});

// ── the cell, over a fake docker ──────────────────────────────────────────

function fakeDocker(answer: (cmd: string[]) => ExecResult | undefined = () => undefined) {
  const calls: string[][] = [];
  const exec = async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    return answer(cmd) ?? { exitCode: 0, stdout: cmd[1] === "version" ? "linux/windows" : "", stderr: "", timedOut: false };
  };
  return { exec, calls };
}

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cell-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const spec = () => ({
  name: "cp-exec-test",
  depsDir: dirWith({ "bun.lock": "{}", "package.json": "{}" }),
  sourceDir: dirWith({ "index.ts": "console.log(1)" }),
  workspaceDir: dirWith({ "data.csv": "a,b" }),
  homeDir: dirWith({ "rsi/champion.json": "{}" }),
});

describe("the executor cell over a fake docker", () => {
  test("walls: no network, no capabilities, read-only root, no mounts, labelled", async () => {
    const { exec, calls } = fakeDocker();
    const r = await new DockerIsolation({ exec }).openExecutorCell(spec());
    expect(r.ok).toBe(true);
    const create = calls.find((c) => c[1] === "create")!;
    for (const flag of ["--network", "none", "--cap-drop", "ALL", "no-new-privileges", "--read-only", "cinderpaw=agent-exec", "cp-exec-test"]) {
      expect(create).toContain(flag);
    }
    expect(create.some((a) => a.startsWith("/app/work:") && a.includes("uid=1000"))).toBe(true);
    expect(create).not.toContain("--mount");
    expect(create).not.toContain("-v");
  });

  test("the workspace and home go in as the agent's user, the source as root", async () => {
    const { exec, calls } = fakeDocker();
    await new DockerIsolation({ exec }).openExecutorCell(spec());
    const tarInto = (target: string) => calls.find((c) => c.includes("tar") && c.includes(target))!;
    expect(tarInto("/app/work")).toContain("1000:1000");
    expect(tarInto("/tmp/home")).toContain("1000:1000");
    expect(tarInto("/app/src")).not.toContain("1000:1000");
  });

  test("a process runs as the agent's user with only the env it is given", async () => {
    const { exec } = fakeDocker();
    const r = await new DockerIsolation({ exec }).openExecutorCell(spec());
    if (!r.ok) throw new Error(r.reason);
    const argv = r.cell.processArgv({ user: "agent", argv: ["bun", "/app/src/index.ts"], env: { CINDERPAW_HOME: "/tmp/home" } });
    expect(argv.slice(0, 3)).toEqual(["docker", "exec", "-i"]);
    expect(argv).toContain("1000:1000");
    expect(argv).toContain("CINDERPAW_HOME=/tmp/home");
    expect(argv.filter((a) => a === "-e")).toHaveLength(2); // the one pair + HOME
  });

  test("no Docker: refused with the reason a person reads, nothing created", async () => {
    const { exec, calls } = fakeDocker((c) => (c[1] === "version" ? { exitCode: 1, stdout: "", stderr: "not found", timedOut: false } : undefined));
    const r = await new DockerIsolation({ exec }).openExecutorCell(spec());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Docker is not installed");
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  test("a failed copy-in removes the container and says why", async () => {
    const { exec, calls } = fakeDocker((c) => (c.includes("tar") ? { exitCode: 2, stdout: "", stderr: "tar: no space", timedOut: false } : undefined));
    const r = await new DockerIsolation({ exec }).openExecutorCell(spec());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no space");
    expect(calls.some((c) => c[1] === "rm" && c.includes("cp-exec-test"))).toBe(true);
  });

  test("the workspace comes out through readSafeTar into a fresh directory", async () => {
    const { exec } = fakeDocker();
    const spawnBytes: SpawnBytes = async () => ({ ok: true, bytes: tar(entry("./out.txt", "done")) });
    const r = await new DockerIsolation({ exec, spawnBytes }).openExecutorCell(spec());
    if (!r.ok) throw new Error(r.reason);
    const out = await r.cell.extractWorkspace(caps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(readFileSync(join(out.dir, "out.txt"), "utf8")).toBe("done");
  });

  test("a hostile workspace is refused, nothing is written", async () => {
    const { exec } = fakeDocker();
    const spawnBytes: SpawnBytes = async () => ({ ok: true, bytes: tar(entry("../../escape.txt", "x")) });
    const r = await new DockerIsolation({ exec, spawnBytes }).openExecutorCell(spec());
    if (!r.ok) throw new Error(r.reason);
    const out = await r.cell.extractWorkspace(caps);
    expect(out.ok).toBe(false);
  });

  test("sweep removes only containers carrying the executor label", async () => {
    const { exec, calls } = fakeDocker((c) => (c[1] === "ps" ? { exitCode: 0, stdout: "aaa\nbbb\n", stderr: "", timedOut: false } : undefined));
    await new DockerIsolation({ exec }).sweepExecutorCells();
    expect(calls.find((c) => c[1] === "ps")).toContain("label=cinderpaw=agent-exec");
    expect(calls.filter((c) => c[1] === "rm").map((c) => c.at(-1))).toEqual(["aaa", "bbb"]);
  });
});

// ── against real Docker ───────────────────────────────────────────────────

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    return false;
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-executor-cell: real Docker checks SKIPPED, Docker is not running here");

describe.skipIf(!up)("the executor cell against real Docker", () => {
  test("the agent's user can work in its workspace, cannot touch the source or the network, and its files come out", async () => {
    const pkg = join(import.meta.dir, "..");
    const iso = new DockerIsolation({ exec: bunExec, limits: { pids: 128, memory: "512m", cpus: 1, scratch: "64m" } });
    const s = { ...spec(), name: `cp-exec-real-${Date.now()}`, depsDir: pkg };
    const r = await iso.openExecutorCell(s);
    if (!r.ok) throw new Error(r.reason);
    try {
      const run = async (script: string) => {
        const argv = r.cell.processArgv({ user: "agent", argv: ["sh", "-c", script], env: {} });
        const p = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
        const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        return { out: out.trim(), code };
      };
      expect((await run("id -u")).out).toBe("1000");
      expect((await run("cat data.csv && echo done > out.txt && mkdir -p sub && echo deep > sub/x.md && cat /tmp/home/rsi/champion.json")).code).toBe(0);
      expect((await run("echo pwned > /app/src/index.ts")).code).not.toBe(0);
      expect((await run("bun -e \"fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(3))\"")).code).toBe(3);
      const out = await r.cell.extractWorkspace(caps);
      if (!out.ok) throw new Error(out.reason);
      expect(readFileSync(join(out.dir, "out.txt"), "utf8").trim()).toBe("done");
      expect(readFileSync(join(out.dir, "sub", "x.md"), "utf8").trim()).toBe("deep");
      expect(existsSync(join(out.dir, "data.csv"))).toBe(true);
    } finally {
      await r.cell.destroy();
    }
    const gone = await bunExec(["docker", "container", "inspect", s.name], { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(gone.exitCode).not.toBe(0);
  }, 600_000);
});
