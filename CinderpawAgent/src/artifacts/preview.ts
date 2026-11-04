/**
 * Artifact previews — an app as a real web page, at a link that lives on this
 * computer only.
 *
 * Two readers, one link. The agent opens it in its own browser and takes a
 * screenshot, so it can look at what it built and fix it, instead of writing a
 * page once and calling it done without having seen it. The person opens the
 * same link in their everyday browser, framed with our name on it.
 *
 * WHY THE APP IS ON ITS OWN SANDBOXED PAGE. The panel's rule
 * (`APP_IFRAME_SANDBOX` in app.ts) is that model-authored HTML never runs with
 * an origin of ours: it can carry text from a web page the agent read. A person's
 * everyday browser is worse than our webview, because it holds their logins,
 * including the gateway's session cookie for 127.0.0.1. So the app is served at
 * `/app` with `Content-Security-Policy: sandbox allow-scripts`, which gives the
 * document an opaque origin even when someone opens that address directly, and
 * the framing page embeds it with the same sandbox attribute. Never add
 * `allow-same-origin` to either: together with `allow-scripts` it undoes the sandbox.
 *
 * ponytail: the secrets live in memory and the port is picked per launch, so every
 * link dies when the engine restarts. A link that must outlive a restart needs a
 * stored token and a fixed port; nobody has asked for that.
 */

import { randomBytes } from "node:crypto";
import type { ArtifactStore, Artifact } from "./store.ts";
import { artifactFile, safeFileName } from "./export.ts";
// Bundled with the engine (embedded by `bun build --compile`, as pdf.ts does with
// its fonts), so the frame page fetches nothing from the internet. SIL OFL 1.1.
import geistLatin from "./vendor/preview/geist-latin.woff2" with { type: "file" };
import geistLatinExt from "./vendor/preview/geist-latin-ext.woff2" with { type: "file" };
import youngSerifLatin from "./vendor/preview/young-serif-latin.woff2" with { type: "file" };
import youngSerifLatinExt from "./vendor/preview/young-serif-latin-ext.woff2" with { type: "file" };
import cubbyIcon from "./vendor/preview/cubby.png" with { type: "file" };

/** What a page needs to be previewed: something a browser draws. */
const PREVIEWABLE = new Set<Artifact["kind"]>(["app", "html"]);

/**
 * Put at the very top of the app, before its own scripts, so an error thrown
 * while the page loads is caught too. It reports to the framing page, which
 * prints it in a red strip: a screenshot then shows the error in words.
 */
