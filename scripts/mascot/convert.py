"""A concept illustration, converted into a 32x32 sprite and cleaned up.

The concept art for the creature is a 1024px JPEG with tens of thousands of
colours and no pixel grid. It is not a sprite and cannot be dropped in. What it
IS good for is the same thing a concept sketch is good for anywhere: it settles
the silhouette, the proportions and the palette, and those are the parts that
were being guessed at.

So this does what a pixel artist does with a render: downscale it, force it onto
a small palette, and then CLEAN it -- because a raw downscale turns shaggy fur
into speckle, and speckle is the difference between a sprite and a screenshot.

    python convert.py <image>       # writes convert-out.png and convert-out.txt

The cleanup is three passes, in this order:

1. snap every pixel to the sprite palette. Nearest in plain RGB; the palette
   colours are nowhere near each other, so anything cleverer is false precision.
2. de-speckle. A cell whose colour appears nowhere among its eight neighbours is
   noise from the downscale, and takes the majority colour instead. Run twice:
   one pass leaves pairs of speckles propping each other up.
3. close single-cell holes in the silhouette, so the outline is a line rather
   than a dotted one.

What it does NOT do is decide anything. Eyes, mouth and horn tips are drawn by
hand afterwards on top of this, because at 32 cells those are two or three
pixels each and no filter can be trusted with them.
"""
import io
import re
import sys
from collections import Counter

from PIL import Image

OUT = '../../frontend-react/src/components/chat/mascot/'
SIZE = 32  # overridden by the command line


def load_palette():
    """The sprite palette, plus the shadow fur that only exists at 32x32."""
    src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
    pal = dict(re.findall(r"(\w): '(#[0-9a-fA-F]+)'", src.split('PALETTE')[1].split('}')[0]))
    pal = {k: v for k, v in pal.items() if v}
    pal['d'] = '#3f372f'
    return pal


def rgb(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def crop_square(im):
    """Trim the black background and pad back to a square, so nothing distorts."""
    bw = im.point(lambda v: 255 if v > 26 else 0).convert('L')
    box = bw.getbbox()
    crop = im.crop(box) if box else im
    side = max(crop.size)
    sq = Image.new('RGB', (side, side), (0, 0, 0))
    sq.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    return sq


def snap(im, pal):
    """Every pixel to its nearest palette entry; near-black becomes empty."""
    px = im.load()
    grid = []
    for y in range(SIZE):
        row = ''
        for x in range(SIZE):
            r, g, b = px[x, y]
            if r + g + b < 70:
                row += '.'
                continue
            best, bd = None, None
            for ch, col in pal.items():
                t = rgb(col)
                dist = (r - t[0]) ** 2 + (g - t[1]) ** 2 + (b - t[2]) ** 2
                if bd is None or dist < bd:
                    best, bd = ch, dist
            row += best
        grid.append(row)
    return grid


def neighbours(grid, x, y):
    out = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx, ny = x + dx, y + dy
            if 0 <= nx < SIZE and 0 <= ny < SIZE:
                out.append(grid[ny][nx])
    return out


def despeckle(grid):
    """A cell no neighbour agrees with is downscaling noise, not a decision."""
    out = [list(r) for r in grid]
    for y in range(SIZE):
        for x in range(SIZE):
            ch = grid[y][x]
            n = neighbours(grid, x, y)
            if ch not in n:
                out[y][x] = Counter(n).most_common(1)[0][0]
    return [''.join(r) for r in out]


def close_holes(grid):
    """A single empty cell ringed by body is a hole punched by the downscale."""
    out = [list(r) for r in grid]
    for y in range(SIZE):
        for x in range(SIZE):
            if grid[y][x] != '.':
                continue
            n = neighbours(grid, x, y)
            solid = [c for c in n if c != '.']
            if len(solid) >= 7:
                out[y][x] = Counter(solid).most_common(1)[0][0]
    return [''.join(r) for r in out]


def render(grid, path, scale=10, bg='#1C1916'):
    from PIL import ImageDraw
    pal = load_palette()
    img = Image.new('RGB', (SIZE * scale, SIZE * scale), rgb(bg))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch == '.':
                continue
            d.rectangle([x * scale, y * scale, x * scale + scale - 1,
                         y * scale + scale - 1], rgb(pal[ch]))
    img.save(path)


def main(path, size=32):
    global SIZE
    SIZE = size
    pal = load_palette()
    im = crop_square(Image.open(path).convert('RGB')).resize((SIZE, SIZE), Image.LANCZOS)
    grid = snap(im, pal)
    for _ in range(2):
        grid = despeckle(grid)
    grid = close_holes(grid)
    render(grid, 'convert-out-%d.png' % SIZE)
    io.open('convert-out-%d.txt' % SIZE, 'w', encoding='utf-8', newline='\n').write('\n'.join(grid) + '\n')
    used = Counter(ch for r in grid for ch in r if ch != '.')
    print('convert-out-%d.png / .txt' % SIZE)
    print('cells filled : %d of %d' % (sum(used.values()), SIZE * SIZE))
    print('palette used : %s' % ', '.join('%s=%d' % kv for kv in used.most_common()))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 32)
