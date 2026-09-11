"""Trace Darius's master sprite to the 32px grid. Data, not art direction.

Green is keyed out by corner flood fill with tolerance (the upload has ~20k
colors of upscale noise, not clean cells). Full frame maps 1024 -> 32 so
cells stay square; proportions are whatever he drew.
"""
from PIL import Image
import collections

img = Image.open('darius-sprite.png').convert('RGB')
W, H = img.size
px = img.load()


def is_green(c):
    r, g, b = c
    return g > 110 and g > r * 1.7 and g > b * 1.7


# flood fill from all four corners: background only, never the sprite.
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

print('bg cells: %d of %d' % (len(seen), W * H))

mask = Image.new('1', (W, H), 0)
mp = mask.load()
for x, y in seen:
    mp[x, y] = 1

small = img.resize((32, 32), Image.NEAREST)
msmall = mask.resize((32, 32), Image.NEAREST)
sp, mp2 = small.load(), msmall.load()
rows = []
for y in range(32):
    line = ''
    for x in range(32):
        line += '.' if mp2[x, y] else '#'
    rows.append(line)

fg = collections.Counter()
for y in range(32):
    for x in range(32):
        if rows[y][x] == '#':
            fg[sp[x, y]] += 1
print('fg colors:', len(fg))
for c, n in fg.most_common(14):
    print('%7d #%02x%02x%02x' % ((n,) + c))

big = small.resize((384, 384), Image.NEAREST)
big.save('_trace-keyed.png')

io = open('_trace-grid.txt', 'w', encoding='utf-8')
io.write('\n'.join(rows))
io.close()
print('trace ok')
