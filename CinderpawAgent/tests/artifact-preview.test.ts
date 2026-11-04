/**
 * Artifact previews: an app opened as a real web page, for the agent to look at
 * its own work and for the person to open in their own browser.
 *
 * The security line is the same as the panel's: model-authored HTML never runs
 * with an origin of ours. Here that is the `sandbox` CSP on the raw page, which
 * gives it an opaque origin even at the top level of someone's everyday browser.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { ArtifactPreviewServer } from "../src/artifacts/preview.ts";

const db = openDatabase(":memory:");
const store = new ArtifactStore(db.raw, mkdtempSync(join(tmpdir(), "cinderpaw-preview-")));
const server = new ArtifactPreviewServer(store);
afterAll(() => server.stop());

const VOXELS = `<!doctype html><html><body><canvas id="c"></canvas>
<script>document.title = "voxels v1"</script></body></html>`;

function app(content = VOXELS) {
  return store.create({ kind: "app", title: "Voxel village", content, workspaceId: "w", sessionId: "s" });
}

describe("artifact preview", () => {
  test("the link is loopback only, with a secret nobody can guess", async () => {
    const url = new URL(await server.url(app()));
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname.split("/").pop()!.length).toBeGreaterThanOrEqual(32);
  });

  test("the page carries our branding and frames the app", async () => {
    const url = await server.url(app());
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`src="${new URL(url).pathname}/app"`);
    expect(html).toContain("Cinderpaw");
    expect(html).toContain("Voxel village");
    expect(html).toMatch(/<iframe[^>]+sandbox="allow-scripts"/);
  });

  test("the app itself runs sandboxed: never same-origin, in any browser", async () => {
    const res = await fetch(`${await server.url(app())}/app`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    const html = await res.text();
    expect(html).toContain("voxels v1");
    // Errors are relayed to the frame so the agent sees them on screen.
    expect(html).toContain("cinderpaw-preview-error");
  });

  test("it always shows the current version, so a fix shows on reload", async () => {
    const a = app();
    const url = await server.url(a);
    store.write(a.id, VOXELS.replace("voxels v1", "voxels v2"), "agent");
    expect(await (await fetch(`${url}/app`)).text()).toContain("voxels v2");
  });

  test("Save downloads the page alone, still sandboxed, without our error relay", async () => {
    const res = await fetch(`${await server.url(app())}/download`);
    expect(res.headers.get("content-disposition")).toContain('filename="Voxel village.html"');
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await res.text();
    expect(html).toContain("voxels v1");
    expect(html).not.toContain("cinderpaw-preview-error");
  });

  test("our fonts and Cubby are served from this computer, nothing else is", async () => {
    const url = await server.url(app());
    const font = await fetch(`${url}/f/young-serif-latin.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    expect((await fetch(`${url}/f/passwords.txt`)).status).toBe(404);
  });

  test("a wrong secret says so in words, and serves nothing", async () => {
    const url = new URL(await server.url(app()));
    const res = await fetch(`${url.origin}/p/not-a-real-secret-not-a-real-secret`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("ask Cinderpaw for a new link");
  });

  test("only pages can be previewed; a CSV says what to do instead", async () => {
    const csv = store.create({ kind: "table", title: "Leads", content: "a,b\n1,2", workspaceId: "w", sessionId: "s" });
    await expect(server.url(csv)).rejects.toThrow(/artifact_export/);
  });
});
