/**
 * The transcript must not change a message's height while it scrolls into view.
 *
 * `content-visibility: auto` on `.message-row` drew an off-screen message as a
 * 120px guess and only laid it out when it came near: a long reply then grew
 * under the reader's eyes and everything around it slid, on every scroll up or
 * down (6 Oct 2026). Nothing in a build or a test showed it; only scrolling did.
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('src/styles/globals.css', 'utf8');

test('message rows are always laid out, never guessed', () => {
  const rules = [...CSS.matchAll(/\.message-row[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  for (const body of rules) expect(body).not.toMatch(/content-visibility\s*:\s*auto/);
});
