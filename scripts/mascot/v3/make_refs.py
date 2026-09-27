"""Cut the board's straight views into square reference pictures for Blender.

Each picture is centred on the figure and comes with where its floor and its middle are, in
model units, so build_character.py can stand it exactly behind the model (1 unit = 50 board px).
The 3/4 view is left out: Blender only pins references to straight views.

  python make_refs.py
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = r"C:\Users\Darius\Desktop\Cinderpaw Moodboard\5f5d22c7-9595-47c2-88f4-11e37566cf17.png"
BOXES = {"front": (975, 95, 1120, 268), "side": (1310, 95, 1440, 268), "back": (1455, 95, 1620, 268)}
PX_PER_UNIT = 50
SIDE_PX = 200          # square crop, a little larger than the ~160 px figure
UP = 4                 # store the crop 4x so it stays crisp when zoomed in Blender

board = Image.open(BOARD).convert("RGB")
out = {}
os.makedirs(os.path.join(HERE, "refs"), exist_ok=True)
for view, (x0, y0, x1, y1) in BOXES.items():
    a = np.asarray(board.crop((x0, y0, x1, y1))).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = ndi.binary_fill_holes(((r - b > 50) & (r - g > 40) & (r > 90)) | ((r < 80) & (g < 80) & (b < 80)))
    lab, n = ndi.label(m)
    m = lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)
    ys, xs = np.nonzero(m)
    mid_x = x0 + (xs.min() + xs.max()) / 2       # the figure's middle, on the board
    floor = y0 + ys.max()                        # the soles of its feet
    cx, cy = mid_x, floor - SIDE_PX * 0.45       # square centre: figure centred, floor near the bottom
    box = (round(cx - SIDE_PX / 2), round(cy - SIDE_PX / 2), round(cx + SIDE_PX / 2), round(cy + SIDE_PX / 2))
    path = os.path.join(HERE, "refs", f"{view}.png")
    board.crop(box).resize((SIDE_PX * UP, SIDE_PX * UP), Image.LANCZOS).save(path)
    out[view] = {
        "file": f"refs/{view}.png",
        "size": SIDE_PX / PX_PER_UNIT,                          # square side in model units
        "centre_z": (floor - (box[1] + box[3]) / 2) / PX_PER_UNIT,   # image centre above the floor
        "centre_h": ((box[0] + box[2]) / 2 - mid_x) / PX_PER_UNIT,   # image centre off the middle
    }
    print(view, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in out[view].items()})
json.dump(out, open(os.path.join(HERE, "refs", "refs.json"), "w"), indent=1)
