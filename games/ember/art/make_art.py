"""Cinderpaw's in-game drawings, cut from the character art Darius drew.

Crops each pose to its silhouette (plus a margin) and scales it to 192 px
high: art/cheer.png (arms out, the normal pose) and art/surprised.png (the
flinch in the rain).

usage: python games/ember/art/make_art.py
"""
import os
import numpy as np
from PIL import Image
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', '..', 'docs', 'design', 'moodboard', 'SVG')
POSES = {'cheer': 'e218d07c-9b9a-4a53-95ea-e28f32e5d7fb', 'surprised': '3fbfcb9f-c4c6-44eb-9b35-faaeaa59736f'}
HEIGHT = 192

for name, file in POSES.items():
    im = Image.open(os.path.join(SRC, file + '.png')).convert('RGBA')
    alpha = np.asarray(im)[..., 3] >= 128
    body = max(measure.regionprops(measure.label(alpha)), key=lambda p: p.area)  # the art has stray specks
    y0, x0, y1, x1 = body.bbox
    pad = 8 * (y1 - y0) // HEIGHT
    crop = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    crop.resize((round(crop.width * HEIGHT / crop.height), HEIGHT), Image.LANCZOS).save(os.path.join(HERE, name + '.png'))
    print(name, crop.size)
