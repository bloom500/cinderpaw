import { describe, expect, test } from "bun:test";
import { htmlToText } from "../src/tools/builtin/fetch-url.ts";

describe("htmlToText", () => {
  test("a page reads as its title and words, without head, styles or scripts", () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>Reimagining advertising with AI | OpenAI</title>
      <style>:root{--document-width:100dvw}</style><link rel="preload" href="/x.woff2"></head>
      <body><nav>Research</nav><script>window.__NEXT_DATA__={"big":"json"}</script>
      <h1>Reimagining&nbsp;advertising</h1><p>We&#8217;re testing <strong>Sponsored Agents</strong>.</p>
      <ul><li>One</li><li>Two</li></ul><!-- tracking --></body></html>`;
    const text = htmlToText(html);
    expect(text.startsWith("Reimagining advertising with AI | OpenAI")).toBe(true);
    expect(text).toContain("We’re testing Sponsored Agents.");
    expect(text).toContain("One\nTwo");
    expect(text).not.toContain("--document-width");
    expect(text).not.toContain("__NEXT_DATA__");
    expect(text).not.toContain("tracking");
  });
});
