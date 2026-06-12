/**
 * Renders mascot frames to a PNG sprite sheet for visual review.
 * Usage: bun tools/render-mascot.ts <frames-module> <out.png> [stateFilter]
 * No deps: minimal PNG encoder using node:zlib.
 */
import { deflateSync } from "node:zlib";

const [, , modPath, outPath, stateFilter] = process.argv;
if (!modPath || !outPath) {
  console.error("usage: bun tools/render-mascot.ts <frames-module> <out.png> [state]");
  process.exit(1);
}

const mod = await import(modPath);
const { VARIANTS, PALETTE, FRAME_W, FRAME_H } = mod;

const SCALE = 8;
const PAD = 6;
const BG: [number, number, number] = [24, 24, 27]; // app dark bg
const LABEL_COL: [number, number, number] = [90, 90, 96];

// --- tiny 3x5 pixel font for labels ---
const FONT: Record<string, number[]> = {
  a:[0b010,0b101,0b111,0b101,0b101], b:[0b110,0b101,0b110,0b101,0b110],
  c:[0b011,0b100,0b100,0b100,0b011], d:[0b110,0b101,0b101,0b101,0b110],
  e:[0b111,0b100,0b110,0b100,0b111], f:[0b111,0b100,0b110,0b100,0b100],
  g:[0b011,0b100,0b101,0b101,0b011], h:[0b101,0b101,0b111,0b101,0b101],
  i:[0b111,0b010,0b010,0b010,0b111], k:[0b101,0b110,0b100,0b110,0b101],
  l:[0b100,0b100,0b100,0b100,0b111], m:[0b101,0b111,0b111,0b101,0b101],
  n:[0b101,0b111,0b111,0b111,0b101], o:[0b010,0b101,0b101,0b101,0b010],
  p:[0b110,0b101,0b110,0b100,0b100], r:[0b110,0b101,0b110,0b110,0b101],
  s:[0b011,0b100,0b010,0b001,0b110], t:[0b111,0b010,0b010,0b010,0b010],
  u:[0b101,0b101,0b101,0b101,0b111], v:[0b101,0b101,0b101,0b101,0b010],
  w:[0b101,0b101,0b111,0b111,0b101], x:[0b101,0b101,0b010,0b101,0b101],
  y:[0b101,0b101,0b010,0b010,0b010], z:[0b111,0b001,0b010,0b100,0b111],
  '0':[0b111,0b101,0b101,0b101,0b111],'1':[0b010,0b110,0b010,0b010,0b111],
  '2':[0b110,0b001,0b010,0b100,0b111],'3':[0b110,0b001,0b010,0b001,0b110],
  '4':[0b101,0b101,0b111,0b001,0b001],'5':[0b111,0b100,0b110,0b001,0b110],
  '6':[0b011,0b100,0b110,0b101,0b010],'7':[0b111,0b001,0b010,0b010,0b010],
  '8':[0b010,0b101,0b010,0b101,0b010],'9':[0b010,0b101,0b011,0b001,0b110],
  ' ':[0,0,0,0,0],
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// layout: one row per state; each variant's frames side by side, gap between variants
const states = Object.keys(VARIANTS).filter((s) => !stateFilter || s === stateFilter);
const labelH = 8;
const cellW = FRAME_W * SCALE + PAD;
let maxRowW = 0;
for (const s of states) {
  const variants = VARIANTS[s];
  let w = PAD;
  for (const v of variants) w += v.length * cellW + PAD * 2;
  maxRowW = Math.max(maxRowW, w);
}
const rowH = FRAME_H * SCALE + PAD * 2 + labelH;
const W = maxRowW + PAD;
const H = states.length * rowH + PAD;

const img = new Uint8Array(W * H * 3);
function setPx(x: number, y: number, c: [number, number, number]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2];
}
for (let i = 0; i < W * H; i++) {
  img[i * 3] = BG[0]; img[i * 3 + 1] = BG[1]; img[i * 3 + 2] = BG[2];
}
function drawText(x: number, y: number, text: string) {
  let cx = x;
  for (const ch of text.toLowerCase()) {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (glyph[r] & (1 << (2 - c))) setPx(cx + c, y + r, LABEL_COL);
    cx += 4;
  }
}

let y = PAD;
for (const s of states) {
  drawText(PAD, y, s);
  let x = PAD;
  const variants = VARIANTS[s];
  for (let vi = 0; vi < variants.length; vi++) {
    for (const frame of variants[vi]) {
      for (let r = 0; r < FRAME_H; r++) {
        for (let c = 0; c < FRAME_W; c++) {
          const color = PALETTE[frame[r][c]];
          if (!color) continue;
          const rgb = hexToRgb(color);
          for (let dy = 0; dy < SCALE; dy++)
            for (let dx = 0; dx < SCALE; dx++)
              setPx(x + c * SCALE + dx, y + labelH + r * SCALE + dy, rgb);
        }
      }
      x += cellW;
    }
    // variant separator tick
    for (let t = 0; t < FRAME_H * SCALE; t++) setPx(x, y + labelH + t, [50, 50, 55]);
    x += PAD * 2;
  }
  y += rowH;
}

// --- PNG encode ---
function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(new TextEncoder().encode(type), 0);
  crcBuf.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}
const ihdr = new Uint8Array(13);
{
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
}
const raw = new Uint8Array(H * (W * 3 + 1));
for (let r = 0; r < H; r++) {
  raw[r * (W * 3 + 1)] = 0;
  raw.set(img.subarray(r * W * 3, (r + 1) * W * 3), r * (W * 3 + 1) + 1);
}
const png = new Uint8Array([
  ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ...chunk("IHDR", ihdr),
  ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
  ...chunk("IEND", new Uint8Array(0)),
]);
await Bun.write(outPath, png);
console.log(`wrote ${outPath} (${W}x${H}, ${states.length} states)`);
