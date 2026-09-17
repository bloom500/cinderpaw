/**
 * artifact_send: an artifact made from a chat app goes back to that chat app,
 * and never without a person saying yes.
 *
 * The gate is the part worth pinning. This is the first tool that puts local
 * bytes on a third party's server, so each way of NOT getting a clear yes (a
 * no, a timeout, nobody there) must end with nothing sent. The other half is
 * the fresh-install promise: a chat app that cannot carry files still gets a
 * sentence, not silence.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { createArtifactSendTool, type FileDelivery } from "../src/tools/builtin/artifact.ts";
import { ConnectorManager, type AgentLike } from "../src/transports/connectors.ts";
import { registerTransport, transportFor, type OutboundFile } from "../src/transports/registry.ts";
import { TelegramConnector } from "../src/transports/telegram.ts";

function setup(channel: ReturnType<FileDelivery["fileChannel"]>) {
  const db = openDatabase(":memory:");
  const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-send-")));
  const artifact = store.create({
    kind: "markdown",
    title: "Q3: report",
    content: "# Q3",
    workspaceId: "ws-1",
    sessionId: "telegram:7:7",
  });
  const files: OutboundFile[] = [];
  const texts: string[] = [];
  const delivery: FileDelivery = {
    fileChannel: () => channel,
    sendFile: async (_s, f) => {
      files.push(f);
    },
    send: async (_s, t) => {
      texts.push(t);
    },
  };
  const tool = createArtifactSendTool({ store, delivery });
  const questions: string[] = [];
  const run = (answer: (() => Promise<string>) | null) =>
    tool.execute({ id: artifact.id }, {
      sessionId: "telegram:7:7",
      ...(answer
        ? {
            askUser: {
              ask: async (qs: { question: string }[]) => {
                questions.push(qs[0]!.question);
                return [{ question: qs[0]!.question, selected: [await answer()] }];
              },
            },
          }
        : {}),
    } as never);
  return { run, files, texts, questions };
}

describe("artifact_send", () => {
  test("a yes sends the file, named for a person and not for our data model", async () => {
    const t = setup("ready");
    const res = await t.run(async () => "Yes, send it");
    expect(res.ok).toBe(true);
    expect(t.files).toHaveLength(1);
    // The colon is illegal in a Windows filename; the recipient saves this file.
    expect(t.files[0]!.name).toBe("Q3- report.md");
    expect(new TextDecoder().decode(t.files[0]!.data)).toBe("# Q3");
    // The approval names the file and the platform, or it approves nothing.
    expect(t.questions[0]).toContain("Q3- report.md");
    expect(t.questions[0]).toContain("Telegram");
  });

  test("a no sends nothing", async () => {
    const t = setup("ready");
    const res = await t.run(async () => "No");
    expect(res.ok).toBe(false);
    expect(t.files).toHaveLength(0);
  });

  test("no answer is not a yes", async () => {
    const t = setup("ready");
    const res = await t.run(() => Promise.reject(new Error("timed out")));
    expect(res.ok).toBe(false);
    expect(t.files).toHaveLength(0);
  });

  test("with nobody there to ask, it refuses instead of approving itself", async () => {
    const t = setup("ready");
    const res = await t.run(null);
    expect(res.ok).toBe(false);
    expect(t.files).toHaveLength(0);
  });

  test("a chat app with no file channel is told where the artifact is, without asking", async () => {
    const t = setup("no_file_channel");
    const res = await t.run(async () => "Yes, send it");
    expect(t.files).toHaveLength(0);
    expect(t.questions).toHaveLength(0);
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toContain("Q3: report");
    expect(t.texts[0]).toContain("Artifacts panel");
    expect(res.data).toMatchObject({ delivered: false });
  });

  test("outside a chat app it says what to do instead", async () => {
    const t = setup("not_connected");
    const res = await t.run(async () => "Yes, send it");
    expect(res.ok).toBe(false);
    expect(res.content).toContain("artifact_export");
    expect(t.texts).toHaveLength(0);
  });
});

describe("ConnectorManager.fileChannel", () => {
  test("reads the capability off the running connector", async () => {
    // Doubles under real catalog ids, put back afterwards. A made-up id would
    // stay registered for every later test file, and the catalog test rightly
    // fails on a transport with no catalog entry.
    const realTelegram = transportFor("telegram")!;
    const realIrc = transportFor("irc")!;
    const base = {
      async start() {},
      async stop() {},
      health: () => ({ live: true }),
      async send() {},
    };
    registerTransport("telegram", () => ({ ...base, async sendFile() {} }));
    registerTransport("irc", () => ({ ...base }));
    const mgr = new ConnectorManager({ registerProfile: () => {} } as unknown as AgentLike, () => {});
    try {
      await mgr.applyRows([
        { id: "telegram", enabled: true, secrets: {} },
        { id: "irc", enabled: true, secrets: {} },
      ]);
      expect(mgr.fileChannel("telegram:1:2")).toBe("ready");
      expect(mgr.fileChannel("irc:1:2")).toBe("no_file_channel");
      expect(mgr.fileChannel("tauri:main")).toBe("not_connected");
    } finally {
      await mgr.stopAll();
      registerTransport("telegram", realTelegram);
      registerTransport("irc", realIrc);
    }
  });
});

describe("Telegram sendFile", () => {
  async function started(onCall: (method: string, init?: RequestInit) => Response) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      if (method === "getMe") return Response.json({ ok: true, result: { id: 99 } });
      if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({ ok: true, result: [] });
      }
      return onCall(method, init);
    }) as typeof fetch;
    const c = new TelegramConnector();
    await c.start({
      row: { id: "telegram", enabled: true, allowlist: ["7"] },
      secrets: { TELEGRAM_BOT_TOKEN: "t" },
      log: () => {},
      agent: {},
      askRouter: { registerSender: () => {}, unregisterSender: () => {} },
      runs: null,
    } as unknown as Parameters<TelegramConnector["start"]>[0]);
    return {
      c,
      done: async () => {
        await c.stop();
        globalThis.fetch = realFetch;
      },
    };
  }

  test("uploads the bytes as a named document into the session's chat", async () => {
    let form: FormData | null = null;
    const { c, done } = await started((method, init) => {
      if (method === "sendDocument") form = init?.body as FormData;
      return Response.json({ ok: true });
    });
    try {
      await c.sendFile("telegram:-100:7", {
        name: "report.md",
        data: new TextEncoder().encode("# hi"),
        caption: "Report (v1)",
      });
      const f = form as unknown as FormData;
      expect(f.get("chat_id")).toBe("-100");
      expect(f.get("caption")).toBe("Report (v1)");
      const doc = f.get("document") as File;
      expect(doc.name).toBe("report.md");
      expect(await doc.text()).toBe("# hi");
    } finally {
      await done();
    }
  });

  test("Telegram's own reason reaches the person", async () => {
    const { c, done } = await started(() =>
      Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" }, { status: 403 }),
    );
    try {
      await expect(
        c.sendFile("telegram:7:7", { name: "a.md", data: new Uint8Array(1), caption: "" }),
      ).rejects.toThrow(/blocked by the user/);
    } finally {
      await done();
    }
  });

  test("a file over the bot limit is refused before it is uploaded", async () => {
    let uploads = 0;
    const { c, done } = await started(() => {
      uploads++;
      return Response.json({ ok: true });
    });
    try {
      await expect(
        c.sendFile("telegram:7:7", { name: "big.bin", data: new Uint8Array(51 * 1024 * 1024), caption: "" }),
      ).rejects.toThrow(/50 MB/);
      expect(uploads).toBe(0);
    } finally {
      await done();
    }
  });
});
