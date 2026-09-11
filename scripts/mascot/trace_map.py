"""Step 2: quantize the traced sprite to palette chars, dump ASCII for review."""
from PIL import Image

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

small = img.resize((32, 32), Image.NEAREST)
msmall = mask.resize((32, 32), Image.NEAREST)
sp, mp2 = small.load(), msmall.load()

TARGETS = {
    'k': (20, 20, 22),      # near-black fill
    'd': (64, 64, 70),      # grey outline / shadow
    'R': (85, 85, 95),      # light rim (measured below)
    'o': (237, 133, 34),    # his orange
    'e': (10, 10, 12),      # ink
    'w': (245, 245, 245),   # white
    'n': (244, 190, 130),   # beige horns (guess, corrected below)
}


def dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b))


grid = []
for y in range(32):
    line = ''
    for x in range(32):
        if mp2[x, y]:
            line += '.'
            continue
        c = sp[x, y]
        best = min(TARGETS, key=lambda k: dist(c, TARGETS[k]))
        line += best
    grid.append(line)

io = open('_trace-mapped.txt', 'w', encoding='utf-8')
io.write('\n'.join(grid))
io.close()

# what did the beige guess catch? sample horn zone rows 1-6.
horn = set()
for y in range(0, 7):
    for x in list(range(4, 13)) + list(range(19, 28)):
        if grid[y][x] == 'n':
            horn.add(sp[x * 32, y * 32] if False else None)
print('trace mapped ok')
print('\n'.join(grid))
