"""The round body: our mascot redrawn in the friendly language.

Not a refinement of the shaggy beast (build_d): a different animal. Smooth
rounded mass, short nub horns, a big face patch, stubby arms at the sides
and feet it stands on. Same Grid API, same chars, so the face kit, the rim
pass, the pipeline and the tests keep working around it.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import draft32 as d

W = H = 32


def build_g():
    g = d.Grid(W, H)

    # ---- one round mass ---------------------------------------------------
    # Wide and smooth. Corners cut deep so nothing reads as a box; no zigzag,
    # no spikes -- calm was tried on the old silhouette and the shape itself
    # was still a beast. This one is drawn round from the first row.
    silhouette = {
        4: 14, 5: 18, 6: 20, 7: 22, 8: 23, 9: 24, 10: 24, 11: 24,
        12: 24, 13: 24, 14: 24, 15: 24, 16: 24, 17: 24, 18: 25, 19: 26,
        20: 26, 21: 26, 22: 26, 23: 26, 24: 26, 25: 25, 26: 24, 27: 22,
        28: 20,
    }
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        g.row(y, x0, x0 + w - 1, 'k')

    # ---- nub horns: short, tilted out, rooted deep -------------------------
    for x, y in ((9, 3), (10, 3), (11, 3),
                 (8, 2), (9, 2), (10, 2),
                 (8, 1), (9, 1)):
        g.set(x, y, 'o')
        g.set(31 - x, y, 'o')

    # ---- big face patch: most of the front ---------------------------------
    face = [(8, 9, 22), (9, 8, 23), (10, 8, 23), (11, 8, 23),
            (12, 8, 23), (13, 8, 23), (14, 8, 23), (15, 8, 23),
            (16, 8, 23), (17, 9, 22)]
    for y, x0, x1 in face:
        g.row(y, x0, x1, 'o')

    # ---- round belly, low ----------------------------------------------------
    belly = [(20, 12, 19), (21, 11, 20), (22, 10, 21), (23, 10, 21),
             (24, 10, 21), (25, 11, 20), (26, 12, 19), (27, 13, 18)]
    for y, x0, x1 in belly:
        g.row(y, x0, x1, 'o')

    # ---- stubby arms at the sides --------------------------------------------
    for x, y in ((3, 16), (4, 16), (3, 17), (4, 17), (3, 18), (4, 18),
                 (3, 19), (4, 19)):
        g.set(x, y, 'k')
        g.set(31 - x, y, 'k')

    # ---- feet it stands on -----------------------------------------------------
    for x0 in (8, 19):
        g.rect(x0, 29, x0 + 4, 31, 'k')
        g.set(x0 + 2, 31, '.')

    # ---- default face: dot eyes, small smile ------------------------------------
    for x0 in (12, 18):
        g.rect(x0, 11, x0 + 1, 12, 'e')
        g.set(x0, 11, 'w')
    g.row(15, 14, 17, 'e')
    g.set(13, 14, 'e')
    g.set(18, 14, 'e')

    # ---- volume: darken outline cells -------------------------------------------
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


if __name__ == '__main__':
    import draft32_d as base

    PAL = dict(base.GEM_PAL, y='#f1c40f', b='#2980b9', r='#c0392b',
               n='#e67e22', s='#7f8c8d')
    PAL['k'] = '#23232e'
    PAL['R'] = '#55555f'
    rows = build_g().rows()
    base.render_rows(rows, 'body-g.png', PAL, base.GEM_ORANGE, 12)
    print('body-g ok')


# ---- STANDARD-V1: the spec sheet, redrawn ------------------------------------
# Skin #F9C180, hood #2C2C2C, horns #925321, blush #FF9999. Same 32px grid,
# same chars plus 'h' for horns, so kit, rim, pipeline and tests keep working.
# Proportions off the sheet: 32 tall, long slim arms, stubby legs, big face.
STD_SKIN = '#F9C180'
STD_HOOD = '#2C2C2C'
STD_HORN = '#925321'
STD_BLUSH = '#FF9999'


def build_std():
    g = d.Grid(W, H)

    # One hooded mass. Slimmer than the round body so the long arms read as
    # limbs, not fluff: the sheet's arms are 10px on a 32px creature.
    silhouette = {
        4: 14, 5: 17, 6: 19, 7: 21, 8: 22, 9: 23, 10: 23, 11: 23,
        12: 23, 13: 23, 14: 23, 15: 23, 16: 23, 17: 23, 18: 24, 19: 25,
        20: 25, 21: 25, 22: 25, 23: 25, 24: 25, 25: 24, 26: 23, 27: 21,
        28: 19,
    }
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        g.row(y, x0, x0 + w - 1, 'k')

    # Brown pointed ears, tilted out, rooted in the hood. Horn span 18.
    for x, y in ((8, 4), (9, 4), (10, 4),
                 (7, 3), (8, 3), (9, 3),
                 (6, 2), (7, 2), (8, 2),
                 (6, 1), (7, 1)):
        g.set(x, y, 'h')
        g.set(31 - x, y, 'h')

    # Big beige face: most of the front.
    face = [(8, 9, 22), (9, 8, 23), (10, 8, 23), (11, 8, 23),
            (12, 8, 23), (13, 8, 23), (14, 8, 23), (15, 8, 23),
            (16, 8, 23), (17, 9, 22)]
    for y, x0, x1 in face:
        g.row(y, x0, x1, 'o')

    # Round belly, low.
    belly = [(20, 12, 19), (21, 11, 20), (22, 10, 21), (23, 10, 21),
             (24, 10, 21), (25, 11, 20), (26, 12, 19), (27, 13, 18)]
    for y, x0, x1 in belly:
        g.row(y, x0, x1, 'o')

    # Long slim arms with mitten ends.
    for x, y in ((3, 14), (4, 14), (3, 15), (4, 15), (3, 16), (4, 16),
                 (3, 17), (4, 17), (3, 18), (4, 18), (3, 19), (4, 19),
                 (3, 20), (4, 20), (3, 21), (4, 21), (3, 22), (4, 22),
                 (3, 23), (4, 23)):
        g.set(x, y, 'k')
        g.set(31 - x, y, 'k')
    for x in (3, 4):
        g.set(x, 23, 'd')
        g.set(31 - x, 23, 'd')

    # Stubby legs with feet.
    for x0 in (8, 19):
        g.rect(x0, 29, x0 + 4, 31, 'k')
        g.set(x0 + 2, 31, '.')

    # Default face: dot eyes, small smile, pink cheeks.
    for x0 in (12, 18):
        g.rect(x0, 11, x0 + 1, 12, 'e')
        g.set(x0, 11, 'w')
    g.row(15, 14, 17, 'e')
    g.set(13, 14, 'e')
    g.set(18, 14, 'e')
    for x, y in ((10, 12), (11, 12), (20, 12), (21, 12)):
        g.set(x, y, 'r')

    # Volume: darken outline cells.
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
