/**
 * Sending a FILE, on every connector that can carry one.
 *
 * `artifact_send` asks the person before a single byte leaves the machine,
 * and until now four connectors out of twenty-one could act on the yes. The
 * rest answered "that chat app cannot carry a file" - which was true of IRC
 * and SMS and untrue of Matrix, Mattermost, Signal, Nextcloud Talk, Google
 * Chat and Feishu, all of which have had an upload API the whole time.
 *
 * Each case here pins the shape of the real API call, because every one of
 * these is two steps (upload, then post) and getting the second step wrong
 * leaves the bytes on somebody's server with nothing pointing at them: no
 * error, no file in the chat, and a person who was told it was sent.
 *
 * The other half of what is pinned is the MIME type. A photo uploaded as
 * `application/octet-stream` arrives as a download link instead of a picture,
 * which is the kind of failure that looks like it worked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { MatrixConnector, matrixSessionId } from "../src/transports/matrix.ts";
import { MattermostConnector, mattermostSessionId } from "../src/transports/mattermost.ts";
import { SignalConnector, signalSessionId } from "../src/transports/signal.ts";
import { NextcloudTalkConnector, nextcloudTalkSessionId } from "../src/transports/nextcloud-talk.ts";
import { feishuFileType } from "../src/transports/feishu.ts";
import { mimeForName } from "../src/transports/connectors.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const AGENT = {
  handle: async () => "ok",
  setSessionSurface: () => {},
  setSessionProfile: () => {},
} as unknown as AgentLike;

function ctx(row: ConnectorContext["row"], secrets: Record<string, string>): ConnectorContext {
  return {
    row,
    secrets,
    agent: AGENT,
    log: () => {},
    runs: null,
    askRouter: new ChannelAskRouter(),
  } as ConnectorContext;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Records every request and answers from `answer`, so order can be asserted. */
function record(answer: (url: string, method: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    });
    return answer(url, method) ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

const FILE = { name: "raport.pdf", data: new Uint8Array([1, 2, 3, 4]), caption: "Raport (v2)" };
const PHOTO = { name: "poza.png", data: new Uint8Array([9, 9]), caption: "" };

describe("matrix", () => {
  const ok = (url: string) =>
    url.includes("/media/v3/upload")
      ? new Response(JSON.stringify({ content_uri: "mxc://home.example/abc" }), { status: 200 })
      : url.includes("/account/whoami")
        ? new Response(JSON.stringify({ user_id: "@cinderpaw:example.org" }), { status: 200 })
        : new Response(JSON.stringify({ next_batch: "s1", rooms: { join: {} } }), { status: 200 });

  const started = async (answer: (url: string, method: string) => Response | undefined) => {
    const calls = record(answer);
    const c = new MatrixConnector();
    await c.start(
      ctx(
        {
          id: "matrix",
          enabled: true,
          allowlist: ["@sam:example.org"],
          metadata: { MATRIX_HOMESERVER: "https://home.example" },
          secrets: { MATRIX_ACCESS_TOKEN: "tok" },
        } as unknown as ConnectorContext["row"],
        { MATRIX_ACCESS_TOKEN: "tok" },
      ),
    );
    return { c, calls };
  };

  test("uploads the bytes, then posts an event pointing at them", async () => {
    const { c, calls } = await started(ok);
    await c.sendFile(matrixSessionId("!room:example.org", "@sam:example.org"), FILE);
    await c.stop();

    const upload = calls.find((x) => x.url.includes("/media/v3/upload"))!;
    expect(upload.method).toBe("POST");
    expect(upload.url).toContain("filename=raport.pdf");
    expect(upload.headers["Content-Type"]).toBe("application/pdf");

    const event = calls.find((x) => x.url.includes("/send/m.room.message/"))!;
    const body = JSON.parse(String(event.body)) as Record<string, unknown>;
    expect(body.msgtype).toBe("m.file");
    expect(body.url).toBe("mxc://home.example/abc");
    expect(body.filename).toBe("raport.pdf");
    // The caption is the body, so a client that renders nothing still says
    // what arrived rather than showing an empty bubble.
    expect(body.body).toBe("Raport (v2)");
  });

  test("a picture is posted as a picture, not as an attachment", async () => {
    const { c, calls } = await started(ok);
    await c.sendFile(matrixSessionId("!room:example.org", "@sam:example.org"), PHOTO);
    await c.stop();
    const event = calls.find((x) => x.url.includes("/send/m.room.message/"))!;
    const body = JSON.parse(String(event.body)) as Record<string, unknown>;
    expect(body.msgtype).toBe("m.image");
    // No caption: the file name is what the person sees, never an empty string.
    expect(body.body).toBe("poza.png");
  });

  test("a file the homeserver is too small for says so in those words", async () => {
    const { c } = await started((url) =>
      url.includes("/media/v3/upload") ? new Response("{}", { status: 413 }) : ok(url),
    );
    await expect(
      c.sendFile(matrixSessionId("!room:example.org", "@sam:example.org"), FILE),
    ).rejects.toThrow(/larger than this homeserver accepts/);
    await c.stop();
  });
});

