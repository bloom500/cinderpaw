/**
 * Memory Layers — painterly renderer. Single Canvas2D pass drawing a stylized
 * tree (see Download/001-005.png references) over a {@link TreeLayout}.
 *
 * The legacy pixel-skeleton is preserved as a path in this file; the active
 * render uses radial-gradient foliage + smooth-curved trunk/branches so the
 * output reads like the orange-canopy tree painted on a black void, not the
 * 8-bit dots that came before. Pure draw helpers — no RAF, no event handle.
 */
import type { TreeLayout, BranchGeom, LeafGeom } from './layout';
import {
  PALETTE,
  drawTrunk,
  drawBranch,
  drawFoliageCrown,
  drawFoliageBlob,
  seasonTint,
  clearFoliageCache,
  type Season,
} from './sprites';

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
  /** Optional season tint overlay — defaults to summer (no overlay). */
  season?: Season;
  /** Optional RSI trunk aura — see {@link PALETTE.rsiAuraDream} etc. */
  rsiAura?: string;
}

export interface TreeRenderer {
  render(layout: TreeLayout, view: TreeView, anim?: RenderAnim): void;
  /** Screen point → the branch index whose crown was hit, or null. */
  hitTestBranch(sx: number, sy: number, layout: TreeLayout, view: TreeView): number | null;
  /** Screen point → (branchIndex, leafIndex) for the nearest leaf within
   *  the branch's canopy, or null when no leaf is close enough. */
  hitTestLeaf(sx: number, sy: number, layout: TreeLayout, view: TreeView): { branch: number; leaf: number } | null;
  resize(): void;
  dispose(): void;
}

/** Ambient sway amplitude (CSS px) and angular frequency. */
const SWAY_AMP = 3.4;
const SWAY_FREQ = 0.0009;

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
    // Reset gradient cache — radii scale with the new canvas size.
    clearFoliageCache();
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
    const t = anim?.timeMs ?? 0;
    const rsiAura = anim?.rsiAura ?? PALETTE.rsiAuraIdle;
    const tint = seasonTint(anim?.season ?? 'summer');

    // Background: black void + subtle season tint wash.
    ctx!.fillStyle = PALETTE.bg;
    ctx!.fillRect(0, 0, canvas.width, canvas.height);
    if (tint !== PALETTE.seasonSummer) {
      ctx!.fillStyle = tint;
      ctx!.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Trunk (bottom → fork).
    const tBase = toScreen(layout.trunk.x0, layout.trunk.y0, view);
    const tTop = toScreen(layout.trunk.x1, layout.trunk.y1, view);
    drawTrunk(ctx!, layout.trunk.x0 * view.zoom + view.offsetX, tBase.y, tTop.y, layout.trunk.thickness * view.zoom * dpr, rsiAura);

    for (const branch of layout.branches) {
      const lit = anim?.branchLit?.get(branch.index) ?? 0;
      const pop = anim?.seedPop?.get(branch.index) ?? 1;

      // Branch curve from fork to tip.
      const b0 = toScreen(branch.x0, branch.y0, view);
      const b1 = toScreen(branch.x1, branch.y1, view);
      drawBranch(
        ctx!,
        b0.x, b0.y,
        b1.x, b1.y,
        branch.thickness * view.zoom * dpr,
        lit,
      );

      // Foliage crown — painterly cluster of overlapping blobs at the tip.
      const foliageR = (10 + Math.max(8, branch.leaves.length) * 1.6) * view.zoom * dpr;
      const swayX = sway(branch.x1, branch.y1, t);
      drawFoliageCrown(
        ctx!,
        b1.x + swayX * 0.4, b1.y,
        foliageR,
        branch.leaves.length,
        lit,
        branch.index * 31 + 7,
        swayX,
      );

      // On a fresh seed, scale a tiny gold spark at the tip.
      if (pop < 1) {
        ctx!.globalAlpha = 1 - pop;
        drawFoliageBlob(ctx!, b1.x + swayX * 0.4, b1.y - foliageR * 0.2, foliageR * (0.45 + pop * 0.5), 1);
        ctx!.globalAlpha = 1;
      }
    }

    // Pruned leaves — single small blob falling under gravity.
    for (const f of anim?.falling ?? []) {
      const drop = f.t * f.t * 90;
      const p = toScreen(f.x, f.y + drop, view);
      drawFoliageBlob(ctx!, p.x, p.y, 6 * view.zoom * dpr * (1 - f.t * 0.4), 0);
    }
  }

  function hitTestBranch(sx: number, sy: number, layout: TreeLayout, view: TreeView): number | null {
    let best: { idx: number; d: number } | null = null;
    for (const branch of layout.branches) {
      const c = toScreen(branch.x1, branch.y1, view);
      const d = Math.hypot(c.x / dpr - sx, c.y / dpr - sy);
      if (best === null || d < best.d) best = { idx: branch.index, d };
    }
    const radius = 56 * view.zoom;
    return best && best.d <= radius ? best.idx : null;
  }

  function hitTestLeaf(
    sx: number,
    sy: number,
    layout: TreeLayout,
    view: TreeView,
  ): { branch: number; leaf: number } | null {
    let best: { branch: number; leaf: number; d: number } | null = null;
    for (const branch of layout.branches) {
      const foliageR = (10 + Math.max(8, branch.leaves.length) * 1.6) * view.zoom;
      for (let k = 0; k < branch.leaves.length; k++) {
        const lx = branch.leaves[k]!.x;
        const ly = branch.leaves[k]!.y;
        const p = toScreen(lx, ly, view);
        const d = Math.hypot(p.x / dpr - sx, p.y / dpr - sy);
        if (best === null || d < best.d) best = { branch: branch.index, leaf: k, d };
      }
      // also include the tip itself as a virtual leaf
      const tip = toScreen(branch.x1, branch.y1, view);
      const dt = Math.hypot(tip.x / dpr - sx, tip.y / dpr - sy);
      if (best === null || dt < best.d) best = { branch: branch.index, leaf: branch.leaves.length - 1, d: dt };
      void foliageR;
    }
    const radius = 22 * view.zoom;
    return best && best.d <= radius ? { branch: best.branch, leaf: best.leaf } : null;
  }

  return { render, hitTestBranch, hitTestLeaf, resize, dispose: () => {} };
}

export type { BranchGeom, LeafGeom };
