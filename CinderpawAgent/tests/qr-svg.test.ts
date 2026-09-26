import { expect, test } from "bun:test";
import { qrSvg } from "../src/transports/qr-svg.ts";

test("a QR is drawn as square modules on white, with a quiet border", () => {
  // A WhatsApp pairing payload is about this long.
  const svg = qrSvg("2@" + "A".repeat(200) + ",x,y,z");
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const modules = size - 8;
  // Every QR version is 21 + 4k modules wide.
  expect(modules >= 21 && (modules - 21) % 4 === 0).toBe(true);
  expect(svg).toContain('fill="#fff"');
  // The top-left finder pattern starts inside the 4-module border.
  expect(svg).toContain("M4 4h1v1h-1z");
  expect(svg).not.toContain("M3 ");
});
