"""Trace the Cinderpaw logo head from his logo board into a symmetric SVG, and score the fit."""
import json
import numpy as np
from PIL import Image, ImageDraw
from skimage import measure

SRC = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\fb5924d1-c01a-4475-8471-e02ccb08a885.png"
a = np.asarray(Image.open(SRC).convert("RGB")).astype(float)[480:760, 50:370]
g = a[..., 1]                                   # green splits orange/dark from paper/cream cleanly
LEVEL = 168.0

contours = [c[:, ::-1] for c in measure.find_contours(g, LEVEL)]   # (x, y)
contours = [c for c in contours if len(c) > 30]
def area(c): x, y = c[:, 0], c[:, 1]; return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
contours.sort(key=area, reverse=True)
head, visor = contours[0], contours[1]
rest = contours[2:6]
cy_head = head[:, 1].mean()
horns = sorted([c for c in rest if c[:, 1].mean() < head[:, 1].min() + 40], key=lambda c: c[:, 0].mean())
eyes = sorted([c for c in rest if c[:, 1].mean() > head[:, 1].min() + 40], key=lambda c: c[:, 0].mean())
assert len(horns) == 2 and len(eyes) == 2, (len(horns), len(eyes))

# symmetry axis: midway between the eye centres (the most reliable pair)
ecs = [c.mean(axis=0) for c in eyes]
AX = (ecs[0][0] + ecs[1][0]) / 2

def resample(c, n, start="top"):
    c = np.vstack([c, c[:1]])
    seg = np.sqrt((np.diff(c, axis=0) ** 2).sum(1)); s = np.concatenate([[0], np.cumsum(seg)])
    i0 = np.argmin(c[:-1, 1]) if start == "top" else 0
    c = np.vstack([c[i0:-1], c[:i0], c[i0:i0 + 1]])
    seg = np.sqrt((np.diff(c, axis=0) ** 2).sum(1)); s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n, endpoint=False)
    pts = np.stack([np.interp(t, s, c[:, 0]), np.interp(t, s, c[:, 1])], 1)
    # make orientation consistent (clockwise on screen)
    if area_signed(pts) < 0: pts = np.vstack([pts[:1], pts[1:][::-1]])
    return pts
def area_signed(p): x, y = p[:, 0], p[:, 1]; return 0.5 * (np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))

def symmetrize_closed(c, n):
    """Average a shape with its own mirror image about AX."""
    p = resample(c, n)
    m = p.copy(); m[:, 0] = 2 * AX - m[:, 0]
    m = resample(m, n)
    # align: both start at the top point; mirror reverses direction, handled by resample orientation
    k = np.argmin([np.abs(np.roll(m, -j, 0) - p).sum() for j in range(n)])
    m = np.roll(m, -k, 0)
    return (p + m) / 2

N = 48
head_s = symmetrize_closed(head, N)
visor_s = symmetrize_closed(visor, N)

# horns: average the left horn with the mirrored right horn
hl = resample(horns[0], 40); hr = horns[1].copy(); hr[:, 0] = 2 * AX - hr[:, 0]; hr = resample(hr, 40)
# the board's horns are not mirror images (the right one sits ~4px further out), so average
# the SHAPES with their centroids aligned, then place the result at the mean centroid
cl, cr = hl.mean(0), hr.mean(0)
hl0, hr0 = hl - cl, hr - cr
k = np.argmin([np.abs(np.roll(hr0, -j, 0) - hl0).sum() for j in range(40)]); hr0 = np.roll(hr0, -k, 0)
horn_l = (hl0 + hr0) / 2 + (cl + cr) / 2
horn_r = horn_l.copy(); horn_r[:, 0] = 2 * AX - horn_r[:, 0]; horn_r = horn_r[::-1]

# eyes: ellipse fit, then symmetric
em = []
for c in eyes:
    e = measure.EllipseModel(); e.estimate(c); em.append(e.params)   # xc, yc, a, b, theta
