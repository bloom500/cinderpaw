"""Draw the board's outlines over the renders, placed exactly like the references in Blender.

Blue = the board's silhouette, cyan = its cream areas (visor, belly), navy = its eyes.
Writes renders/overlay.png (front, side, back). Run after build_character.py:
  python overlay.py
"""
import json
import os
import re

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\5f5d22c7-9595-47c2-88f4-11e37566cf17.png"
BOXES = {"front": (975, 95, 1120, 268), "side": (1310, 95, 1440, 268), "back": (1455, 95, 1620, 268)}
PX_PER_UNIT, UP = 50, 4
ORTHO, CAM_Z = 3.8, 1.65                      # must match build_character.py
LEG_LIFT = float(re.search(r"^LEG_LIFT = ([\d.]+)", open(os.path.join(HERE, "build_character.py")).read(), re.M).group(1))

board = Image.open(BOARD).convert("RGB")
panels = []
for view, (x0, y0, x1, y1) in BOXES.items():
    a = np.asarray(board.crop((x0, y0, x1, y1)).resize(((x1 - x0) * UP, (y1 - y0) * UP), Image.BICUBIC)).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    orange = (r - b > 50) & (r - g > 40) & (r > 90)
    dark = (r < 80) & (g < 80) & (b < 80)
    lab, n = ndi.label(ndi.binary_fill_holes(orange | dark))
    body = lab == (np.argmax(ndi.sum(lab > 0, lab, range(1, n + 1))) + 1)
    cream = body & ~orange & ~dark
    cream = ndi.binary_opening(cream, iterations=2)
    eyes = body & dark
    ys, xs = np.nonzero(body)
    mid_x, floor = (xs.min() + xs.max()) / 2, ys.max()

    im = Image.open(os.path.join(HERE, "renders", f"{view}.png")).convert("RGB")
    W, H = im.size
    px = W / ORTHO                                 # render pixels per model unit
    out = np.asarray(im).copy()
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    for mask, colour in ((body, (30, 90, 255)), (cream, (0, 200, 220)), (eyes, (20, 20, 120))):
        edge = mask & ~ndi.binary_erosion(mask, iterations=2)
        h = (xx[edge] - mid_x) / (PX_PER_UNIT * UP)                 # units right of the middle
        z = (floor - yy[edge]) / (PX_PER_UNIT * UP) + LEG_LIFT        # units above the floor
        cols = np.round(W / 2 + h * px).astype(int)
        rows = np.round(H / 2 - (z - CAM_Z) * px).astype(int)
        ok = (cols >= 0) & (cols < W) & (rows >= 0) & (rows < H)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                out[np.clip(rows[ok] + dy, 0, H - 1), np.clip(cols[ok] + dx, 0, W - 1)] = colour
    panels.append(Image.fromarray(out).resize((600, 600), Image.LANCZOS))

sheet = Image.new("RGB", (1800, 600), (255, 255, 255))
for i, p in enumerate(panels):
    sheet.paste(p, (i * 600, 0))
sheet.save(os.path.join(HERE, "renders", "overlay.png"))
print("renders/overlay.png")
