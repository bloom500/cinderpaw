/**
 * S1.3b2 of the AgentLoop evolution spec: the model relay. Inside the cell
 * it is the agent's only door out: HTTP on loopback in, one JSON line per
 * request on stdout, the answer back on stdin. It decides nothing. These
 * tests run it as a plain bun process (it imports nothing), then once inside
 * a real cell, reached by the agent's user with the network off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation } from "../src/rsi/l3-code/isolation.ts";

const RELAY = join(import.meta.dir, "..", "src", "rsi", "research", "cell-relay.ts");

interface Line {
  type: string;
  id?: number;
  port?: number;
  body?: string;
}

/** Spawns a relay from `argv` and reads its stdout lines. */
function startRelay(argv: string[]) {
  const proc = Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: Line[] = [];
  const waiters: (() => void)[] = [];
  (async () => {
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (raw.startsWith("{")) lines.push(JSON.parse(raw));
        waiters.splice(0).forEach((w) => w());
      }
    }
  })();
  const next = async (type: string, skip = 0): Promise<Line> => {
    for (;;) {
      const found = lines.filter((l) => l.type === type)[skip];
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const answer = (o: unknown) => {
    proc.stdin.write(JSON.stringify(o) + "\n");
    proc.stdin.flush();
  };
  return { proc, lines, next, answer };
}

let running: { proc: { kill(): void } }[] = [];
afterEach(() => {
  running.forEach((r) => r.proc.kill());
  running = [];
});

async function hostRelay() {
  const r = startRelay([process.execPath, RELAY]);
  running.push(r);
  const ready = await r.next("ready");
  return { ...r, url: `http://127.0.0.1:${ready.port}` };
}

const chat = (url: string, body: unknown) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the relay as a plain process", () => {
  test("a chat request goes out as one line and the host's answer comes back as the HTTP response", async () => {
    const r = await hostRelay();
    const pending = chat(r.url, { model: "x", messages: [{ role: "user", content: "hi" }] });
    const req = await r.next("request");
    expect(JSON.parse(req.body!)).toEqual({ model: "x", messages: [{ role: "user", content: "hi" }] });
    r.answer({ type: "response", id: req.id, status: 200, contentType: "application/json", body: '{"choices":[]}' });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"choices":[]}');
  });

  test("anything but POST /v1/chat/completions is refused on the spot, nothing goes out", async () => {
    const r = await hostRelay();
    expect((await fetch(`${r.url}/v1/models`)).status).toBe(404);
    expect((await fetch(`${r.url}/v1/chat/completions`)).status).toBe(404);
    expect((await fetch(`${r.url}/v1/embeddings`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(r.lines.filter((l) => l.type === "request")).toHaveLength(0);
  });

  test("an oversized body is refused on the spot", async () => {
    const r = await hostRelay();
    // Bun's own body limit answers 413 or drops the connection (seen under
    // full-suite load); either way it is refused and nothing goes out.
    const status = await chat(r.url, { messages: ["x".repeat(5_000_000)] }).then((res) => res.status, () => "reset");
    expect([413, "reset"]).toContain(status);
    expect(r.lines.filter((l) => l.type === "request")).toHaveLength(0);
  });

  test("answers out of order reach the right caller", async () => {
    const r = await hostRelay();
    const a = chat(r.url, { n: "a" });
    const b = chat(r.url, { n: "b" });
    const first = await r.next("request", 0);
    const second = await r.next("request", 1);
    r.answer({ type: "response", id: second.id, status: 200, contentType: "text/plain", body: JSON.parse(second.body!).n });
    r.answer({ type: "response", id: first.id, status: 200, contentType: "text/plain", body: JSON.parse(first.body!).n });
    expect(await (await a).text()).toBe("a");
    expect(await (await b).text()).toBe("b");
  });

  test("only the content type the host names reaches the agent", async () => {
    const r = await hostRelay();
    const pending = chat(r.url, {});
    const req = await r.next("request");
    r.answer({ type: "response", id: req.id, status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n", headers: { "set-cookie": "x=1" } });
    const res = await pending;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a model that takes longer than Bun's 10 s idle default still gets its answer through", async () => {
    const r = await hostRelay();
    const pending = chat(r.url, {});
    const req = await r.next("request");
    await Bun.sleep(12_000);
    r.answer({ type: "response", id: req.id, status: 200, contentType: "text/plain", body: "slow but here" });
    expect(await (await pending).text()).toBe("slow but here");
  }, 30_000);

  test("past the cap on waiting requests, more are refused on the spot (503)", async () => {
    const r = await hostRelay();
    const waiting = Array.from({ length: 8 }, () => chat(r.url, {}));
    await r.next("request", 7);
    const extra = await chat(r.url, {});
    expect(extra.status).toBe(503);
    expect(r.lines.filter((l) => l.type === "request")).toHaveLength(8);
    r.proc.stdin.end();
    await Promise.all(waiting);
  });

  test("the size cap counts bytes, not characters", async () => {
    const r = await hostRelay();
    // 1.5 M three-byte characters: 4.5 MB on the wire, under 4 Mi characters.
    // Bun's own body limit may answer 413 or drop the connection; either way
    // it is refused and nothing reaches the host.
    const status = await chat(r.url, { m: "€".repeat(1_500_000) }).then((res) => res.status, () => "reset");
    expect([413, "reset"]).toContain(status);
    expect(r.lines.filter((l) => l.type === "request")).toHaveLength(0);
  });

  test("when the host goes away, a waiting request gets 502 and the relay exits", async () => {
    const r = await hostRelay();
    const pending = chat(r.url, {});
    await r.next("request");
    r.proc.stdin.end();
    expect((await pending).status).toBe(502);
    expect(await r.proc.exited).toBe(0);
  });
});

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    return false;
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-cell-relay: real Docker checks SKIPPED, Docker is not running here");

describe.skipIf(!up)("the relay inside a real cell", () => {
  test("the agent's user reaches the model only through the relay, with the network off", async () => {
    const iso = new DockerIsolation({ exec: bunExec, limits: { pids: 128, memory: "512m", cpus: 1, scratch: "64m" } });
    const empty = () => mkdtempSync(join(tmpdir(), "relay-cell-"));
    const src = empty();
    writeFileSync(join(src, "cell-relay.ts"), await Bun.file(RELAY).text());
    const name = `cp-relay-real-${Date.now()}`;
    const opened = await iso.openExecutorCell({ name, depsDir: join(import.meta.dir, ".."), sourceDir: src, workspaceDir: empty() });
    if (!opened.ok) throw new Error(opened.reason);
    const cell = opened.cell;
    try {
      const relay = startRelay(cell.processArgv({ user: "root", argv: ["bun", "/app/src/cell-relay.ts"], env: {} }));
      running.push(relay);
      const ready = await relay.next("ready");
      const agentScript = `fetch('http://127.0.0.1:${ready.port}/v1/chat/completions',{method:'POST',body:'{"q":1}'}).then(r=>r.text()).then(t=>{console.log(t)})`;
      const agent = Bun.spawn({ cmd: cell.processArgv({ user: "agent", argv: ["bun", "-e", agentScript], env: {} }), stdout: "pipe", stderr: "pipe" });
      const req = await relay.next("request");
      expect(req.body).toBe('{"q":1}');
      relay.answer({ type: "response", id: req.id, status: 200, contentType: "application/json", body: '{"from":"host"}' });
      expect((await new Response(agent.stdout).text()).trim()).toBe('{"from":"host"}');
    } finally {
      await cell.destroy();
    }
  }, 600_000);
});
