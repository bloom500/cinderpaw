"""Score the Blender turnaround against the board's turnaround.

For each view: silhouette overlap (IoU) after scaling both to the same height, and for the
front view the silhouette width at every 5% of the height, so a difference can be read as
"the hands hang lower on the board" instead of "it looks off". Writes renders/overlap.png:
grey = both, blue = only the board, orange = only the render.

  python compare_board.py
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\5f5d22c7-9595-47c2-88f4-11e37566cf17.png"
BOXES = {"front": (975, 95, 1120, 268), "threequarter": (1140, 95, 1285, 268),
         "side": (1310, 95, 1440, 268), "back": (1455, 95, 1620, 268)}


def mask(a):
    a = a.astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # r - g keeps warm paper and the lit floor out; r > 90 keeps clay in shadow (under the chin) in
    m = ndi.binary_fill_holes(((r - b > 50) & (r - g > 40) & (r > 90)) | ((r < 80) & (g < 80) & (b < 80)))
    lab, n = ndi.label(m)
    return lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)


def normalise(m, size=400):
    ys, xs = np.nonzero(m)
    y0, y1 = ys.min(), ys.max()
    cx, h = (xs.min() + xs.max()) / 2, y1 - y0 + 1
    s = size * 0.9 / h
    arr = np.asarray(Image.fromarray((m[y0:y1 + 1] * 255).astype(np.uint8))
                     .resize((max(1, int(m.shape[1] * s)), int(h * s)), Image.BILINEAR)) > 127
    out = np.zeros((size, size), bool)
    ox, oy = int(size / 2 - cx * s), size - arr.shape[0] - int(size * 0.05)
    x0, x1 = max(0, ox), min(size, ox + arr.shape[1])
    out[oy:oy + arr.shape[0], x0:x1] = arr[:, x0 - ox:x1 - ox]
    return out


def widths(m):
    ys, _ = np.nonzero(m)
    y0, y1 = ys.min(), ys.max()
    h = y1 - y0
    res = []
    for f in np.arange(0.05, 1.0, 0.05):
        x = np.nonzero(m[int(y0 + f * h)])[0]
        res.append((x.max() - x.min() + 1) / h if len(x) else 0.0)
    return res


board = Image.open(BOARD).convert("RGB")
tiles = []
for view, box in BOXES.items():
    w, h = box[2] - box[0], box[3] - box[1]
    ref = mask(np.asarray(board.crop(box).resize((w * 4, h * 4), Image.BICUBIC)))
    mine = mask(np.asarray(Image.open(os.path.join(HERE, "renders", f"{view}.png")).convert("RGB")))
    rn, mn = normalise(ref), normalise(mine)
    print(f"{view:13s} overlap {(rn & mn).sum() / (rn | mn).sum():.3f}")
    vis = np.zeros((400, 400, 3), np.uint8)
    vis[rn & mn], vis[rn & ~mn], vis[mn & ~rn] = (120, 120, 120), (40, 90, 230), (240, 120, 40)
    tiles.append(Image.fromarray(vis))
    if view == "front":
        front = (widths(ref), widths(mine))

sheet = Image.new("RGB", (1600, 400))
for i, t in enumerate(tiles):
    sheet.paste(t, (i * 400, 0))
sheet.save(os.path.join(HERE, "renders", "overlap.png"))

print("\nfront, width at each height (share of total height): board / render / difference")
for f, a, b in zip(np.arange(0.05, 1.0, 0.05), *front):
    flag = "  <--" if abs(b - a) > 0.05 else ""
    print(f"  {f * 100:3.0f}% from top   {a:.3f}  {b:.3f}  {b - a:+.3f}{flag}")
