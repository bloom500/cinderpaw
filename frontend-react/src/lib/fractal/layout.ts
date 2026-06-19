import type { MemoryGraphSnapshot } from '@/lib/tauri';

export interface LaidOutNode {
  id: string;
  label: string;
  type: string;
  wx: number;   // world (complex-plane) x
  wy: number;   // world (complex-plane) y
  degree: number;
}

/** Deterministic string hash (FNV-1a) → seeds per-node placement so the layout
 *  is stable across reloads (no randomness, no physics). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff; // 0..1
}

/**
 * Place nodes on a deterministic phyllotaxis (sunflower) spiral around the
 * opening region, jittered by a per-id hash. Phyllotaxis spreads points evenly
 * with no clumping and reads naturally against the fractal's own spirals.
 * Coordinates are in the complex plane so they zoom 1:1 with the fractal.
 */
export function layoutNodes(snapshot: MemoryGraphSnapshot): LaidOutNode[] {
  const degree = new Map<string, number>();
  for (const e of snapshot.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // golden angle
  const SPREAD = 0.6;       // complex-plane radius of the cloud
  const CENTER_X = -0.745;  // Seahorse Valley (matches the opening view)
  const CENTER_Y = 0.113;
  const n = snapshot.nodes.length;
  return snapshot.nodes.map((node, i) => {
    const r = SPREAD * Math.sqrt((i + 0.5) / Math.max(1, n));
    const theta = i * GOLDEN + hash(node.id) * 0.4; // hash jitter breaks symmetry
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      wx: CENTER_X + r * Math.cos(theta),
      wy: CENTER_Y + r * Math.sin(theta),
      degree: degree.get(node.id) ?? 0,
    };
  });
}
