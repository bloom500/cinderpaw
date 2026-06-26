/**
 * Mascot frame previewer (Bun, zero deps).
 *
 *   bun tools/render-mascot.ts <state> [scale] [out.png]
 *   bun tools/render-mascot.ts idle 14
 *   bun tools/render-mascot.ts --all 8           # every state, one row each
 *   bun tools/render-mascot.ts --file frames.json 14 out.png
 *
 * Renders the pixel-art frame arrays to a PNG grid so the character can be
 * eyeballed while authoring (no browser needed).
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import { VARIANTS, PALETTE, type MascotState } from '../src/components/chat/mascot/frames.ts';

const BG: [number, number, number] = [24, 24, 27];
const GAP = 1;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  const typed = new Uint8Array(4 + len);
  typed.set(out.subarray(4, 8 + len));
  dv.setUint32(8 + len, crc32(typed));
  return out;
}
function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

function renderRow(frames: string[][], scale: number): { w: number; h: number; rgb: Uint8Array } {
  const fh = frames[0].length;
  const fw = frames[0][0].length;
  const cols = frames.length;
  const W = (fw * cols + GAP * (cols - 1)) * scale;
  const H = fh * scale;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = BG[0]; rgb[i * 3 + 1] = BG[1]; rgb[i * 3 + 2] = BG[2]; }
  frames.forEach((frame, fi) => {
    const xOff = fi * (fw + GAP) * scale;
    for (let r = 0; r < fh; r++) {
      for (let c = 0; c < fw; c++) {
        const hex = PALETTE[frame[r][c]];
        if (!hex) continue;
        const [R, G, B] = hexToRgb(hex);
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = ((r * scale + sy) * W + (xOff + c * scale + sx)) * 3;
            rgb[px] = R; rgb[px + 1] = G; rgb[px + 2] = B;
          }
        }
      }
    }
  });
  return { w: W, h: H, rgb };
}

function stackRows(rows: { w: number; h: number; rgb: Uint8Array }[], scale: number): { w: number; h: number; rgb: Uint8Array } {
  const W = Math.max(...rows.map((r) => r.w));
  const H = rows.reduce((n, r) => n + r.h + GAP * scale, 0);
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = BG[0]; rgb[i * 3 + 1] = BG[1]; rgb[i * 3 + 2] = BG[2]; }
  let yOff = 0;
  for (const row of rows) {
    for (let y = 0; y < row.h; y++)
      for (let x = 0; x < row.w; x++) {
        const src = (y * row.w + x) * 3, dst = ((yOff + y) * W + x) * 3;
        rgb[dst] = row.rgb[src]; rgb[dst + 1] = row.rgb[src + 1]; rgb[dst + 2] = row.rgb[src + 2];
      }
    yOff += row.h + GAP * scale;
  }
  return { w: W, h: H, rgb };
}

const args = process.argv.slice(2);
const out = args.find((a) => a.endsWith('.png')) ?? 'mascot-preview.png';
const scale = Number(args.find((a) => /^\d+$/.test(a)) ?? 12);

if (args[0] === '--file') {
  const raw = JSON.parse(readFileSync(args[1], 'utf8'));
  const rowsData: string[][][] = Array.isArray(raw[0][0]) ? raw : [raw];
  const { w, h, rgb } = stackRows(rowsData.map((f) => renderRow(f, scale)), scale);
  writeFileSync(out, encodePng(w, h, rgb));
  console.log(`wrote ${out} (${w}×${h}, from ${args[1]} @${scale}×)`);
} else if (args[0] === '--all') {
  const rows = (Object.keys(VARIANTS) as MascotState[]).map((s) => renderRow(VARIANTS[s][0], scale));
  const { w, h, rgb } = stackRows(rows, scale);
  writeFileSync(out, encodePng(w, h, rgb));
  console.log(`wrote ${out} (${w}×${h}, all states @${scale}×)`);
} else {
  const state = (args[0] ?? 'idle') as MascotState;
  if (!VARIANTS[state]) { console.error(`unknown state: ${state}`); process.exit(1); }
  const { w, h, rgb } = renderRow(VARIANTS[state][0], scale);
  writeFileSync(out, encodePng(w, h, rgb));
  console.log(`wrote ${out} (${w}×${h}, state=${state} @${scale}×)`);
}
