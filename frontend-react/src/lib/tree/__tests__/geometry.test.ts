import { describe, it, expect } from 'vitest';
import { skeletonToBuffers } from '../geometry';
import type { Skeleton } from '../skeleton';

const skel: Skeleton = {
  segments: [
    { x0: 0.5, y0: 0, x1: 0.5, y1: 0.3, width0: 0.05, width1: 0.03, depth: 0 },
    { x0: 0.5, y0: 0.3, x1: 0.6, y1: 0.5, width0: 0.03, width1: 0.02, depth: 1 },
  ],
  leaves: [
    { x: 0.6, y: 0.5, size: 0.02, angle: 1.0, clusterId: 0 },
    { x: 0.55, y: 0.48, size: 0.015, angle: 2.0, clusterId: 1 },
  ],
};

describe('skeletonToBuffers', () => {
  it('emits 6 vertices (12 floats) per segment for the ribbon', () => {
    const b = skeletonToBuffers(skel);
    expect(b.branchVertexCount).toBe(skel.segments.length * 6);
    expect(b.branchPositions.length).toBe(skel.segments.length * 6 * 2);
    expect(b.branchShade.length).toBe(skel.segments.length * 6);
  });

  it('emits 4 floats per leaf instance', () => {
    const b = skeletonToBuffers(skel);
    expect(b.leafInstanceCount).toBe(skel.leaves.length);
    expect(b.leafInstances.length).toBe(skel.leaves.length * 4);
    const leaf0 = Array.from(b.leafInstances.slice(0, 4));
    expect(leaf0[0]).toBeCloseTo(0.6);
    expect(leaf0[1]).toBeCloseTo(0.5);
    expect(leaf0[2]).toBeCloseTo(0.02);
    expect(leaf0[3]).toBeCloseTo(1.0);
  });

  it('deeper segments are shaded brighter (warm rim grows toward tips)', () => {
    const b = skeletonToBuffers(skel);
    // First vertex of segment 0 (depth 0) vs segment 1 (depth 1).
    const shade0 = b.branchShade[0];
    const shade1 = b.branchShade[6];
    expect(shade1).toBeGreaterThan(shade0);
  });
});
