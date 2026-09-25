import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Reply } from "./Reply";

test("Markdown is drawn, not shown as stars and ticks", () => {
  const html = renderToStaticMarkup(<Reply text={"**On your phone:** open `Settings`\n\n- one\n- two"} />);
  expect(html).toContain("<strong>On your phone:</strong>");
  expect(html).toContain("<code>Settings</code>");
  expect(html).toContain("<li>one</li>");
  expect(html).not.toContain("**");
});

test("raw HTML from the model never reaches the page", () => {
  const html = renderToStaticMarkup(<Reply text={'hi <script>alert(1)</script> <img src=x onerror="alert(1)">'} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
});

test("links open outside the page", () => {
  expect(renderToStaticMarkup(<Reply text="[docs](https://cinderpaw.dev)" />)).toContain('target="_blank" rel="noopener noreferrer"');
});
