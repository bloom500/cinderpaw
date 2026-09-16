/**
 * `app` artifacts: the two rules, pinned.
 *
 * Both of these are the kind of thing that works on the machine it was written
 * on and fails somewhere else, which is the only reason they are tested rather
 * than documented. The sandbox one is a security boundary; the offline one is a
 * promise the product makes about what an exported file is.
 */

import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  APP_IFRAME_SANDBOX,
  ECHARTS_SENTINEL,
  inlineApp,
} from "../src/artifacts/app.ts";

const CHART_APP = `<!doctype html><html><body>
<div id="c" style="width:600px;height:400px"></div>
<script src="${ECHARTS_SENTINEL}"></script>
<script>echarts.init(document.getElementById('c')).setOption({series:[{type:'bar',data:[1,2,3]}]});</script>
</body></html>`;

describe("the sandbox rule", () => {
  test("allow-same-origin is never granted, because it would undo the sandbox", () => {
    // Granting both flags is documented as equivalent to removing the sandbox,
    // and our webview can call invoke(). Model-authored HTML with our origin is
    // a stored-XSS primitive pointed at the Tauri command surface.
    expect(APP_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(APP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });
});

describe("inlineApp", () => {
  test("the sentinel is replaced by a real library, not a link", () => {
    const out = inlineApp(CHART_APP);
    expect(out.charts).toBe(true);
    expect(out.html).not.toContain(ECHARTS_SENTINEL);
    // Big, because it is the whole library. If this ever passes with a few
    // hundred bytes, something is inlining a stub.
    expect(out.html.length).toBeGreaterThan(500_000);
    expect(out.html).toContain("Apache Software Foundation");
  });

  test("a CDN script tag is rewritten too, because that is what models write", () => {
    // The failure this prevents is invisible to its author: the page works on
    // the machine that has just been online, and is blank on a train.
    const cdn = CHART_APP.replace(
      ECHARTS_SENTINEL,
      "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js",
    );
    const out = inlineApp(cdn);
    expect(out.charts).toBe(true);
    expect(out.html).not.toContain("cdn.jsdelivr.net");
    expect(out.externals).toEqual([]);
  });

  test("the inlined bundle actually runs and defines echarts", () => {
    // The check that catches the worst silent failure: a vendored file that is
    // truncated, or the wrong file, still passes a size assertion and still
    // produces an export. It fails on the user's machine, as a blank rectangle
    // with an error in a console they do not have open. So the library is
    // pulled back OUT of the generated HTML and executed.
    const html = inlineApp(CHART_APP).html;
    const m = new RegExp("<script>" + '\\n' + "([\\s\\S]*?)" + '\\n' + "</script>").exec(html);
    expect(m).not.toBeNull();

    const sandbox: Record<string, unknown> = {
      navigator: { userAgent: "test" },
      document: {
        createElement: () => ({ style: {}, getContext: () => ({}) }),
        documentElement: { style: {} },
      },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    createContext(sandbox);
    runInContext(m![1]!, sandbox, { timeout: 30_000 });

    const lib = sandbox.echarts as { init?: unknown; version?: string } | undefined;
    expect(typeof lib?.init).toBe("function");
    expect(lib?.version).toBe("5.6.0");
  });

  test("an app with no chart stays small", () => {
    const plain = `<!doctype html><html><body><input type="range"><script>1</script></body></html>`;
    const out = inlineApp(plain);
    expect(out.charts).toBe(false);
    expect(out.html).toBe(plain);
  });

  test("anything still reaching the internet is reported, not hidden", () => {
    const leaky = `<html><head><link href="https://fonts.example/x.css"></head>
<body><img src="https://tracker.example/p.gif"></body></html>`;
    const out = inlineApp(leaky);
    expect(out.externals).toEqual([
      "https://fonts.example/x.css",
      "https://tracker.example/p.gif",
    ]);
  });

  test("the same external URL twice is reported once", () => {
    const twice = `<img src="https://a.example/x.png"><img src="https://a.example/x.png">`;
    expect(inlineApp(twice).externals).toEqual(["https://a.example/x.png"]);
  });
});
