/**
 * Writing an artifact out as a real file, for both people who ask for it.
 *
 * The agent asks through `artifact_export`; the person asks by clicking Export
 * in the workspace panel. Those are two callers, not two features, and the
 * moment they have two implementations one of them stops inlining the chart
 * library or stops checking the destination, and nobody notices until a file
 * lands somewhere it should not have.
 *
 * So the permission manifest lives HERE, once. Both paths go through
 * `resolveAllowedPath`, the same choke point `write_file` uses, which is what
 * makes `read_only` mode and the escape check apply to a click in the UI
 * exactly as they apply to a tool call.
 */

import { join, resolve } from "node:path";
import { basename } from "node:path";
import type { ToolManifest } from "../types.ts";
import {
  PermissionDeniedError,
  deniedPaths,
  pathWithin,
  realpathBestEffort,
  resolveAllowedPath,
} from "../egress/tool-permissions.ts";
import { ArtifactStore, type Artifact } from "./store.ts";
import { inlineApp } from "./app.ts";
import { pdfFromMarkdown } from "./pdf.ts";
import { htmlToText } from "../tools/builtin/fetch-url.ts";

/**
 * A title turned into something a filesystem accepts, on every OS.
 *
 * It is never part of a stored path — those are built from the uuid — so this
 * is about the exported file's name. Windows is the strict one: `: * ? " < > |`
 * are illegal in a name, not merely awkward, so "Q3: revenue vs plan" would
 * fail the write on the platform most users are on. Path separators go too, so
 * a title can never become a directory hop.
 */
export function safeFileName(title: string): string {
  const cleaned = basename(title)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return cleaned.slice(0, 80) || "artifact";
}

/**
 * Whether this copy should be turned into a PDF on the way out.
 *
 * A text artifact already written cannot become a PDF any other way: the store
 * keeps one kind per artifact, so without this the only route from "write me
 * the plan" to "now as a PDF" is to throw the artifact away and author it
 * again. That dead end is what makes an agent answer "I cannot make PDFs",
 * which is not true and cost a user an evening on 17 Sep.
 *
 * Asked for either by name (`format: "pdf"`) or, and this is the one that
 * matters for a person who never reads a tool description, by the destination
 * they typed or picked in the save dialog ending in `.pdf`. Before this, that
 * picked name wrote HTML bytes into a file called `.pdf`, which no reader opens.
 */
export type ExportAs = "pdf" | undefined;

export function exportAs(a: Artifact, dest: string | undefined, asked: ExportAs): ExportAs {
  // Already a PDF: it goes out byte for byte, as it always did.
  if (a.kind === "pdf" || !ArtifactStore.isTextKind(a.kind)) return undefined;
  if (asked === "pdf") return "pdf";
  return dest !== undefined && /\.pdf$/i.test(dest.trim()) ? "pdf" : undefined;
}

/**
 * Enough of an HTML document to survive the trip through markdown: headings
 * and bullets, which are the only structure `pdfFromMarkdown` renders anyway.
 *
 * ponytail: a regex pass over four tags, reusing `htmlToText` for the rest.
 * A real HTML-to-PDF renderer is a headless browser; reach for one only if
 * someone asks for a PDF where the styling, not the words, is the point.
 */
function htmlToMarkdown(html: string): string {
  return htmlToText(
    html
      .replace(/<h1\b[^>]*>/gi, "\n\n# ")
      .replace(/<h2\b[^>]*>/gi, "\n\n## ")
      .replace(/<h3\b[^>]*>/gi, "\n\n### ")
      .replace(/<li\b[^>]*>/gi, "\n- "),
  );
}

export interface ExportResult {
  path: string;
  bytes: number;
  /** Said out loud to whoever asked: offline status, or what still is not. */
  note: string;
}

/**
 * An artifact as the file a person receives: its name, its bytes, and a note
 * on anything that will not work where it lands.
 *
 * Shared by export-to-disk and send-to-a-chat. An `app` sent to Telegram with
 * its chart library still a CDN link would be a blank page on a phone with
 * patchy data, and it would be the same bug as a blank export, fixed twice.
 */
