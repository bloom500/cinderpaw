/**
 * Pixel-art sprites for the reactive tree, in the Feral mascot palette
 * (black background + orange accents). Drawn directly onto a Canvas2D context
 * in integer-snapped blocks so the result reads as 8-bit when the canvas uses
 * `image-rendering: pixelated`. Pure draw helpers — no state, no RAF.
 */

export const PALETTE = {
  bg: '#000000',
  trunkDark: '#3a210f',
  trunkLight: '#5c3416',
  branch: '#6b3d18',
  leaf: '#e8731c', // primary orange
  leafDim: '#7a3d0e', // unlit / distant
  leafLit: '#ffd089', // recall highlight
  leafDead: '#1c1208', // pruned, falling
  spark: '#ffcf6b',
} as const;

/** Snap a coordinate to the pixel grid so blocks stay crisp. */
function snap(v: number, px: number): number {
  return Math.round(v / px) * px;
}

/** A single square "pixel" block. */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  px: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(snap(x, px), snap(y, px), px, px);
}

/** A pixelated line of blocks from (x0,y0) to (x1,y1), `thickness` blocks wide. */
export function drawPixelLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  px: number,
  color: string,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / px));
  const halfW = Math.max(px, Math.round((thickness * px) / 2));
  ctx.fillStyle = color;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    // Widen perpendicular to the line direction.
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (let w = -halfW; w <= halfW; w += px) {
      ctx.fillRect(snap(cx + nx * w, px), snap(cy + ny * w, px), px, px);
    }
  }
}

/** A small diamond/cross leaf sprite centered at (x,y). */
export function drawLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  px: number,
  color: string,
): void {
  const s = Math.max(1, size);
  // 5-block plus/diamond shape.
  drawBlock(ctx, x, y, px, color);
  drawBlock(ctx, x - px, y, px, color);
  drawBlock(ctx, x + px, y, px, color);
  drawBlock(ctx, x, y - px, px, color);
  drawBlock(ctx, x, y + px, px, color);
  if (s >= 4) {
    drawBlock(ctx, x - px, y - px, px, color);
    drawBlock(ctx, x + px, y + px, px, color);
  }
}

/** Pick a leaf color from its lit level (0 = rest, 1 = fully recall-lit). */
export function leafColor(lit: number): string {
  if (lit <= 0) return PALETTE.leaf;
  if (lit >= 1) return PALETTE.leafLit;
  // Simple two-stop blend toward the lit highlight.
  return lit > 0.5 ? PALETTE.leafLit : PALETTE.leaf;
}
