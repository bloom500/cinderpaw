/**
 * S1.3b2 of the AgentLoop evolution spec (2026-10-04, §4.4): the model relay.
 * It runs INSIDE an executor cell (`DockerIsolation.openExecutorCell`), as
 * root, while the agent runs as uid 1000. The cell has no network; this is
 * the agent's only way to a model.
 *
 * RESEARCH ONLY (spec §4.7). Never started by a user install.
 *
 * It decides nothing. It listens on 127.0.0.1, turns each
 * `POST /v1/chat/completions` into one stdout line and returns whatever the
 * host answers on stdin. Budget, model choice, streaming (SSE) and every
 * refusal are the host's business (`task-budget.ts`, the executor). What it
 * does refuse on the spot, without telling the host: any other path or
 * method, and a body over MAX_BODY, so the agent's shell cannot use it for
 * anything but chat and cannot fill the host's line buffer.
 *
 * Protocol (one JSON object per line):
 *   out  {"type":"ready","port":N}                     once, when listening
 *   out  {"type":"request","id":N,"body":"<text>"}     per chat request
 *   in   {"type":"response","id":N,"status":S,"contentType":"...","body":"<text>"}
 * stdin closing means the host is gone: waiting requests get 502, the relay
 * exits 0.
 *
 * Self-contained on purpose: it imports only node builtins, so it runs from
 * a copied file with nothing else around it.
 */

import { createInterface } from "node:readline";

const MAX_BODY = 4 * 1024 * 1024;

const pending = new Map<number, (r: Response) => void>();
let nextId = 1;

const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) return new Response("request too large", { status: 413 });
    const body = await req.text();
    if (body.length > MAX_BODY) return new Response("request too large", { status: 413 });
    const id = nextId++;
    const answered = new Promise<Response>((resolve) => pending.set(id, resolve));
    send({ type: "request", id, body });
    return answered;
  },
});

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let msg: { type?: string; id?: number; status?: number; contentType?: string; body?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const resolve = msg.type === "response" && typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!resolve) return;
    pending.delete(msg.id!);
    // Only the content type crosses: no cookies, no other host headers.
    resolve(new Response(msg.body ?? "", { status: msg.status ?? 502, headers: { "content-type": msg.contentType ?? "text/plain" } }));
  })
  .on("close", () => {
    for (const resolve of pending.values()) resolve(new Response("model relay: host gone", { status: 502 }));
    pending.clear();
    // Let the 502s flush before the server goes.
    setTimeout(() => {
      server.stop(true);
      process.exit(0);
    }, 50);
  });

send({ type: "ready", port: server.port });
