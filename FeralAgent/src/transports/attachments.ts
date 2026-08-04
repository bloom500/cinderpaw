/**
 * Inbound attachments — the files people actually send a chat bot.
 *
 * A connector used to forward `message.content` and nothing else, so a Discord
 * message reading "what do you think of this?" with a PDF stapled to it reached
 * the agent as five words with no referent. The model could not see that
 * anything was attached, so it answered the sentence — which reads exactly like
 * a hallucination and was reported as one.
 *
 * This turns a platform's attachment list into the two things `AgentLoop.handle`
 * already accepts:
 *
 *   - `images` — data URLs, which the provider layer already renders as
 *     `image_url` content parts (OpenAI-compatible, incl. MiniMax), Ollama
 *     `images`, or Anthropic image blocks. See `toOpenAIMessage`. Nothing new
 *     was needed here; the vision path existed and was simply never fed.
 *   - `text` — documents inlined into the user's message. PDFs go through real
 *     extraction (`unpdf`); text and source files are decoded as UTF-8.
 *
 * Wired to Discord, whose CDN URLs are plain authenticated-by-signature GETs.
 * The reading/inlining half here is transport-agnostic, but the other two
 * connectors cannot simply be pointed at it: a Slack file URL needs the bot
 * token as a bearer header, and WhatsApp media is encrypted and has to come
 * through baileys' own `downloadMediaMessage`. Both need a transport-specific
 * fetch feeding `InboundAttachment`; neither needs a second copy of this file.
 */

import { cfgInt } from "../config.ts";
import { isBlockedHost } from "../egress/egress-proxy.ts";

/** One file as the platform describes it. */
export interface InboundAttachment {
  name: string;
  /** Direct download URL (Discord CDN, Slack private URL, …). */
  url: string;
  /** The platform's declared MIME type, when it has one. */
  contentType?: string | null;
  /** Declared size in bytes, when the platform reports it. */
  size?: number | null;
}

/** What a connector splices into its `agent.handle(...)` call. */
export interface AttachmentPayload {
  /** Appended to the user's message. Empty when nothing was readable. */
  text: string;
  /** data: URLs for the vision path. */
  images: string[];
}

/** Files considered per message. Past this the rest are named but not read. */
const MAX_ATTACHMENTS = 8;

/**
 * Byte ceiling per download. Images are base64'd into the prompt at ~1.33× and
 * every megabyte is real money on a metered model, so they get a tighter cap
 * than documents, whose text is a fraction of the file size.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOC_BYTES = 32 * 1024 * 1024;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/**
 * Extensions read as plain text. Deliberately broad — someone pasting a config
 * or a source file wants it read, and the cost of being wrong is a few lines of
 * mojibake, not a failure. Anything not listed and not declared `text/*` by the
 * platform is left unread rather than guessed at, because decoding a binary as
 * UTF-8 produces convincing-looking garbage the model will try to interpret.
 */
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv",
  "json", "jsonl", "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
  "xml", "html", "htm", "css", "svg",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "php",
  "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "sh", "bash", "ps1",
  "sql", "diff", "patch", "gradle", "dockerfile", "makefile",
]);

type Kind = "image" | "pdf" | "text" | "unsupported";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
}

/**
 * The platform's MIME type wins when it says something useful; the extension
 * decides otherwise. Discord sends `application/octet-stream` for plenty of
 * ordinary text files, so the extension is not merely a fallback.
 */
