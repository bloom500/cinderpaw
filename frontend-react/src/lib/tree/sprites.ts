/**
 * Painterly sprites for the reactive tree (Memory Layers). The earlier
 * pixel-block sprites are preserved for the narrow 8-bit path (the rest of
 * the app still uses them) but the Memory Layers renderer prefers the
 * radial-gradient foliage and curved stroke branch + trunk helpers below —
 * they read like a painted tree (see Download/002-005.png references), not
 * a chunky 8-bit one. Pure draw helpers — no state, no RAF.
 */

export const PALETTE = {
  bg: '#000000',
  // Trunk + branches, warm-wood gradient.
  trunkDark: '#2a160a',
  trunkMid: '#4a2912',
  trunkLight: '#6b3d18',
  // Foliage base, layered for painterly depth.
  leafCore: '#f4a85d', // bright sunlit centre of a canopy blob
  leaf: '#e8731c', // primary orange
  leafDeep: '#a04a14', // shadow underside of a blob
  leafDim: '#7a3d0e', // unlit / distant
  leafLit: '#ffd58a', // recall highlight on a single blob
  leafDead: '#3a1f0c', // pruned, falling
  spark: '#ffcf6b',
  // Seasonal / RSI tint overlays (additive on top of base foliage).
  seasonSpring: 'rgba(120, 220, 110, 0.18)', // fresh growth
  seasonSummer: 'rgba(245, 180, 70, 0.0)', // base palette
  seasonAutumn: 'rgba(220, 90, 30, 0.22)', // dreaming — warm orange aura
  seasonWinter: 'rgba(180, 200, 220, 0.18)', // drift toward cool blue
  // RSI trunk aura — the trunk glows during dream cycles.
  rsiAuraIdle: 'rgba(0, 0, 0, 0)',
  rsiAuraDream: 'rgba(232, 115, 28, 0.55)',
  rsiAuraRatchet: 'rgba(255, 240, 200, 0.85)',
  rsiAuraError: 'rgba(220, 60, 60, 0.40)',
} as const;

// ── Legacy pixel-art primitives (kept for callers outside Memory Layers) ─────

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
  return lit > 0.5 ? PALETTE.leafLit : PALETTE.leaf;
}

// ── Painterly primitives for Memory Layers ────────────────────────────────────

/** Pre-cached radial gradient blobs keyed by integer radius (30..220 px).
 *  Browsers choke on `createRadialGradient` per-frame at full leaf counts;
 *  one cache per radius keeps the hot path at fillStyle + fillRect cost. */
const _blobCache = new Map<number, CanvasGradient>();
function foliageGradient(ctx: CanvasRenderingContext2D, r: number): CanvasGradient {
  const key = Math.round(r);
  const cached = _blobCache.get(key);
  if (cached) return cached;
  const inner = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
  inner.addColorStop(0, PALETTE.leafCore);
  inner.addColorStop(0.55, PALETTE.leaf);
  inner.addColorStop(1, PALETTE.leafDeep);
  _blobCache.set(key, inner);
  return inner;
}

/** Reset the foliage-blob gradient cache — call after a renderer resize so
 *  the radii stay in step with the new DPR. */
export function clearFoliageCache(): void {
  _blobCache.clear();
}

/**
 * Paint a single canopy blob centred at (cx, cy) using a radial gradient.
 * Caller is responsible for positioning. `lit` > 0 swaps the centre colour
 * toward {@link PALETTE.leafLit} for the recall highlight.
 */