const ERROR_RELAY = `<script>(function(){
var send=function(m){try{parent.postMessage({"cinderpaw-preview-error":String(m).slice(0,500)},"*")}catch(e){}};
addEventListener("error",function(e){send((e.message||"Error")+(e.lineno?" (line "+e.lineno+")":""))});
addEventListener("unhandledrejection",function(e){send("Unhandled promise: "+(e.reason&&e.reason.message||e.reason))});
var ce=console.error;console.error=function(){send([].slice.call(arguments).join(" "));return ce.apply(console,arguments)};
})()</script>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Before the first tag after <head> (or <html>, or at the top), so it runs first. */
function withErrorRelay(html: string): string {
  const at = /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html);
  if (!at) return ERROR_RELAY + html;
  const i = at.index + at[0].length;
  return html.slice(0, i) + ERROR_RELAY + html.slice(i);
}

/**
 * Our page around the app, in the app's own palette (Ivory / Espresso) and type
 * (Young Serif for the name, Geist for the rest). The app sits on a stage as one
 * large rounded card; problems arrive as a floating notice, never a banner.
 * `base` is the link's own path: every asset and action hangs off it.
 */
function framePage(title: string, base: string, nonce: string): string {
  const t = escapeHtml(title);
  const icon = (d: string) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} · Cinderpaw</title>
<link rel="icon" href="${base}/f/cubby.png">
<style>
@font-face{font-family:Geist;src:url(${base}/f/geist-latin.woff2) format("woff2");font-weight:100 900;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:Geist;src:url(${base}/f/geist-latin-ext.woff2) format("woff2");font-weight:100 900;font-display:swap;unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Young Serif";src:url(${base}/f/young-serif-latin.woff2) format("woff2");font-display:swap;unicode-range:U+0000-00FF,U+2000-206F}
@font-face{font-family:"Young Serif";src:url(${base}/f/young-serif-latin-ext.woff2) format("woff2");font-display:swap;unicode-range:U+0100-02AF,U+1E00-1EFF}
:root{color-scheme:light dark;--bg:#f7f1e8;--card:#eadfcf;--hover:#e3d5c1;--line:#dccdb8;--text:#1e1813;--muted:#6b5d50;--faint:#9a8b7b;
--stage:#fff;--shadow:0 1px 2px rgba(30,24,19,.06),0 18px 48px -18px rgba(30,24,19,.28);--note:#1e1813;--note-text:#f5ebdd;--note-muted:#bba995;--alert:#f05a24}
@media (prefers-color-scheme:dark){:root{--bg:#1b1410;--card:#271d17;--hover:#2f241d;--line:#3a2c23;--text:#f5ebdd;--muted:#bba995;--faint:#8a7766;
--stage:#000;--shadow:0 1px 2px rgba(0,0,0,.4),0 24px 60px -20px rgba(0,0,0,.7);--note:#2f241d;--note-text:#f5ebdd;--note-muted:#bba995}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:400 14px/1.45 Geist,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column}
.bar{display:flex;align-items:center;gap:14px;height:60px;padding:0 20px;flex:none}
.brand{display:flex;align-items:center;gap:9px;color:inherit;text-decoration:none;flex:none}
.brand img{width:26px;height:26px;display:block}
.word{font:400 17px/1 "Young Serif",Georgia,serif;letter-spacing:-.01em}
.rule{width:1px;height:18px;background:var(--line);flex:none}
.title{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.actions{margin-left:auto;display:flex;gap:6px;flex:none}
.btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:10px;border:0;background:transparent;
color:var(--muted);font:inherit;text-decoration:none;cursor:pointer;transition:background .15s,color .15s}
.btn:hover{background:var(--hover);color:var(--text)}
.btn:focus-visible{outline:2px solid var(--alert);outline-offset:2px}
.btn.icon{width:32px;padding:0;justify-content:center}
.stage{flex:1;min-height:0;padding:0 20px 20px}
.frame{height:100%;border-radius:18px;corner-shape:squircle;overflow:hidden;background:var(--stage);box-shadow:var(--shadow)}
.frame:fullscreen{border-radius:0}
iframe{display:block;width:100%;height:100%;border:0}
.foot{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);font-size:12px;color:var(--faint);pointer-events:none;opacity:0}
.note{position:fixed;left:50%;bottom:36px;transform:translate(-50%,12px);width:min(640px,calc(100% - 64px));
background:var(--note);color:var(--note-text);border-radius:16px;corner-shape:squircle;padding:14px 16px 14px 18px;
box-shadow:0 16px 40px -12px rgba(0,0,0,.45);display:flex;gap:12px;align-items:flex-start;opacity:0;pointer-events:none;
transition:opacity .2s,transform .25s cubic-bezier(.2,.8,.2,1)}
.note.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
.dot{width:8px;height:8px;border-radius:50%;background:var(--alert);margin-top:6px;flex:none}
.note b{font-weight:500}
.note pre{margin:4px 0 0;font:12.5px/1.45 ui-monospace,"Cascadia Mono",Consolas,monospace;color:var(--note-muted);white-space:pre-wrap;max-height:120px;overflow:auto}
.note button{margin-left:auto;background:transparent;border:0;color:var(--note-muted);cursor:pointer;padding:2px;border-radius:6px;flex:none}
.note button:hover{color:var(--note-text)}
@media (max-width:560px){.title,.rule,.label{display:none}.stage{padding:0 10px 10px}.bar{padding:0 12px}}
@media (prefers-reduced-motion:reduce){.note,.btn{transition:none}}
</style></head><body>
<div class="bar">
<a class="brand" href="https://cinderpaw.dev" target="_blank" rel="noopener" title="Made with Cinderpaw"><img src="${base}/f/cubby.png" alt=""><span class="word">Cinderpaw</span></a>
<span class="rule"></span><span class="title">${t}</span>
<div class="actions">
<button class="btn icon" id="reload" type="button" title="Reload" aria-label="Reload">${icon('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>')}</button>
<a class="btn" href="${base}/download" title="Save as an HTML file">${icon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>')}<span class="label">Save</span></a>
<button class="btn" id="full" type="button" title="Full screen">${icon('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>')}<span class="label">Full screen</span></button>
</div></div>
<main class="stage"><div class="frame" id="frame"><iframe id="app" src="${base}/app" sandbox="allow-scripts" title="${t}"></iframe></div></main>
<div class="note" id="note" role="alert"><span class="dot"></span><div><b id="count"></b><pre id="msgs"></pre></div>
<button type="button" id="close" aria-label="Dismiss">${icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}</button></div>
<script nonce="${nonce}">
var note=document.getElementById("note"),msgs=document.getElementById("msgs"),count=document.getElementById("count"),app=document.getElementById("app"),n=0;
function clear(){n=0;msgs.textContent="";note.classList.remove("on")}
addEventListener("message",function(e){var m=e.data&&e.data["cinderpaw-preview-error"];if(typeof m!=="string")return;
n++;count.textContent=n===1?"1 problem in this page":n+" problems in this page";msgs.textContent+=(msgs.textContent?"\\n":"")+m;note.classList.add("on")});
document.getElementById("reload").onclick=function(){clear();app.src=app.src};
document.getElementById("close").onclick=function(){note.classList.remove("on")};
document.getElementById("full").onclick=function(){var f=document.getElementById("frame");(f.requestFullscreen||f.webkitRequestFullscreen).call(f)};
</script></body></html>`;
}

