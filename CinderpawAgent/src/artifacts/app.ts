/**
 * `app` artifacts — one self-contained HTML file that can be interacted with.
 *
 * A chart is not a type. It is an app with no buttons. Making `chart` its own
 * artifact kind would have bought a second renderer, a second schema and a
 * second set of tools for the case where the user then asks "can I drag a
 * slider on that" and the answer has to be no. One kind covers charts,
 * sliders, dashboards, small simulations and calculators, and the agent writes
 * it in the language it already knows best.
 *
 * TWO RULES, AND NEITHER IS NEGOTIABLE.
 *
 * 1. **It runs in a sandbox with no same-origin.** Our desktop UI is a webview
 *    that can call `invoke()`. Model-authored HTML rendered with the app's own
 *    origin is a stored-XSS primitive pointed straight at the Tauri command
 *    surface, and the content can come from a web page the agent read or a file
 *    a stranger sent on one of 21 chat platforms. `allow-scripts` WITHOUT
 *    `allow-same-origin` gives the app its sliders and its canvas and gives it
 *    no way to reach anything of ours. The two flags together are documented as
 *    equivalent to removing the sandbox, so they must never both appear.
 *
 * 2. **Nothing is fetched at open time.** ECharts is inlined into the file when
 *    it is exported, not linked. A CDN in an artifact means the chart is blank
 *    on a plane, and it means a third party is told which of the user's own
 *    documents was just opened. Neither is acceptable in a local-first product.
 *
 * ponytail: the library is inlined at export, not stored in the artifact. The
 * stored file stays small, and updating the vendored bundle updates every
 * artifact exported after it.
 */

// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import echartsSource from "./vendor/echarts.min.js" with { type: "text" };

/**
 * What the agent writes to ask for charts. Spelled as a URL so it sits in an
 * ordinary `<script src>` and an app opened before export fails loudly (a
 * missing script) instead of silently rendering an empty box.
 */
export const ECHARTS_SENTINEL = "cinderpaw:echarts";

/**
 * The iframe attributes the panel must use. Exported as a constant so there is
 * one place to read the rule from, rather than a string copied into a JSX
 * attribute where a later edit can quietly add `allow-same-origin`.
 */
export const APP_IFRAME_SANDBOX = "allow-scripts";

/**
 * Any `<script>` whose `src` points at an ECharts build, ours or a CDN's.
 *
 * The CDN half is not generosity. A model writing a chart page reaches for
 * `<script src="https://cdn.jsdelivr.net/npm/echarts"></script>` by habit,
 * because that is what the entire internet's example code looks like. Matching
 * only our sentinel would produce an export that works on this machine today
 * and is blank the first time someone opens it on a train — a failure the
 * author never sees. So the habit is caught and rewritten.
 */
const ECHARTS_TAG =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*echarts[^"']*["'][^>]*>\s*<\/script>/gi;

/** Any remaining external subresource, after ECharts has been dealt with. */
const EXTERNAL_URL =
  /\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

export interface InlinedApp {
  html: string;
  /** True when a chart library was actually needed and inlined. */
  charts: boolean;
  /**
   * Absolute URLs the file still reaches for. Empty is the goal; anything here
   * is reported to the user, because a file that needs the network is a
   * different promise from the one this feature makes.
   */
  externals: string[];
}

/**
 * Turn a stored app into a file that runs anywhere, offline, on its own.
 *
 * Deliberately not silent about what it could not fix: `externals` is handed
 * back so the caller can say it out loud. A quiet best-effort here would mean
 * the person finds out on the machine where it matters, with no idea why.
 */
export function inlineApp(html: string): InlinedApp {
  let charts = false;
  const inlined = html.replace(ECHARTS_TAG, () => {
    charts = true;
    return `<script>\n${echartsSource as string}\n</script>`;
  });

  const externals: string[] = [];
  for (const m of inlined.matchAll(EXTERNAL_URL)) {
    const url = m[1]!;
    if (!externals.includes(url)) externals.push(url);
  }
  return { html: inlined, charts, externals };
}

/**
 * The instructions the agent needs to write one of these, kept next to the code
 * that enforces them so the two cannot drift.
 *
 * Short on purpose: this rides in a tool description, which is re-sent on every
 * completion the tool is advertised for.
 */
export const APP_AUTHORING_BRIEF =
  `A complete HTML document with its CSS and JS inline — it must run with no ` +
  `build step and no network. For charts, include ` +
  `<script src="${ECHARTS_SENTINEL}"></script> and use the ECharts global; the ` +
  `library is inlined on export, so never link a CDN. It runs sandboxed: no ` +
  `access to the user's files, no network, no parent page. Prefer plain DOM ` +
  `and a <canvas> over a framework.`;