export async function artifactFile(
  store: ArtifactStore,
  a: Artifact,
  as?: ExportAs,
): Promise<{ name: string; content: string | Uint8Array; note: string }> {
  if (as === "pdf") {
    const text = store.read(a.id);
    if (text === null) throw new Error(`Artifact ${a.id} has no readable content.`);
    const md = a.kind === "document" || a.kind === "html" || a.kind === "app" ? htmlToMarkdown(text) : text;
    return {
      name: `${safeFileName(a.title)}.pdf`,
      content: await pdfFromMarkdown(md, a.title),
      note: a.kind === "app" ? " A PDF is paper: the app's controls do not work in it." : "",
    };
  }
  const name = `${safeFileName(a.title)}${ArtifactStore.extensionFor(a.kind)}`;
  // Everything but an app goes out byte for byte: identical for text, and the
  // only correct way for a PDF, which read as UTF-8 arrives as a file no reader
  // can open.
  if (a.kind !== "app") {
    const bytes = store.readBytes(a.id);
    if (bytes === null) throw new Error(`Artifact ${a.id} has no readable content.`);
    return { name, content: bytes, note: "" };
  }
  const content = store.read(a.id);
  if (content === null) throw new Error(`Artifact ${a.id} has no readable content.`);

  // An app is only useful as a file if it still works once it is one. The
  // chart library is inlined here rather than stored, so the page opens
  // offline in any browser with nothing installed.
  const app = inlineApp(content);
  let note = "";
  if (app.charts) note += " Charts are inlined, so it works offline.";
  if (app.externals.length > 0) {
    note +=
      ` It still loads ${app.externals.length} thing(s) from the internet` +
      ` and will not work offline: ${app.externals.slice(0, 3).join(", ")}.`;
  }
  return { name, content: app.html, note };
}

export class ArtifactExporter {
  readonly #store: ArtifactStore;
  readonly #roots: string[];
  readonly #manifest: ToolManifest;

  constructor(store: ArtifactStore, workspaceRoots: string[]) {
    this.#store = store;
    this.#roots = workspaceRoots;
    this.#manifest = {
      name: "artifact_export",
      description: "internal: writing an artifact out as a file",
      permissions: ["fs:read", "fs:write"],
      networkAccess: false,
      // The artifact root is readable and never writable from here: a copy may
      // only land in a directory the user already granted.
      allowedPaths: [{ path: store.root, mode: "read" }, ...workspaceRoots],
    };
  }

  /** Where a copy lands when nobody names a destination. */
  get defaultRoot(): string | null {
    return this.#roots[0] ?? null;
  }

  /**
   * @throws when there is nowhere to write, or the destination is out of bounds
   *   (`resolveAllowedPath` throws `PermissionDeniedError`, which the tool
   *   registry turns into a structured error and dispatch reports as text).
   */
  async run(a: Artifact, dest?: string, as?: ExportAs): Promise<ExportResult> {
    const file = await artifactFile(this.#store, a, exportAs(a, dest, as));

    const root = this.defaultRoot;
    const requested = dest?.trim() ?? "";
    if (!requested && !root) {
      // A sentence about what to do, not about our data model. On a fresh
      // install nobody has opened a folder yet, and "no workspace root" would
      // be a true statement that helps nobody.
      throw new Error(
        "There is no workspace folder to write into. Open a folder in Cinderpaw " +
          "first, or give an absolute path.",
      );
    }
    const target = requested ? resolve(root ?? "", requested) : join(root!, file.name);

    const safe = resolveAllowedPath(this.#manifest, "fs:write", target);
    return this.#write(safe, file);
  }

  /**
   * Write where the PERSON pointed, in the OS save dialog.
   *
   * Not through the workspace-root check: they chose the folder themselves,
   * in a dialog the agent cannot drive, and the roots exist to bound the
   * agent. The private-dir wall stays, for the same reason it exists for
   * every writer: a file dropped into ~/.cinderpaw can shadow agent state.
   */
  async runTo(a: Artifact, chosenPath: string, as?: ExportAs): Promise<ExportResult> {
    const file = await artifactFile(this.#store, a, exportAs(a, chosenPath, as));
    const target = realpathBestEffort(resolve(chosenPath));
    const { deny, exempt } = deniedPaths();
    if (deny.some((d) => pathWithin(target, d)) && !exempt.some((e) => pathWithin(target, e))) {
      throw new PermissionDeniedError(`"${target}" is inside Cinderpaw's own data folder; pick another place.`);
    }
    return this.#write(target, file);
  }

  async #write(path: string, file: Awaited<ReturnType<typeof artifactFile>>): Promise<ExportResult> {
    await Bun.write(path, file.content);
    const bytes = typeof file.content === "string" ? Buffer.byteLength(file.content, "utf8") : file.content.byteLength;
    return { path, bytes, note: file.note };
  }
}
