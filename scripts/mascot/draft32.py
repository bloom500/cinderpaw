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

    # ---- horns ------------------------------------------------------------
    # Tapered, not stubs. A three-by-three orange block on a stalk reads as a
    # bolt; narrowing it toward the tip is what makes it a horn, and it is two
    # cells of difference.
    for left in (True, False):
        base = 4 if left else 24
        g.rect(base, 3, base + 3, 6, 'k')
        g.rect(base + (0 if left else 1), 1, base + (2 if left else 3), 3, 'o')
        g.rect(base + (0 if left else 2), 0, base + (1 if left else 3), 1, 'o')

    # ---- head -------------------------------------------------------------
    # Corners cut deeper than a rounded rectangle. At 28 cells across a shallow
    # bevel still reads as a television, and the creature is round.
    g.rect(2, 4, 29, 18, 'k')
    for dy, cut in ((0, 4), (1, 3), (2, 2), (3, 1)):
        g.row(4 + dy, 2, 2 + cut - 1, '.')
        g.row(4 + dy, 30 - cut, 29, '.')
    for dy, cut in ((0, 2), (1, 1)):
        g.row(18 - dy, 2, 2 + cut - 1, '.')
        g.row(18 - dy, 30 - cut, 29, '.')

    # the orange face patch, inset by two so the fur reads as a border
    g.rect(5, 7, 26, 17, 'o')
    for dy, cut in ((0, 3), (1, 2), (2, 1)):
        g.row(7 + dy, 5, 5 + cut - 1, 'k')
        g.row(7 + dy, 27 - cut, 26, 'k')
    for dy, cut in ((0, 2), (1, 1)):
        g.row(17 - dy, 5, 5 + cut - 1, 'k')
        g.row(17 - dy, 27 - cut, 26, 'k')

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
    # A foot that is one flat tone on a dark background is invisible; the top
    # row stays in the light fur so the leg has an edge where it leaves the body.
    g.rect(8, 30, 13, 31, 'd')
    g.rect(18, 30, 23, 31, 'd')
    g.row(30, 9, 12, 'k')
    g.row(30, 19, 22, 'k')

    # ---- face -------------------------------------------------------------
    # The eyes get their outer corners cut. A five-by-five black square is a
    # window; the same shape with two corners off is an eye, and it costs four
    # cells.
    for left in (True, False):
        x0 = 9 if left else 18
        g.rect(x0, 9, x0 + 4, 13, 'e')
        outer = x0 if left else x0 + 4
        g.set(outer, 9, 'o')
        g.set(outer, 13, 'o')
        g.rect(x0 + (1 if left else 2), 9, x0 + (2 if left else 3), 10, 'w')
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
    # The neck. It used to run the full width as a straight rule, which reads
    # as a seam between two parts rather than as a head sitting on a body.
    for y in (17, 18):
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


# The concept's own palette, measured off the generated art: grey-black fur in
# two tones, and an orange far brighter than ours. Kept slightly warm so the
# creature is still a Cinderpaw and not a rock.
GEM_FUR = '#4a4b53'
GEM_FUR_DARK = '#31323a'
GEM_ORANGE = '#f2822c'


def build_c():
    """The creature as the concept draws it: ONE furry mass, two orange patches.

    The measured difference from draft A is not detail, it is structure. A has a
    head, a neck and a torso, each a separate rounded box. The concept has none
    of that: it is a single shaggy silhouette with an orange face patch high up
    and an orange belly low down, and the horns and feet interrupt the outline.
    That is why it reads as a creature and A reads as a machine.

    The outline is deliberately NOT clean. Every edge cell is nudged in or out
    by one, because a smooth bevel is what makes fur look moulded.
    """
    g = Grid(W, H)

    # ---- one mass ---------------------------------------------------------
    # Widths per row, centred. Narrow at the head, widest across the belly.
    silhouette = {
        4: 14, 5: 16, 6: 18, 7: 20, 8: 20, 9: 21, 10: 21, 11: 21, 12: 21,
        13: 21, 14: 20, 15: 20, 16: 21, 17: 22, 18: 24, 19: 26, 20: 26,
        21: 27, 22: 27, 23: 27, 24: 26, 25: 26, 26: 24, 27: 22, 28: 19,
    }
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        g.row(y, x0, x0 + w - 1, 'k')

    # shaggy: pull single cells out of the outline, alternating, so the edge
    # breaks up instead of curving
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        x1 = x0 + w - 1
        if y % 2 == 0:
            g.set(x0, y, '.')
            g.set(x1, y, '.')
        else:
            g.set(x0 - 1, y, 'k')
            g.set(x1 + 1, y, 'k')

    # ---- horns: curved, leaning out ---------------------------------------
    HORN = [(10, 4), (9, 4), (9, 3), (8, 3), (8, 2), (7, 2), (7, 1), (8, 1)]
    for x, y in HORN:
        for dx in (0, 1):
            g.set(x + dx, y, 'o')
            g.set(31 - x - dx, y, 'o')

    # ---- the orange face patch, high on the mass --------------------------
    face = [(7, 12, 19), (8, 10, 21), (9, 9, 22), (10, 9, 22), (11, 9, 22),
            (12, 9, 22), (13, 10, 21), (14, 12, 19)]
    for y, x0, x1 in face:
        g.row(y, x0, x1, 'o')

    # ---- the belly, a circle low on the mass -------------------------------
    belly = [(18, 13, 18), (19, 11, 20), (20, 10, 21), (21, 10, 21),
             (22, 10, 21), (23, 10, 21), (24, 11, 20), (25, 13, 18)]
    for y, x0, x1 in belly:
        g.row(y, x0, x1, 'o')

    # ---- feet: they interrupt the outline, they are not bolted under it ----
    for x0 in (8, 18):
        g.rect(x0, 29, x0 + 5, 31, 'k')
        g.set(x0 + 2, 31, '.')

    # ---- face -------------------------------------------------------------
    # Small eyes, set wide, with one white glint. The concept's eyes are tiny
    # against a big orange patch, and that is most of what makes it read as
    # gentle rather than as a mask.
    for x0 in (12, 18):
        g.rect(x0, 10, x0 + 1, 11, 'e')
        g.set(x0, 10, 'w')
    g.row(13, 13, 18, 'e')
    g.set(12, 12, 'e')
    g.set(19, 12, 'e')

    # ---- volume -----------------------------------------------------------
    for y in range(4, 32):
        for x in range(32):
            if g.cells[y][x] != 'k':
                continue
            row = g.cells[y]
            left = next((i for i, c in enumerate(row) if c != '.'), None)
            right = next((i for i in range(31, -1, -1) if row[i] != '.'), None)
            if left is None:
                continue
            if x <= left + 1 or x >= right - 1 or y >= 27:
                g.set(x, y, 'd')
    return g
