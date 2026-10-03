import { expect, test } from "bun:test";

const transportUrl = new URL("../src/transports/tauri.ts", import.meta.url).href;

async function exchange(input: string, handler: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { TauriTransport } from ${JSON.stringify(transportUrl)};
    const transport = new TauriTransport();
    transport.onMessage(${handler});
    transport.start();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    child.stdin.write(input);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code, stderr,
      events: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    };
  } finally {
    clearTimeout(timer);
  }
}

test("a synchronous handler failure is reported and the next message still runs", async () => {
  const result = await exchange(
    '{"type":"ping","id":"bad"}\n{"type":"ping","id":"good"}\n',
    `(msg) => {
      if (msg.id === "bad") throw new Error("handler failed");
      transport.send({ type: "error", id: msg.id, message: "handled" });
    }`,
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.events).toContainEqual({ type: "error", id: "bad", message: "handler error: Error: handler failed" });
  expect(result.events).toContainEqual({ type: "error", id: "good", message: "handled" });
});

test("stdin closing drains every queued response before exiting", async () => {
  const input = Array.from({ length: 32 }, (_, id) => JSON.stringify({ type: "ping", id: String(id) })).join("\n");
  const result = await exchange(input, `(msg) => {
    transport.send({ type: "error", id: msg.id, message: "x".repeat(256 * 1024) });
  }`);
  expect(result.code).toBe(0);
  expect(result.events.map(event => event.id)).toEqual(Array.from({ length: 32 }, (_, id) => String(id)));
});

test("stdin closing waits for async handlers and reports rejected handlers", async () => {
  const result = await exchange('{"type":"ping","id":"async"}\n', `async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error("async failure");
  }`);
  expect(result.code).toBe(0);
  expect(result.events).toEqual([{ type: "error", id: "async", message: "handler error: Error: async failure" }]);
});

test("a malformed final line is reported before exit", async () => {
  const result = await exchange('{invalid', `() => {}`);
  expect(result.code).toBe(0);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].message).toContain("malformed inbound message");
});