function kindOf(a: InboundAttachment): Kind {
  const mime = (a.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (mime.startsWith("image/")) return IMAGE_EXT.has(mime.slice(6)) ? "image" : "unsupported";
  if (mime === "application/pdf") return "pdf";

  const ext = extensionOf(a.name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml") return "text";
  return "unsupported";
}

/**
 * Fetch one attachment with a size ceiling.
 *
 * The SSRF check is hostname-level rather than the full resolve-every-IP guard
 * the egress proxy runs, and that is the right depth here: this URL is minted
 * by the platform's own CDN, not supplied by the sender, so the threat is a
 * malformed or hostile *platform* response rather than a user aiming us at
 * 169.254.169.254. https-only plus the private-range check covers that without
 * pretending to a stronger guarantee.
 */
async function download(url: string, maxBytes: number): Promise<Uint8Array | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (isBlockedHost(parsed.hostname.toLowerCase())) return null;

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // Re-check after the fact: content-length is a hint, not a promise.
  return buf.byteLength > maxBytes ? null : buf;
}

/** Cut to the configured ceiling, saying so in-band so the model knows. */
function clip(text: string, name: string): string {
  const max = cfgInt("FERAL_ATTACHMENT_MAX_CHARS");
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n…[${name} truncated here — ${text.length} characters total, ` +
    "you are seeing the first " + max + ". Say so if you answer from a partial read.]"
  );
}

/**
 * Text of a PDF, or null when there is none to get.
 *
 * `unpdf` is imported lazily: it carries a pdf.js build, and the overwhelming
 * majority of messages have no PDF in them. No reason to pay for it at boot.
 *
 * ponytail: text layer only, no OCR. A scanned page has no text layer and comes
 * back empty — reported honestly rather than silently answered from nothing.
 * Upgrade path if that starts mattering: rasterize the pages and send them down
 * the image path, which already works.
 */
async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number } | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : text).trim();
    return merged ? { text: merged, pages: totalPages } : null;
  } catch {
    return null;
  }
}

/**
 * Read what can be read. Never throws: one unreadable file must not cost the
 * user their message, so every failure degrades to a line of text telling the
 * model that a file arrived and could not be opened. That line matters — an
 * attachment silently dropped is what makes the agent answer as though nothing
 * was sent, which is indistinguishable from a hallucination on the user's end.
 */
export async function readAttachments(
  attachments: InboundAttachment[],
  log: (message: string) => void = () => {},
): Promise<AttachmentPayload> {
  if (attachments.length === 0) return { text: "", images: [] };

  const blocks: string[] = [];
  const images: string[] = [];
  const considered = attachments.slice(0, MAX_ATTACHMENTS);

  for (const a of considered) {
    const kind = kindOf(a);
    try {
      if (kind === "unsupported") {
        blocks.push(`[Attachment "${a.name}" (${a.contentType || "unknown type"}) — not a format I can read.]`);
        continue;
      }

      const bytes = await download(a.url, kind === "image" ? MAX_IMAGE_BYTES : MAX_DOC_BYTES);
      if (!bytes) {
        blocks.push(`[Attachment "${a.name}" — could not be downloaded, or is over the size limit.]`);
        log(`attachments: download failed or too large: ${a.name}`);
        continue;
      }

      if (kind === "image") {
        const mime = (a.contentType ?? "").split(";")[0]!.trim() || `image/${extensionOf(a.name)}`;
        images.push(`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`);
        blocks.push(`[Image attached: "${a.name}" — it is in this message, look at it.]`);
        continue;
      }

      if (kind === "pdf") {
        const extracted = await pdfText(bytes);
        if (!extracted) {
          blocks.push(
            `[Attachment "${a.name}" is a PDF with no extractable text — most likely a scan or ` +
              "images of pages. Tell the user that, and that sending the pages as images works.]",
          );
          continue;
        }
        blocks.push(
          `=== Attachment: ${a.name} (PDF, ${extracted.pages} page${extracted.pages === 1 ? "" : "s"}) ===\n` +
            clip(extracted.text, a.name) +
            `\n=== end of ${a.name} ===`,
        );
        continue;
      }

      const text = Buffer.from(bytes).toString("utf8").trim();
      blocks.push(
        text
          ? `=== Attachment: ${a.name} ===\n${clip(text, a.name)}\n=== end of ${a.name} ===`
          : `[Attachment "${a.name}" is empty.]`,
      );
    } catch (err) {
      blocks.push(`[Attachment "${a.name}" — failed to read: ${String(err)}]`);
      log(`attachments: ${a.name} failed: ${String(err)}`);
    }
  }

  if (attachments.length > considered.length) {
    blocks.push(
      `[${attachments.length - considered.length} further attachment(s) were not read — ` +
        `${MAX_ATTACHMENTS} per message is the limit.]`,
    );
  }

  return { text: blocks.length > 0 ? blocks.join("\n\n") : "", images };
}