ex = abs(em[1][0] - em[0][0]) / 2; ey = (em[0][1] + em[1][1]) / 2
ea = np.mean([sorted(p[2:4]) for p in em], axis=0)   # (rx small, ry big)

# ---- normalise into a 256 box: head width -> 208, centred, head bottom at 236
hx0, hx1 = head_s[:, 0].min(), head_s[:, 0].max(); hy1 = head_s[:, 1].max()
S = 208 / (hx1 - hx0)
def T(p): q = np.array(p, float); return np.stack([(q[:, 0] - AX) * S + 128, (q[:, 1] - hy1) * S + 236], 1)

def catmull_path(p):
    p = np.asarray(p); n = len(p); d = f"M{p[0][0]:.1f} {p[0][1]:.1f}"
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6; c2 = p2 - (p3 - p1) / 6
        d += f"C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d + "Z"

def reduce_pts(p, n):
    idx = np.linspace(0, len(p), n, endpoint=False).astype(int); return p[idx]

HEAD = T(reduce_pts(head_s, 24)); VISOR = T(reduce_pts(visor_s, 24))
HL = T(reduce_pts(horn_l, 20)); HR = T(reduce_pts(horn_r, 20))
eye = dict(cx=float((ex) * S), cy=float((ey - hy1) * S + 236), rx=float(ea[0] * S), ry=float(ea[1] * S))

out = dict(head=catmull_path(HEAD), visor=catmull_path(VISOR), horn_l=catmull_path(HL), horn_r=catmull_path(HR), eye=eye)
json.dump(out, open("logo-paths.json", "w"), indent=1)

# ---- score: rasterise the vector back onto the crop and compare region masks (IoU)
def bez_points(p, per=12):
    p = np.asarray(p); n = len(p); pts = []
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6; c2 = p2 - (p3 - p1) / 6
        for t in np.linspace(0, 1, per, endpoint=False):
            pts.append(((1-t)**3)*p1 + 3*((1-t)**2)*t*c1 + 3*(1-t)*t*t*c2 + t**3*p2)
    return np.array(pts)
H, W = g.shape; SS = 4
def mask(poly_list, ellipses=()):
    im = Image.new("L", (W * SS, H * SS), 0); dr = ImageDraw.Draw(im)
    for poly in poly_list: dr.polygon([tuple(q * SS) for q in poly], fill=255)
    for (cx, cy, rx, ry) in ellipses: dr.ellipse([(cx - rx) * SS, (cy - ry) * SS, (cx + rx) * SS, (cy + ry) * SS], fill=255)
    return np.asarray(im.resize((W, H), Image.BILINEAR)) > 127
inv = lambda p: p  # shapes are scored in crop space, before normalising
head_v = mask([bez_points(reduce_pts(head_s, 24))]); visor_v = mask([bez_points(reduce_pts(visor_s, 24))])
horn_v = mask([bez_points(reduce_pts(horn_l, 20)), bez_points(reduce_pts(horn_r, 20)[::-1])])
eye_v = mask([], [(AX - ex, ey, ea[0], ea[1]), (AX + ex, ey, ea[0], ea[1])])

dark = g < LEVEL
from scipy import ndimage as ndi
lab, nlab = ndi.label(dark)
sizes = ndi.sum(dark, lab, range(1, nlab + 1))
order = np.argsort(sizes)[::-1] + 1
head_ring_ref = lab == order[0]
head_ref = ndi.binary_fill_holes(head_ring_ref)
visor_ref = head_ref & ~head_ring_ref
visor_ref = ndi.binary_fill_holes(visor_ref)
eye_ref = visor_ref & dark
horn_ref = dark & ~head_ref
def iou(x, y): return (x & y).sum() / (x | y).sum()
score = dict(head=iou(head_v, head_ref), visor=iou(visor_v, visor_ref), eyes=iou(eye_v, eye_ref), horns=iou(horn_v, horn_ref))
print({k: round(float(v), 4) for k, v in score.items()})
json.dump({k: float(v) for k, v in score.items()}, open("logo-score.json", "w"))
print("AX", AX, "scale", S, "eye", eye)