/** The bundled assets the frame page may ask for, by the name it uses. */
const ASSETS: Record<string, { path: string; type: string }> = {
  "geist-latin.woff2": { path: geistLatin, type: "font/woff2" },
  "geist-latin-ext.woff2": { path: geistLatinExt, type: "font/woff2" },
  "young-serif-latin.woff2": { path: youngSerifLatin, type: "font/woff2" },
  "young-serif-latin-ext.woff2": { path: youngSerifLatinExt, type: "font/woff2" },
  "cubby.png": { path: cubbyIcon, type: "image/png" },
};

const NOT_FOUND =
  "This preview link is not valid any more. Links stop working when Cinderpaw restarts: " +
  "ask Cinderpaw for a new link.";

export class ArtifactPreviewServer {
  readonly #store: ArtifactStore;
  /** secret -> artifact id */
  readonly #links = new Map<string, string>();
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(store: ArtifactStore) {
    this.#store = store;
  }

  /**
   * The link for one artifact. Starts the listener on first use, so a machine
   * that never previews anything has no open port.
   */
  async url(a: Artifact): Promise<string> {
    if (!PREVIEWABLE.has(a.kind)) {
      throw new Error(
        `"${a.title}" is a ${a.kind}, and only pages (app, html) open in a browser. ` +
          "Use artifact_export to give the person the file instead.",
      );
    }
    const secret = randomBytes(24).toString("base64url"); // 32 characters
    this.#links.set(secret, a.id);
    const server = this.#listen();
    return `http://127.0.0.1:${server.port}/p/${secret}`;
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = null;
  }

  #listen(): ReturnType<typeof Bun.serve> {
    if (this.#server) return this.#server;
    this.#server = Bun.serve({
      // Loopback only: the LAN never sees an artifact.
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.#handle(req),
    });
    return this.#server;
  }

  async #handle(req: Request): Promise<Response> {
    const m = /^\/p\/([A-Za-z0-9_-]{32})(?:\/(app|download|f\/([a-z0-9.-]+)))?\/?$/.exec(new URL(req.url).pathname);
    const id = m ? this.#links.get(m[1]!) : undefined;
    const a = id ? this.#store.get(id) : null;
    if (!m || !a) {
      return new Response(NOT_FOUND, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const base = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
    const [, secret, route, asset] = m;

    if (asset) {
      const file = ASSETS[asset];
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(file.path), { headers: { "Content-Type": file.type, "Cache-Control": "max-age=86400" } });
    }

    if (route === "app" || route === "download") {
      // The app, always at its current version, so a fix shows on reload.
      const file = await artifactFile(this.#store, a);
      const html = typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
      // Saved as the person would want the file: the page alone, without our error relay.
      const headers: Record<string, string> = { ...base, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts" };
      if (route === "download") headers["Content-Disposition"] = `attachment; filename="${safeFileName(a.title)}.html"`;
      return new Response(route === "app" ? withErrorRelay(html) : html, { headers });
    }

    const nonce = randomBytes(16).toString("base64");
    return new Response(framePage(a.title, `/p/${secret}`, nonce), {
      headers: {
        ...base,
        "Content-Type": "text/html; charset=utf-8",
        // Our page runs only its own one script; it may frame and load only from this server.
        "Content-Security-Policy":
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src 'self'; font-src 'self'; img-src 'self'`,
        "X-Frame-Options": "DENY",
      },
    });
  }
}