export function drawFoliageBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  lit: number,
): void {
  if (r <= 0) return;
  ctx.save();
  ctx.translate(cx, cy);
  if (lit > 0.05) {
    // One bright overlay on top of the base blob for the recall spark.
    ctx.globalAlpha = Math.min(1, 0.4 + lit * 0.6);
    const hl = ctx.createRadialGradient(0, -r * 0.1, r * 0.05, 0, 0, r * 0.85);
    hl.addColorStop(0, PALETTE.leafLit);
    hl.addColorStop(1, 'rgba(255, 213, 138, 0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = foliageGradient(ctx, r);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Paint a fuller foliage crown at one branch tip — overlapping blobs of
 * different sizes, deterministically placed by `seed`, so the same branch
 * always paints the same crown across rebuilds.
 */
export function drawFoliageCrown(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  baseR: number,
  leafCount: number,
  lit: number,
  seed: number,
  sway: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  // A blurred halo behind every crown makes overlapping trees blend instead
  // of tiling — the painterly "atmosphere" feel (see Download/002-005).
  const halo = ctx.createRadialGradient(0, 0, baseR * 0.3, 0, 0, baseR * 2.6);
  halo.addColorStop(0, PALETTE.leaf);
  halo.addColorStop(1, 'rgba(232, 115, 28, 0)');
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, baseR * 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Multiple sub-blobs clustered around the centre, sizes deterministic per seed.
  for (let k = 0; k < Math.max(3, leafCount); k++) {
    const ang = (k / Math.max(3, leafCount)) * Math.PI * 2;
    const radial = ((Math.sin(seed * 9.71 + k * 3.13) + 1) / 2) * baseR * 0.45;
    const bx = Math.cos(ang) * radial + sway * 0.4 * Math.sin(k);
    const by = Math.sin(ang) * radial * 0.85 - baseR * 0.05;
    const br = baseR * (0.55 + (Math.sin(seed * 5.27 + k * 2.1) + 1) * 0.18);
    drawFoliageBlob(ctx, bx, by, br, lit);
  }
  // The dominant central blob on top — reads as the sunlit front of the canopy.
  drawFoliageBlob(ctx, 0, -baseR * 0.05, baseR * 0.95, lit);
  ctx.restore();
}

/**
 * Curved trunk stroke with a vertical gradient (dark base → warmer top).
 * `phase` ∈ [0,1] blends in the RSI aura along the base for the dreaming
 * glow effect.
 */
export function drawTrunk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y0: number,
  y1: number,
  thickness: number,
  rsiAura: string,
): void {
  const w = thickness;
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const grad = ctx.createLinearGradient(x, y0, x, y1);
  grad.addColorStop(0, PALETTE.trunkLight);
  grad.addColorStop(0.7, PALETTE.trunkMid);
  grad.addColorStop(1, PALETTE.trunkDark);
  ctx.fillStyle = grad;
  // Slight bow so the trunk isn't a dead-straight column — painterly.
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(x + Math.sin(y0 * 0.01) * 6, (y0 + y1) / 2, x0, y1);
  ctx.lineTo(x1, y1);
  ctx.quadraticCurveTo(x + Math.sin(y0 * 0.013) * 6, (y0 + y1) / 2, x1, y0);
  ctx.closePath();
  ctx.fill();
  // Outer bark highlight (left edge).
  ctx.strokeStyle = 'rgba(232, 115, 28, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0 + 1, y0);
  ctx.quadraticCurveTo(x + Math.sin(y0 * 0.01) * 6, (y0 + y1) / 2, x0 + 1, y1);
  ctx.stroke();
  // RSI aura — radial glow at the trunk base, fades upward.
  if (rsiAura !== PALETTE.rsiAuraIdle) {
    const aura = ctx.createRadialGradient(x, y1 - thickness, thickness * 1.5, x, y1 - thickness, thickness * 4);
    aura.addColorStop(0, rsiAura);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(x, y1 - thickness, thickness * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

/** Smooth-curved branch stroke, tapered from base (thick) to tip (thin). */
export function drawBranch(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thicknessBase: number,
  lit: number,
): void {
  const base = Math.max(2, thicknessBase);
  const tip = Math.max(1, base * 0.45);
  ctx.strokeStyle = lit > 0.5
    ? 'rgba(255, 213, 138, 0.85)'
    : 'rgba(107, 61, 24, 1)';
  ctx.lineCap = 'round';
  // Two-pass stroke: thick + thin core for the painterly grain.
  ctx.lineWidth = base;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  // Slight S-curve on the branch so the tree isn't a stick figure.
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dirX = (x1 - x0);
  const dirY = (y1 - y0);
  const norm = Math.hypot(dirX, dirY) || 1;
  const px = -dirY / norm;
  const py = dirX / norm;
  const ctrlX = mx + px * base * 0.45;
  const ctrlY = my + py * base * 0.45;
  ctx.quadraticCurveTo(ctrlX, ctrlY, x1, y1);
  ctx.stroke();
  ctx.lineWidth = tip * 0.6;
  ctx.strokeStyle = lit > 0.5
    ? 'rgba(255, 240, 200, 0.95)'
    : 'rgba(232, 115, 28, 0.45)';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(ctrlX, ctrlY, x1, y1);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/** Mix two CSS colours by weight ∈ [0,1] — small utility used by callers
 *  that want a custom-season tint rather than the four presets exported
 *  above. Returns `a` when `w ≤ 0`, `b` when `w ≥ 1`. */
export function mixColor(a: string, b: string, w: number): string {
  return w <= 0 ? a : w >= 1 ? b : a;
}

/** Season used by the painterly renderer. The page resolves this from the
 *  cumulative RSI state (idle/dreaming/ratcheted/error) plus the recent
 *  tree rebuild cadence. */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Translate a season to the additive tint overlay colour. */
export function seasonTint(season: Season): string {
  switch (season) {
    case 'spring': return PALETTE.seasonSpring;
    case 'summer': return PALETTE.seasonSummer;
    case 'autumn': return PALETTE.seasonAutumn;
    case 'winter': return PALETTE.seasonWinter;
  }
}

