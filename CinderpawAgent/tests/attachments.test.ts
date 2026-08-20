/**
 * Inbound attachments — the files people staple to a chat message.
 *
 * Discord forwarded only `message.content`, so a PDF or a screenshot arrived as
 * whatever words happened to accompany it (often none). The agent answered the
 * words, which on the user's end is indistinguishable from making things up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readAttachments } from "../src/transports/attachments.ts";

const CDN = "https://cdn.discordapp.com";

/** A minimal but genuinely valid one-page PDF with a text layer. */
function tinyPdf(body = "Cinderpaw reads PDFs"): Uint8Array {
  const content = `BT /F1 12 Tf 20 100 Td (${body}) Tj ET`;
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R" +
        "/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${content.length}>>stream`,
      content,
      "endstream endobj",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R/Size 6>>",
      "%%EOF",
    ].join("\n"),
  );
}

const realFetch = globalThis.fetch;

/** Serve fixed bytes per URL; anything unrouted 404s. */
function serve(routes: Record<string, Uint8Array | string>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = routes[url];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(typeof body === "string" ? body : (body.slice() as Uint8Array<ArrayBuffer>));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("readAttachments", () => {
  test("no attachments is a no-op", async () => {
    expect(await readAttachments([])).toEqual({ text: "", images: [] });
  });

  test("an image becomes a data URL on the vision path", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    serve({ [`${CDN}/a/shot.png`]: png });

    const out = await readAttachments([
      { name: "shot.png", url: `${CDN}/a/shot.png`, contentType: "image/png", size: png.length },
    ]);

    expect(out.images).toHaveLength(1);
    expect(out.images[0]).toStartWith("data:image/png;base64,");
    expect(Buffer.from(out.images[0]!.split(",")[1]!, "base64")).toEqual(Buffer.from(png));
    // The model is also told in words that an image is present.
    expect(out.text).toContain("shot.png");
    // …and what to do when it turns out to be blind. Nothing on our side can
    // know whether the selected model has vision: the capability registry is
    // hand-written in brain.json and the Brain is off by default. So the
    // quiet half of the failure — a text-only model ignoring the image and
    // answering from the filename and the words around it — is headed off the
    // only way it can be, by telling the model to admit it instead.
    expect(out.text).toMatch(/cannot see|can't see/i);
    expect(out.text).toMatch(/do not (describe|guess)/i);
  });

  test("a text file is inlined, not just named", async () => {
    serve({ [`${CDN}/a/notes.md`]: "# Plan\n\nShip the thing." });

    const out = await readAttachments([
      { name: "notes.md", url: `${CDN}/a/notes.md`, contentType: "application/octet-stream" },
    ]);

    // Discord mislabels plenty of text files as octet-stream, so the extension
    // has to be authoritative here — this is the case that regresses.
    expect(out.text).toContain("Ship the thing.");
    expect(out.images).toHaveLength(0);
  });

  test("a PDF's text layer is extracted", async () => {
    serve({ [`${CDN}/a/spec.pdf`]: tinyPdf("MiniMax M3 reads this") });

    const out = await readAttachments([
      { name: "spec.pdf", url: `${CDN}/a/spec.pdf`, contentType: "application/pdf" },
    ]);

    expect(out.text).toContain("MiniMax M3 reads this");
    expect(out.text).toContain("1 page");
  });

  test("a PDF with no text layer says so instead of going quiet", async () => {
    // A scan. Silence here is the failure mode being fixed: the agent answers
    // as though nothing was attached.
    serve({ [`${CDN}/a/scan.pdf`]: new Uint8Array([1, 2, 3, 4, 5]) });

    const out = await readAttachments([
      { name: "scan.pdf", url: `${CDN}/a/scan.pdf`, contentType: "application/pdf" },
    ]);

    expect(out.text).toContain("scan.pdf");
    expect(out.text).toContain("no extractable text");
  });

  test("long documents are truncated in-band, so a partial read is visible", async () => {
    const prev = process.env.FERAL_ATTACHMENT_MAX_CHARS;
    process.env.FERAL_ATTACHMENT_MAX_CHARS = "100";
    try {
      serve({ [`${CDN}/a/big.txt`]: "x".repeat(5_000) });
      const out = await readAttachments([
        { name: "big.txt", url: `${CDN}/a/big.txt`, contentType: "text/plain" },
      ]);
      expect(out.text).toContain("truncated here");
      expect(out.text).toContain("5000 characters total");
      expect(out.text.length).toBeLessThan(600);
    } finally {
      if (prev === undefined) delete process.env.FERAL_ATTACHMENT_MAX_CHARS;
      else process.env.FERAL_ATTACHMENT_MAX_CHARS = prev;
    }
  });

  test("an unreadable format is reported, never dropped silently", async () => {
    serve({ [`${CDN}/a/clip.mp4`]: new Uint8Array([0, 1, 2]) });

    const out = await readAttachments([
      { name: "clip.mp4", url: `${CDN}/a/clip.mp4`, contentType: "video/mp4" },
    ]);

    expect(out.text).toContain("clip.mp4");
    expect(out.text).toContain("not a format I can read");
  });

  test("a failed download degrades to a note, not a thrown turn", async () => {
    serve({});
    const out = await readAttachments([
      { name: "gone.txt", url: `${CDN}/a/gone.txt`, contentType: "text/plain" },
    ]);
    expect(out.text).toContain("could not be downloaded");
  });

  test("non-https and private hosts are refused without a fetch", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("should not happen");
    }) as typeof fetch;

    const out = await readAttachments([
      { name: "a.txt", url: "http://cdn.discordapp.com/a.txt", contentType: "text/plain" },
      { name: "b.txt", url: "https://127.0.0.1/b.txt", contentType: "text/plain" },
      { name: "c.txt", url: "https://localhost/c.txt", contentType: "text/plain" },
    ]);

    expect(called).toBe(0);
    expect(out.text.match(/could not be downloaded/g)).toHaveLength(3);
  });

  test("mixed batch: one call yields both inlined text and images", async () => {
    serve({
      [`${CDN}/a/doc.pdf`]: tinyPdf("quarterly numbers"),
      [`${CDN}/a/chart.png`]: new Uint8Array([0x89, 0x50]),
      [`${CDN}/a/readme.txt`]: "plain text here",
    });

    const out = await readAttachments([
      { name: "doc.pdf", url: `${CDN}/a/doc.pdf`, contentType: "application/pdf" },
      { name: "chart.png", url: `${CDN}/a/chart.png`, contentType: "image/png" },
      { name: "readme.txt", url: `${CDN}/a/readme.txt`, contentType: "text/plain" },
    ]);

    expect(out.images).toHaveLength(1);
    expect(out.text).toContain("quarterly numbers");
    expect(out.text).toContain("plain text here");
    expect(out.text).toContain("chart.png");
  });
});
