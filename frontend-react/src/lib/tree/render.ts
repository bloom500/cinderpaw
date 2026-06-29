/**
 * Canvas2D immediate-mode renderer for the reactive pixel tree. A single canvas
 * draws the trunk + branch segments + leaf sprites each frame. RAF is owned by
 * the page and runs only during ambient sway + active pulses; this module is a
 * pure draw + hit-test surface over a {@link TreeLayout}.
 *
 * Not pixel-tested in jsdom (Canvas2D is a no-op there) — visual confirmation is
 * the GPU smoke test. The geometry it consumes is unit-tested in `layout.ts`.
 */
import type { TreeLayout, BranchGeom } from './layout';
import { PALETTE, drawPixelLine, drawLeaf, leafColor } from './sprites';

export interface TreeView {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export const DEFAULT_TREE_VIEW: TreeView = { offsetX: 0, offsetY: 0, zoom: 1 };

export interface RenderAnim {
  /** Elapsed clock for ambient sway. */
  timeMs: number;
  /** branchIndex → recall-lit level 0..1. */
  branchLit?: Map<number, number>;
  /** Seed pop-ins: branchIndex → newest-leaf scale-up progress 0..1. */
  seedPop?: Map<number, number>;
  /** Prune leaves falling: world position + progress 0..1 (1 = gone). */
  falling?: { x: number; y: number; t: number }[];
}

export interface TreeRenderer {
  render(layout: TreeLayout, view: TreeView, anim?: RenderAnim): void;
  /** Screen point → the branch index whose crown was hit, or null. */
  hitTestBranch(sx: number, sy: number, layout: TreeLayout, view: TreeView): number | null;
  resize(): void;
  dispose(): void;
}

/** Pixel block size in CSS px (kept constant for crisp 8-bit blocks). */
const PX = 3;
/** Ambient sway amplitude (CSS px) and angular frequency. */
const SWAY_AMP = 2.2;
const SWAY_FREQ = 0.0011;

export function createTreeRenderer(canvas: HTMLCanvasElement): TreeRenderer | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

  function resize(): void {
    dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  resize();

  const toScreen = (wx: number, wy: number, view: TreeView) => ({
    x: (wx * view.zoom + view.offsetX) * dpr,
    y: (wy * view.zoom + view.offsetY) * dpr,
  });

  /** Per-leaf horizontal sway offset (world px), deterministic by position. */
  const sway = (wx: number, wy: number, timeMs: number) =>
    Math.sin(timeMs * SWAY_FREQ + (wx + wy) * 0.05) * SWAY_AMP;

  function render(layout: TreeLayout, view: TreeView, anim?: RenderAnim): void {
    const px = PX * dpr;
    const t = anim?.timeMs ?? 0;
    ctx!.fillStyle = PALETTE.bg;
    ctx!.fillRect(0, 0, canvas.width, canvas.height);

    // Trunk.
    const t0 = toScreen(layout.trunk.x0, layout.trunk.y0, view);
    const t1 = toScreen(layout.trunk.x1, layout.trunk.y1, view);
    drawPixelLine(ctx!, t0.x, t0.y, t1.x, t1.y, layout.trunk.thickness, px, PALETTE.trunkLight);

    for (const branch of layout.branches) {
      const lit = anim?.branchLit?.get(branch.index) ?? 0;
      const b0 = toScreen(branch.x0, branch.y0, view);
      const b1 = toScreen(branch.x1, branch.y1, view);
      drawPixelLine(ctx!, b0.x, b0.y, b1.x, b1.y, Math.max(1, branch.thickness * 0.6), px, PALETTE.branch);

      const pop = anim?.seedPop?.get(branch.index) ?? 1;
      branch.leaves.forEach((leaf, k) => {
        const swayX = sway(leaf.x, leaf.y, t);
        const p = toScreen(leaf.x + swayX, leaf.y, view);
        // The newest leaf in a branch scales up on a seed pulse.
        const isNewest = k === branch.leaves.length - 1;
        const scale = isNewest ? pop : 1;
        const size = Math.max(1, leaf.size * scale);
        drawLeaf(ctx!, p.x, p.y, size, px, leafColor(lit));
        if (lit > 0.6 && isNewest) {
          drawLeaf(ctx!, p.x, p.y - px, 2, px, PALETTE.spark);
        }
      });
    }

    // Pruned leaves falling under gravity, blackening as they go.
    for (const f of anim?.falling ?? []) {
      const drop = f.t * f.t * 90; // ease-in gravity in world px
      const p = toScreen(f.x, f.y + drop, view);
      const color = f.t > 0.6 ? PALETTE.leafDead : PALETTE.leafDim;
      drawLeaf(ctx!, p.x, p.y, 3 * (1 - f.t * 0.5), px, color);
    }
  }

  function hitTestBranch(sx: number, sy: number, layout: TreeLayout, view: TreeView): number | null {
    // Find the branch whose crown center is nearest the click, within radius.
    let best: { idx: number; d: number } | null = null;
    for (const branch of layout.branches) {
      const c = toScreen(branch.x1, branch.y1, view);
      const d = Math.hypot(c.x / dpr - sx, c.y / dpr - sy);
      if (best === null || d < best.d) best = { idx: branch.index, d };
    }
    const radius = 40 * view.zoom;
    return best && best.d <= radius ? best.idx : null;
  }

  return { render, hitTestBranch, resize, dispose: () => {} };
}

export type { BranchGeom };