describe("mattermost", () => {
  const startMattermost = async (
    answer: (url: string, method: string) => Response | undefined,
  ) => {
    const calls = record(answer);
    const c = new MattermostConnector();
    await c.start(
      ctx(
        {
          id: "mattermost",
          enabled: true,
          allowlist: ["u1"],
          metadata: { MATTERMOST_URL: "https://chat.example" },
          secrets: { MATTERMOST_TOKEN: "tok" },
        } as unknown as ConnectorContext["row"],
        { MATTERMOST_TOKEN: "tok" },
      ),
    );
    return { c, calls };
  };

  const me = (url: string) =>
    url.includes("/api/v4/users/me")
      ? new Response(JSON.stringify({ id: "me" }), { status: 200 })
      : undefined;

  test("uploads against the channel first, then posts the file id", async () => {
    const { c, calls } = await startMattermost((url) =>
      url.endsWith("/api/v4/files")
        ? new Response(JSON.stringify({ file_infos: [{ id: "f1" }] }), { status: 200 })
        : me(url),
    );
    await c.sendFile(mattermostSessionId("c1", "u1"), FILE);
    await c.stop();

    const upload = calls.findIndex((x) => x.url.endsWith("/api/v4/files"));
    const post = calls.findIndex((x) => x.url.endsWith("/api/v4/posts"));
    expect(upload).toBeGreaterThanOrEqual(0);
    // Order is the whole point: a post naming an upload that has not happened
    // is refused, and the file never appears.
    expect(post).toBeGreaterThan(upload);
    const body = JSON.parse(String(calls[post]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ channel_id: "c1", file_ids: ["f1"], message: "Raport (v2)" });
  });

  test("an upload the server refuses is reported, and nothing is posted", async () => {
    const { c, calls } = await startMattermost((url) =>
      url.endsWith("/api/v4/files")
        ? new Response(JSON.stringify({ message: "File is too large" }), { status: 413 })
        : me(url),
    );
    await expect(c.sendFile(mattermostSessionId("c1", "u1"), FILE)).rejects.toThrow(/larger than/);
    await c.stop();
    expect(calls.some((x) => x.url.endsWith("/api/v4/posts"))).toBe(false);
  });
});

