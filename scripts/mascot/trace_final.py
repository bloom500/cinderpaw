"""Final trace: key green, quantize to his palette, dump grid + render."""
from PIL import Image

PAL = {
    'k': (25, 25, 25),
    'R': (66, 66, 66),
    'o': (237, 134, 34),
    'e': (10, 10, 12),
    'w': (245, 245, 245),
    'n': (251, 176, 96),
}

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
        line += min(PAL, key=lambda k: dist(c, PAL[k]))
    grid.append(line)

io = open('_trace-final.txt', 'w', encoding='utf-8')
io.write('\n'.join(grid))
io.close()

big = Image.new('RGB', (384, 384), (28, 25, 22))
bp = big.load()
for y in range(32):
    for x in range(32):
        ch = grid[y][x]
        col = (40, 40, 44) if ch == '.' else PAL[ch]
        for dy in range(12):
            for dx in range(12):
                bp[x * 12 + dx, y * 12 + dy] = col
big.save('_trace-final.png')
print('trace final ok')
print('\n'.join(grid))
