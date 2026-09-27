"""Fit the model's parts to the board's outlines and write fit.json for build_character.py.

Every part is fitted in the board's own units (1 = 50 board px, floor at 0), which are the
units build_character.py uses before it raises the upper body by LEG_LIFT:
  hood   front + side outline -> half width, half depth, half height, centre, squareness
  visor  cream area inside the hood -> half width, half height, centre
  horns  outline outside the hood -> curve points and radii (the same clamped B-spline
         Blender's NURBS tube uses, round tip included), then their depth from the side
  body   central part of each row between the arms -> half width, half height, centre
  arms   outline outside body and hood -> curve points and radii
  eyes   the two dark shapes inside the visor -> centre, half width, half height
The legs and tail are his choices, not the board's.

  python fit_board.py
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy import optimize
from scipy.interpolate import BSpline

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\5f5d22c7-9595-47c2-88f4-11e37566cf17.png"
BOXES = {"front": (975, 95, 1120, 268), "side": (1310, 95, 1440, 268)}
UP, PPU = 2, 100              # work at 2x the board: 100 px per unit


def load(view):
    x0, y0, x1, y1 = BOXES[view]
    a = np.asarray(Image.open(BOARD).convert("RGB").crop((x0, y0, x1, y1))
                   .resize(((x1 - x0) * UP, (y1 - y0) * UP), Image.BICUBIC)).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    orange = (r - b > 50) & (r - g > 40) & (r > 90)
    dark = (r < 80) & (g < 80) & (b < 80)
    lab, n = ndi.label(ndi.binary_fill_holes(orange | dark))
    sil = lab == (np.argmax(ndi.sum(lab > 0, lab, range(1, n + 1))) + 1)
    ys, xs = np.nonzero(sil)
    mid, floor = (xs.min() + xs.max()) / 2, ys.max()
    yy, xx = np.mgrid[0:sil.shape[0], 0:sil.shape[1]]
    H = (xx - mid) / PPU            # units right of the middle (front: x, side: y)
    Z = (floor - yy) / PPU          # units above the floor
    cream = ndi.binary_opening(sil & ~orange & ~dark, iterations=2)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    return sil, cream, sil & (lum < 140), H, Z


def iou(a, b, where=None):
    if where is not None:
        a, b = a & where, b & where
    return (a & b).sum() / max(1, (a | b).sum())


def superellipse(H, Z, hw, hh, cz, e, ch=0.0):
    return (np.abs((H - ch) / hw) ** (2 / e) + np.abs((Z - cz) / hh) ** (2 / e)) <= 1.0


front, front_cream, front_dark, FX, FZ = load("front")
side, _, _, SY, SZ = load("side")
fit = {}

# ---- hood: front gives width/height/centre/squareness, side gives depth and its offset
head_zone_f = (FZ > 1.0) & ~((np.abs(FX) > 0.55) & (FZ > 2.35))      # no body, no horn corners
hood_f = ndi.binary_fill_holes(front) & head_zone_f
cost = lambda p: -iou(superellipse(FX, FZ, *p), hood_f, head_zone_f)
a, c, cz, e = optimize.minimize(cost, [1.13, 0.86, 1.87, 0.6], method="Nelder-Mead",
                                options={"xatol": 1e-3, "fatol": 1e-4, "maxiter": 600}).x
head_zone_s = (SZ > 1.0) & (SZ < 2.55)                               # the side horn stands on top
hood_s = side & head_zone_s
cost = lambda p: -iou(superellipse(SY, SZ, p[0], c, cz, e, p[1]), hood_s, head_zone_s)
b, cy = optimize.minimize(cost, [0.9, 0.0], method="Nelder-Mead").x
fit["hood"] = dict(half_width=a, half_depth=b, half_height=c, centre_z=cz, centre_y=cy, e=e,
                   iou_front=iou(superellipse(FX, FZ, a, c, cz, e), hood_f, head_zone_f),
                   iou_side=iou(superellipse(SY, SZ, b, c, cz, e, cy), hood_s, head_zone_s))
head_f = superellipse(FX, FZ, a, c, cz, e)
head_s = superellipse(SY, SZ, b, c, cz, e, cy)

# ---- visor: the cream area inside the hood
visor = front_cream & head_f & (FZ > 1.2)
vz, vx = FZ[visor], FX[visor]
fit["visor"] = dict(half_width=(vx.max() - vx.min()) / 2, half_height=(vz.max() - vz.min()) / 2,
                    centre_z=(vz.max() + vz.min()) / 2)

# ---- eyes: the two biggest dark shapes in the visor, cut at half contrast between eye and
#      cream (lum 140) so the soft edge counts; half the bounding box is the radius. The first
#      cut (only near-black pixels) came out too narrow. Left/right averaged, the face is symmetric.
# only inside the visor: the orange hood is darker than lum 140 too
lab, n = ndi.label(front_dark & ndi.binary_fill_holes(visor))
big = np.argsort(ndi.sum(lab > 0, lab, range(1, n + 1)))[-2:] + 1
eyes = []
for i in big:
    ex, ez = FX[lab == i], FZ[lab == i]
    eyes.append((abs((ex.max() + ex.min()) / 2), (ez.max() + ez.min()) / 2, (ex.max() - ex.min()) / 2, (ez.max() - ez.min()) / 2))
fit["eye"] = dict(zip(("x", "z", "rx", "rz"), np.mean(eyes, axis=0)))


# ---- tubes: projected like Blender's NURBS tube (clamped cubic B-spline, radius on the same
#      basis, the far end closed by a dome grown from the tube's own radius)
def tube_mask(Hg, Zg, pts, radii, samples=80):
    pts, radii = np.asarray(pts, float), np.asarray(radii, float)
    end, before, r = pts[-1], pts[-2], radii[-1]
    d = (end - before) / (np.linalg.norm(end - before) + 1e-9)
    pts = np.vstack([pts] + [end + d * r * k for k in (0.55, 0.9, 1.0)])
    radii = np.concatenate([radii, [r * 0.84, r * 0.45, r * 0.02]])
    n, k = len(pts), min(3, len(pts) - 1)
    knots = np.concatenate([[0] * (k + 1), np.linspace(0, 1, n - k + 1)[1:-1], [1] * (k + 1)])
    t = np.linspace(0, 1, samples)
    cen = BSpline(knots, pts, k)(t)
    rad = BSpline(knots, radii, k)(t)
    img = Image.new("L", (Hg.shape[1], Hg.shape[0]), 0)
    dr = ImageDraw.Draw(img)
    h0, z0 = Hg[0, 0], Zg[0, 0]
    for (h, z), rr in zip(cen, rad):
        cx, cyy, rp = (h - h0) * PPU, (z0 - z) * PPU, max(rr, 0) * PPU
        dr.ellipse([cx - rp, cyy - rp, cx + rp, cyy + rp], fill=255)
    return np.asarray(img) > 127


def fit_tube(Hg, Zg, target, where, fixed_start, start_pts, start_r, hidden):
    def unpack(p):
        pts = [fixed_start] + [tuple(p[2 * i:2 * i + 2]) for i in range(len(start_pts))]
        return pts, list(p[2 * len(start_pts):])

    def cost(p):
        pts, radii = unpack(p)
        if min(radii) <= 0.01:
            return 1.0
        m = tube_mask(Hg, Zg, pts, radii) & ~hidden
        return -iou(m, target, where)

    p0 = np.array([c for pt in start_pts for c in pt] + list(start_r), float)
    res = optimize.minimize(cost, p0, method="Nelder-Mead",
                            options={"maxiter": 2500, "xatol": 1e-3, "fatol": 1e-4, "adaptive": True})
    pts, radii = unpack(res.x)
    return pts, radii, -res.fun


# ---- horns (front): only the part the hood does not cover can be seen, so only that is scored
hidden = ndi.binary_erosion(head_f, iterations=2)
horn_zone = (FZ > 2.1) & (FX > 0)
horn_target = front & ~head_f & horn_zone
horn_target |= (front & ~head_f & (FZ > 2.1) & (FX < 0))[:, ::-1] & horn_zone   # both horns, mirrored
pts, radii, score = fit_tube(FX, FZ, horn_target, horn_zone, (0.78, 2.38),
                             [(0.95, 2.58), (1.02, 2.78), (0.97, 2.96)], [0.30, 0.25, 0.17, 0.085], hidden)
# horns (side): same tube, find how far back it stands and how much it leans
side_zone = SZ > 2.3
side_target = side & ~head_s & side_zone
zs = [p[1] for p in pts]


def side_cost(q):
    y0, lean = q
    ys = [y0 + lean * (z - zs[0]) for z in zs]
    m = tube_mask(SY, SZ, list(zip(ys, zs)), radii) & ~ndi.binary_erosion(head_s, iterations=2)
    return -iou(m, side_target, side_zone)


# a coarse grid first: started from one guess, the search settled on a horn too far forward
grid = [(side_cost((y, l)), y, l) for y in np.arange(-0.3, 0.55, 0.05) for l in np.arange(-0.6, 0.65, 0.1)]
_, gy, gl = min(grid)
(y0, lean) = optimize.minimize(side_cost, [gy, gl], method="Nelder-Mead").x
fit["horn"] = dict(points=[[x, y0 + lean * (z - zs[0]), z] for x, z in pts], radii=radii,
                   iou_front=score, iou_side=-side_cost((y0, lean)))

# ---- body: on the board the arms touch the body almost all the way down, so its width is
#      read only on rows where the arm tips stand apart (three runs: arm, body, arm)
widths = []
for r in range(front.shape[0]):
    if not 0.2 < FZ[r, 0] < 1.0:
        continue
    lab, n = ndi.label(front[r])
    if n == 3:
        mid = np.nonzero(lab == 2)[0]
        widths.append((FX[0][mid].max() - FX[0][mid].min()) / 2)
fit["body"] = dict(half_width=float(np.median(widths)), rows_used=len(widths))

# ---- arms (front): what sticks out beside the body, below the hood
body_core = np.abs(FX) < fit["body"]["half_width"]
arm_zone = (FZ < 1.25) & (FZ > 0.2) & (FX > 0)
arm_target = front & ~body_core & ~head_f & arm_zone
arm_target |= (front & ~body_core & ~head_f & (FZ < 1.25) & (FZ > 0.2) & (FX < 0))[:, ::-1] & arm_zone
pts, radii, score = fit_tube(FX, FZ, arm_target, arm_zone, (0.40, 0.94),
                             [(0.56, 0.76), (0.66, 0.58), (0.72, 0.44)], [0.17, 0.16, 0.18, 0.20],
                             body_core | head_f)
fit["arm"] = dict(points=[[x, -0.02, z] for x, z in pts], radii=radii, iou_front=score)

json.dump(fit, open(os.path.join(HERE, "fit.json"), "w"), indent=1, default=float)
for part, v in fit.items():
    print(part, {k: (np.round(v, 3).tolist() if isinstance(v, (list, tuple)) else round(float(v), 3)) for k, v in v.items()})
