"""Step 2: measure his real colors, then quantize the trace to palette chars."""
from PIL import Image
import statistics

img = Image.open('darius-sprite.png').convert('RGB')
W, H = img.size
px = img.load()


def is_green(c):
    r, g, b = c
    return g > 110 and g > r * 1.7 and g > b * 1.7


seen = set()
stack = [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]
while stack:
    x, y = stack.pop()
    if (x, y) in seen or not (0 <= x < W and 0 <= y < H):
        continue
    if not is_green(px[x, y]):
        continue
    seen.add((x, y))
    stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

mask = Image.new('1', (W, H), 0)
mp = mask.load()
for x, y in seen:
    mp[x, y] = 1


def med(struct):
    xs = sorted(struct)
    return xs[len(xs) // 2]


# sample zones at full res (fractions of the 1024 frame, eyeballed off his art)
zones = {
    'horn': [(0.20, 0.30, 0.10, 0.16), (0.70, 0.80, 0.10, 0.16)],
    'rim': [(0.17, 0.24, 0.16, 0.30)],
    'face': [(0.35, 0.65, 0.25, 0.45)],
    'fill': [(0.40, 0.60, 0.55, 0.70)],
    'eye': [(0.36, 0.44, 0.32, 0.40)],
}
for name, boxes in zones.items():
    rs, gs, bs = [], [], []
    for x0, x1, y0, y1 in boxes:
        for y in range(int(y0 * H), int(y1 * H), 3):
            for x in range(int(x0 * W), int(x1 * W), 3):
                if (x, y) in seen:
                    continue
                r, g, b = px[x, y]
                rs.append(r)
                gs.append(g)
                bs.append(b)
    print('%5s #%02x%02x%02x  (n=%d)' % (name, med(rs), med(gs), med(bs), len(rs)))
