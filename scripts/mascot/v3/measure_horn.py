"""Measure the horn on the board's front turnaround and write it as a skin chain.

The horn is a tube with a round cross-section, so its front silhouette is fully described
by its centre line and its half-width along that line. This finds both from the picture
(medial axis + distance to the edge) and writes horn.json for build_character.py.

Run with plain Python (needs numpy, Pillow, scikit-image), not inside Blender:
  python measure_horn.py
"""
import json
import os
from collections import deque

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.morphology import medial_axis

BOARD = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\5f5d22c7-9595-47c2-88f4-11e37566cf17.png"
HERE = os.path.dirname(os.path.abspath(__file__))
UP = 2                       # upsample so the medial axis is smooth
PX_PER_UNIT = 50 * UP        # 1.0 unit = 100 px on the 2x crop = 50 px on the board

# the hood as built, so the horn can be separated from the head it grows out of
HEAD_CZ, HEAD_A, HEAD_C, HEAD_E1 = 1.79, 1.125, 0.89, 0.90

img = Image.open(BOARD).convert("RGB").crop((975, 95, 1120, 265))
img = img.resize((img.width * UP, img.height * UP), Image.BICUBIC)

a = np.asarray(img).astype(int)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
orange = (r - b > 70) & (r > 150)
dark = (r < 90) & (g < 90) & (b < 90)

# axis = midway between the eyes; floor = lowest orange pixel (the feet)
lab, n = ndi.label(dark)
sizes = ndi.sum(dark, lab, range(1, n + 1))
eyes = [ndi.center_of_mass(dark, lab, i + 1) for i in np.argsort(sizes)[-2:]]
axis_x = (eyes[0][1] + eyes[1][1]) / 2
floor_y = np.nonzero(orange)[0].max()

H, W = orange.shape
ys, xs = np.mgrid[0:H, 0:W]
X = (xs - axis_x) / PX_PER_UNIT
Z = (floor_y - ys) / PX_PER_UNIT
# the hood on the board, cream visor and eyes included (the visor is a hole in the orange)
hood_ref = ndi.binary_fill_holes(orange | dark) & (Z > 0.98)
# the horns sit on the top corners; leave that zone out when fitting the hood outline
scored = ~((np.abs(X) > 0.55) & (Z > 2.35))


def superellipse(a, c, cz, e):
    return (np.abs(X / a) ** (2 / e) + np.abs((Z - cz) / c) ** (2 / e)) <= 1.0


best = (0, None)
for a_ in np.arange(1.05, 1.23, 0.01):
    for c_ in np.arange(0.84, 1.00, 0.01):
        for cz_ in np.arange(1.72, 1.88, 0.01):
            for e_ in (0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9):
                m = superellipse(a_, c_, cz_, e_)
                iou = (m & hood_ref & scored).sum() / ((m | hood_ref) & scored).sum()
                if iou > best[0]:
                    best = (iou, (a_, c_, cz_, e_))
iou, (HEAD_A, HEAD_C, HEAD_CZ, HEAD_E1) = best
print(f"hood fit: half width {HEAD_A:.3f}  half height {HEAD_C:.3f}  centre z {HEAD_CZ:.3f}  e {HEAD_E1:.2f}  IoU {iou:.4f}")
head = superellipse(HEAD_A, HEAD_C, HEAD_CZ, HEAD_E1)


def chain_for(side):
    grown = ndi.binary_dilation(head, iterations=int(0.03 * PX_PER_UNIT))   # skip the anti-aliased rim
    m = orange & ~grown & (Z > 2.0) & ((X < 0) if side < 0 else (X > 0))
    lab, n = ndi.label(m)
    m = lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)
    skel, dist = medial_axis(m, return_distance=True)
    pts = set(zip(*np.nonzero(skel)))

    def nbrs(p):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                q = (p[0] + dy, p[1] + dx)
                if q != p and q in pts:
                    yield q

    def bfs(start):
        prev, seen, q = {start: None}, {start}, deque([start])
        while q:
            p = q.popleft()
            for nb in nbrs(p):
                if nb not in seen:
                    seen.add(nb)
                    prev[nb] = p
                    q.append(nb)
        return p, prev

    # longest skeleton path: from the lowest point, the farthest point, then back
    low = max(pts, key=lambda p: p[0])
    far, _ = bfs(low)
    other, prev = bfs(far)
    path = []
    p = other
    while p is not None:
        path.append(p)
        p = prev[p]
    if path[0][0] < path[-1][0]:
        path.reverse()                      # bottom (head) first, tip last
    idx = np.linspace(0, len(path) - 1, 6).round().astype(int)
    # abs(x) mirrors the left horn onto the right side, so both chains are for x > 0
    return [[abs(float(X[path[i]])), float(Z[path[i]]), float(dist[path[i]] / PX_PER_UNIT)] for i in idx]


left, right = chain_for(-1), chain_for(1)
horn = [[(l[k] + r_[k]) / 2 for k in range(3)] for l, r_ in zip(left, right)]
# root the chain inside the hood, a little below and inward of the first measured point
x0, z0, r0 = horn[0]
horn.insert(0, [x0 - 0.08, z0 - 0.12, r0 * 0.9])
json.dump({"right_horn": horn, "left_measured": left, "right_measured": right,
           "hood": {"half_width": HEAD_A, "half_height": HEAD_C, "centre_z": HEAD_CZ, "e": HEAD_E1, "iou": iou}},
          open(os.path.join(HERE, "horn.json"), "w"), indent=1)
for x, z, rr in horn:
    print(f"x {x:.3f}  z {z:.3f}  r {rr:.3f}")
