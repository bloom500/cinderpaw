"""The 32x32 creature, built from shapes and rendered so it can be looked at.

Same character as the 16x16: a dark furry monster with orange horn tips, an
orange face patch and a round orange belly. What the extra room buys is the one
thing 16 could not hold -- ARMS. At 16 the body filled 196 of 256 cells with
ZERO free columns at the rows an arm leaves the torso, which is why every paw
ended up as a 2x2 block stuck on the flank.

Built from primitives rather than hand-counted strings: a 32-wide row miscounted
by one is invisible in the source and obvious on screen, and it happened on the
first draft.

Chars: . empty   k fur   o orange   e ink   w white   r red

    python draft32.py
"""
import io
import re

from PIL import Image, ImageDraw

OUT = '../../frontend-react/src/components/chat/mascot/'
W = H = 32


class Grid:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.cells = [['.'] * w for _ in range(h)]

    def set(self, x, y, ch):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.cells[y][x] = ch

    def rect(self, x0, y0, x1, y1, ch):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, ch)

    def row(self, y, x0, x1, ch):
        self.rect(x0, y, x1, y, ch)

    def rows(self):
        return [''.join(r) for r in self.cells]


def build():
    g = Grid(W, H)

    # The creature FILLS the frame. The first draft sat at 75% of it and read
    # smaller and weaker than the 16x16 it was replacing, side by side: that
    # sprite works because it is chunky and touches its own edges. The extra
    # room at 32 is for ARMS, not for air.

    # ---- horns: fur, tipped in orange -------------------------------------
    for x0 in (5, 24):
        g.rect(x0, 0, x0 + 2, 2, 'o')
        g.rect(x0, 3, x0 + 2, 5, 'k')

    # ---- head -------------------------------------------------------------
    g.rect(2, 4, 29, 18, 'k')
    for dy, cut in ((0, 3), (1, 2), (2, 1)):
        g.row(4 + dy, 2, 2 + cut - 1, '.')
        g.row(4 + dy, 30 - cut, 29, '.')

    # the orange face patch, inset by two so the fur reads as a border
    g.rect(5, 7, 26, 17, 'o')
    for dy, cut in ((0, 2), (1, 1)):
        g.row(7 + dy, 5, 5 + cut - 1, 'k')
        g.row(7 + dy, 27 - cut, 26, 'k')

    # ---- body -------------------------------------------------------------
    # It bulges at the shoulders and tapers to the feet, the way the 16x16
    # does. A torso of one constant width is a box, and a box with an inset
    # belly reads as a picture frame -- which is what two drafts of this
    # looked like.
    torso = [(19, 4, 27), (20, 4, 27), (21, 4, 27), (22, 5, 26), (23, 5, 26),
             (24, 5, 26), (25, 6, 25), (26, 6, 25), (27, 7, 24), (28, 8, 23),
             (29, 9, 22)]
    for y, x0, x1 in torso:
        g.row(y, x0, x1, 'k')

    # the belly, a true oval inside it rather than a slab across it
    belly = [(21, 10, 21), (22, 8, 23), (23, 7, 24), (24, 7, 24),
             (25, 8, 23), (26, 9, 22), (27, 11, 20)]
    for y, x0, x1 in belly:
        g.row(y, x0, x1, 'o')

    # ---- arms -------------------------------------------------------------
    # The whole reason for 32x32. Attached at the shoulder, hanging down the
    # side, ending in an orange paw. They stay in the LIGHT fur tone: shaded
    # like the torso they vanish, and all that is left is a paw floating in
    # the dark, which is exactly where the 16x16 attempts ended up.
    for x0 in (0, 29):
        g.rect(x0, 19, x0 + 2, 24, 'k')
        g.rect(x0, 25, x0 + 2, 27, 'o')
    # One empty column between arm and torso. Without it the two merge into a
    # single mass and the arm stops being an arm -- fur against fur has no edge
    # to find, and the shading is not enough to make one.
    for x in (3, 28):
        g.rect(x, 19, x, 27, '.')

    # ---- legs -------------------------------------------------------------
    g.rect(8, 30, 13, 31, 'k')
    g.rect(18, 30, 23, 31, 'k')

    # ---- face -------------------------------------------------------------
    for x0 in (9, 19):
        g.rect(x0, 9, x0 + 4, 13, 'e')
        g.rect(x0, 9, x0 + 1, 10, 'w')
    g.row(15, 12, 19, 'r')
    g.row(16, 13, 18, 'r')
    g.set(11, 15, 'w')
    g.set(20, 15, 'w')

    # ---- volume -----------------------------------------------------------
    # At 16x16 the fur was a thin border and flat was fine. Twenty-four cells
    # across, one tone is a cut-out. `d` is the same fur in shadow: under the
    # head, down both flanks and along the bottom, which is where a round body
    # turns away from a light that comes from above.
    # Only the TORSO takes the shadow. Shading the limbs too was the first
    # attempt and it put the arms back where the 16x16 left them: a dark shape
    # on a dark background, so all anybody saw was two orange paws floating.
    # A limb has to stay in the lighter tone to have a silhouette at all.
    TORSO = range(4, 28)
    for y in (18,):
        for x in range(2, 30):
            if g.cells[y][x] == 'k':
                g.set(x, y, 'd')
    for y in range(19, 32):
        for x in TORSO:
            if g.cells[y][x] != 'k':
                continue
            left = next((i for i in range(4, 28) if g.cells[y][i] in 'kdo'), None)
            right = next((i for i in range(27, 3, -1) if g.cells[y][i] in 'kdo'), None)
            if left is None:
                continue
            if x <= left + 1 or x >= right - 1 or y >= 28:
                g.set(x, y, 'd')
    return g


def load_palette():
    src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
    pal = dict(re.findall(r"(\w): '(#[0-9a-fA-F]+)'", src.split('PALETTE')[1].split('}')[0]))
    orange = re.search(r"const MASCOT_ORANGE = '(#[0-9a-fA-F]+)';", src).group(1)
    return pal, orange


def rgb(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    t = max(0, min(1, t))
    return '#' + ''.join('%02x' % round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


def ramp(orange, h):
    """The row shading that lights the body from above, stretched to h rows."""
    out = []
    for row in range(h):
        v = row / (h - 1) * 15
        t = max(0, min(1, (v - 2) / 11))
        c = mix(mix(orange, '#f4c285', max(0, 0.30 - t * 0.34)), '#7a3d1a', max(0, t - 0.45) * 0.55)
        belly = 1 - abs(v - 8) / 5
        out.append(mix(c, '#ec8a33', belly * 0.30) if belly > 0 else c)
    return out


# The fur in shadow. Not in the app palette yet: it earns its place only if the
# creature reads better with it, which is what the render is for.
FUR_SHADOW = '#3f372f'


def render(rows, path, scale=12, bg='#1C1916'):
    pal, orange = load_palette()
    pal = dict(pal, d=FUR_SHADOW)
    shade = ramp(orange, len(rows))
    img = Image.new('RGB', (len(rows[0]) * scale, len(rows) * scale), rgb(bg))
    d = ImageDraw.Draw(img)
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            col = shade[r] if ch == 'o' else pal.get(ch)
            if not col:
                continue
            d.rectangle([c * scale, r * scale, c * scale + scale - 1,
                         r * scale + scale - 1], rgb(col))
    img.save(path)


if __name__ == '__main__':
    rows = build().rows()
    render(rows, 'draft32.png')
    filled = sum(1 for r in rows for ch in r if ch != '.')
    print('draft32.png : %dx%d, %d cells filled of %d' % (W, H, filled, W * H))
