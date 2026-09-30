"""Cinderpaw's in-game bone rig, from art/cheer.png (158x192).

Writes rig/rig.json: a mesh over the drawing (its outline plus a grid of
interior points, Delaunay-triangulated and kept inside the silhouette), the
bones measured on the drawing, and each vertex's weight per bone (inverse
distance to the bone to the 4th power, top two bones, normalised). The game
builds a Skeleton2D and a Polygon2D from it at runtime (scripts/rig.gd).

usage: python games/ember/rig/build_rig.py
"""
import json
import os

import numpy as np
from PIL import Image
from scipy.spatial import Delaunay
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, '..', 'art', 'cheer.png')
# name, parent, head (x, y), tail (x, y), in pixels of art/cheer.png.
BONES = [
    ('hips',   None,   (76, 166),  (76, 126)),
    ('body',   'hips', (76, 126),  (76, 112)),
    ('head',   'body', (76, 112),  (78, 40)),
    ('horn_l', 'head', (38, 46),   (22, 20)),
    ('horn_r', 'head', (119, 42),  (111, 10)),
    ('arm_l',  'body', (44, 116),  (14, 112)),
    ('arm_r',  'body', (112, 112), (146, 100)),
    ('tail',   'hips', (40, 152),  (18, 140)),
]
GRID = 12


def seg_dist(p, a, b):
    a, b = np.array(a, float), np.array(b, float)
    t = np.clip(((p - a) @ (b - a)) / max(1e-9, (b - a) @ (b - a)), 0, 1)
    return np.linalg.norm(p - (a + np.outer(t, b - a)), axis=1)


def main():
    alpha = np.asarray(Image.open(ART).convert('RGBA'))[..., 3] >= 128
    contour = max(measure.find_contours(alpha.astype(float), 0.5), key=len)
    outline = measure.approximate_polygon(contour, tolerance=1.2)[:-1][:, ::-1]  # (x, y), open ring
    h, w = alpha.shape
    gx, gy = np.meshgrid(np.arange(GRID / 2, w, GRID), np.arange(GRID / 2, h, GRID))
    grid = np.c_[gx.ravel(), gy.ravel()]
    inside = grid[alpha[grid[:, 1].astype(int), grid[:, 0].astype(int)]]
    far = np.min(np.linalg.norm(inside[:, None] - outline[None], axis=2), axis=1) > GRID * 0.5
    interior = inside[far]
    pts = np.vstack([outline, interior])  # Polygon2D wants the internal vertices last
    tris = [t for t in Delaunay(pts).simplices if alpha[int(pts[t, 1].mean()), int(pts[t, 0].mean())]]
    d = np.stack([seg_dist(pts, head, tail) for _, _, head, tail in BONES], axis=1)
    wts = 1.0 / (d + 2.0) ** 4
    top2 = np.argsort(-wts, axis=1)[:, :2]
    mask = np.zeros_like(wts, bool)
    np.put_along_axis(mask, top2, True, axis=1)
    wts = np.where(mask, wts, 0.0)
    wts /= wts.sum(axis=1, keepdims=True)
    rig = {
        'size': [w, h],
        'points': np.round(pts, 2).tolist(),
        'internal': int(len(interior)),
        'triangles': [[int(i) for i in t] for t in tris],
        'bones': [{'name': n, 'parent': p, 'head': list(a), 'tail': list(b), 'weights': np.round(wts[:, i], 4).tolist()}
                  for i, (n, p, a, b) in enumerate(BONES)],
    }
    with open(os.path.join(HERE, 'rig.json'), 'w') as f:
        json.dump(rig, f)
    print(f"rig.json: {len(pts)} points ({len(interior)} internal), {len(tris)} triangles, {len(BONES)} bones")


if __name__ == '__main__':
    main()
