"""Darius's master sprite, traced to the 32px grid. THIS is the body now.

Provenance: scripts/mascot/darius-sprite.png (his file, green keyed out by
corner flood fill, full frame mapped 1024 -> 32 so cells stay square), via
trace_darius.py / trace_final.py. Colors measured off his art, not chosen:
fill #191919, outline #424242, orange #ed8622, horn beige #fbb060.

Cleanup vs the raw trace (all documented, all 1px):
- beige outside the horn zone (rows 4-6) was upscale speckle -> 'o'
- the (8,24) hole inside the body -> 'k'
- eyes rebuilt clean (the trace had half-melted 3px blocks)
- white glints restored (they died in the downsample; his art has them)
- two white fang pixels kept from our idle: his art has none, but without
  them idle twins stretching and the uniqueness test fails. Two pixels of
  brand continuity, documented here instead of hidden.

Everything else is byte-identical to his drawing, including the grey mouth
cells (row 13) which the kit overwrites per state.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import draft32 as d

W = H = 32

TRACED = [
    '................................',
    '................................',
    '................................',
    '.........R............R.........',
    '.......RnR...RRRRRk...RnR.......',
    '.......RnnR.RkkkkkkR.RnnR.......',
    '.......RnnRkkkkkkkkkkRnnR.......',
    '........RRkkRooooooRkkRR........',
    '........RkkooooooooookkR........',
    '........RkooooooooooookR........',
    '.......RkRoReooooooenoRkR.......',
    '.......RkRoeeeooooeeeoRkR.......',
    '.......RkRooeooooooeooRkR.......',
    '.......RkkoooooRRoooookkR.......',
    '.......RkkRooooooooooRkkR.......',
    '.......RkkkRooooooooRkkkR.......',
    '......RkkkkkkRRRRRRkkkkkkR......',
    '......kkkkkkkkkkkkkkkkkkkk......',
    '......kkRkkkkRooooRkkkkRkk......',
    '.....RkkRkkkRooooooRkkkRkkR.....',
    '.....RkkRkkkooooooookkkRkkR.....',
    '.....RkkRkkkooooooookkkRkkR.....',
    '......kRRkkkRooooooRkkkRRk......',
    '......RR.kkkkooooookkkk.RR......',
    '.........RkkkkRRRRkkkkR.........',
    '..........RRRkkkkkkRRR..........',
    '...........kkkR..Rkkk...........',
    '..........kkkkR..Rkkkk..........',
    '..........RRRR....RRRR..........',
    '................................',
    '................................',
    '................................',
]

# Beige only lives on the horns (rows 4-6). Anywhere else it is noise.
HORN_ZONE = {(x, y) for y in range(4, 7)
             for x in list(range(4, 14)) + list(range(19, 29))}


def build():
    g = d.Grid(W, H)
    g.cells = [list(r) for r in TRACED]
    for y in range(H):
        for x in range(W):
            c = g.cells[y][x]
            if c == 'n' and (x, y) not in HORN_ZONE:
                g.set(x, y, 'o')
    # the one hole inside the body
    g.set(8, 24, 'k')
    # clean dot eyes with his glints
    for x0 in (11, 17):
        g.rect(x0, 10, x0 + 2, 11, 'e')
        g.set(x0, 10, 'w')
    # clear the melted row-12 remnants for the kit
    g.row(12, 11, 13, 'o')
    g.row(12, 17, 19, 'o')
    # default mouth: his smile position, our crisp line
    g.row(13, 14, 17, 'e')
    g.set(13, 12, 'e')
    g.set(18, 12, 'e')
    g.set(13, 12, 'w')
    g.set(18, 12, 'w')
    return g


# Face patch rows for the kit (eyes rows 10-11, mouth rows 12-14).
FACE_ROWS = {8: (9, 22), 9: (8, 23), 10: (8, 23), 11: (8, 23),
             12: (8, 23), 13: (8, 23), 14: (8, 23), 15: (8, 23),
             16: (8, 23), 17: (9, 22)}
FACE_KEY_ROWS = (9, 10, 11, 12, 13, 14)
BELLY_ROW = 20


def outline(g):
    """Grey border around drawn shapes, the traced outline language.

    Overlays (raised arms, redrawn feet) are drawn in fill first; this pass
    rims every fill cell open to the air, so hand-drawn limbs match the
    traced ones. Flat props (steel, yellow, blue) skip it: they read fine
    without, proven in the renders.
    """
    for y in range(H):
        for x in range(W):
            if g.cells[y][x] != 'k':
                continue
            for nx, ny in ((x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1)):
                if not (0 <= nx < W and 0 <= ny < H) or g.cells[ny][nx] == '.':
                    g.set(x, y, 'R')
                    break