describe("signal", () => {
  test("the attachment carries its name and type, not just bytes", async () => {
    const calls = record((url) =>
      url.includes("/v1/receive/") ? new Response("[]", { status: 200 }) : undefined,
    );
    const c = new SignalConnector();
    await c.start(
      ctx(
        {
          id: "signal",
          enabled: true,
          allowlist: ["+40712345678"],
        } as unknown as ConnectorContext["row"],
        { SIGNAL_NUMBER: "+40700000000", SIGNAL_BRIDGE_URL: "http://bridge.example" },
      ),
    );
    await c.sendFile(signalSessionId("+40712345678"), FILE);
    await c.stop();

    const send = calls.find((x) => x.url.endsWith("/v2/send"))!;
    const body = JSON.parse(String(send.body)) as { base64_attachments: string[]; message: string };
    // Plain base64 arrives as "attachment.bin" - the extended form is what
    // makes it arrive as raport.pdf.
    expect(body.base64_attachments[0]).toStartWith(
      "data:application/pdf;filename=raport.pdf;base64,",
    );
    expect(body.message).toBe("Raport (v2)");
  });
});

describe("nextcloud talk", () => {
  const ocs = (data: unknown) =>
    new Response(JSON.stringify({ ocs: { meta: { statuscode: 200 }, data } }), { status: 200 });

  const startTalk = async (answer: (url: string, method: string) => Response | undefined) => {
    const calls = record(answer);
    const c = new NextcloudTalkConnector();
    await c.start(
      ctx(
        {
          id: "nextcloud-talk",
          enabled: true,
          allowlist: ["sam"],
          metadata: {
            NEXTCLOUD_TALK_URL: "https://cloud.example",
            NEXTCLOUD_TALK_USER: "cinderpaw",
          },
          secrets: { NEXTCLOUD_TALK_APP_PASSWORD: "pw" },
        } as unknown as ConnectorContext["row"],
        { NEXTCLOUD_TALK_APP_PASSWORD: "pw" },
      ),
    );
    return { c, calls };
  };

  const base = (url: string) =>
    url.includes("/cloud/user")
      ? ocs({ id: "cinderpaw" })
      : url.includes("/spreed/api/")
        ? ocs([])
        : undefined;

  test("uploads over WebDAV, then shares the file into the room", async () => {
    const { c, calls } = await startTalk((url) => base(url));
    await c.sendFile(nextcloudTalkSessionId("tok123", "sam"), FILE);
    await c.stop();

    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url).toContain("/remote.php/dav/files/cinderpaw/Talk/");
    // The name is made unique: a second raport.pdf would otherwise overwrite
    // the first, and the older message in the chat would point at new bytes.
    expect(put.url).toContain("raport-");
    expect(put.url.endsWith(".pdf")).toBe(true);

    const share = calls.find((x) => x.url.includes("/files_sharing/api/v1/shares"))!;
    const body = JSON.parse(String(share.body)) as Record<string, unknown>;
    expect(body.shareType).toBe(10);
    expect(body.shareWith).toBe("tok123");
  });

  test("a full account is named as a full account", async () => {
    const { c } = await startTalk((url, method) =>
      method === "PUT" ? new Response("", { status: 507 }) : base(url),
    );
    await expect(c.sendFile(nextcloudTalkSessionId("tok123", "sam"), FILE)).rejects.toThrow(
      /no space left/,
    );
    await c.stop();
  });
});

describe("the file type is read off the name", () => {
  test("audio and video are types, not octet-stream", () => {
    // These were missing, so a voice note or a clip arrived as a download.
    expect(mimeForName("nota.mp3")).toBe("audio/mpeg");
    expect(mimeForName("clip.mp4")).toBe("video/mp4");
    expect(mimeForName("clip.MOV")).toBe("video/quicktime");
    expect(mimeForName("foto.webp")).toBe("image/webp");
    expect(mimeForName("date.xlsx")).toContain("spreadsheetml");
  });

  test("something unknown is still sendable", () => {
    expect(mimeForName("backup.qqq")).toBe("application/octet-stream");
    expect(mimeForName("noextension")).toBe("application/octet-stream");
  });

  test("feishu's own short list, and the catch-all", () => {
    expect(feishuFileType("a.pdf")).toBe("pdf");
    expect(feishuFileType("a.docx")).toBe("doc");
    expect(feishuFileType("a.XLSX")).toBe("xls");
    expect(feishuFileType("a.zip")).toBe("stream");
  });
});
