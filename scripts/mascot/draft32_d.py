"""Body iteration D: build_c fixes, rendered against two palettes.

Does not touch draft32.py. Run from scripts/mascot:

    python draft32_d.py
"""
import draft32 as d
from PIL import Image, ImageDraw

W = H = 32

APP_PAL = {'k': '#584c42', 'e': '#1c1c1e', 'w': '#ffffff', 'd': '#3f372f'}
APP_ORANGE = '#cf7740'
GEM_PAL = {'k': '#4a4b53', 'e': '#1c1c1e', 'w': '#ffffff', 'd': '#31323a'}
GEM_ORANGE = '#f2822c'


def build_d():
    g = d.Grid(W, H)

    # ---- one mass (same shaggy silhouette as C) ---------------------------
    silhouette = {
        4: 14, 5: 16, 6: 18, 7: 20, 8: 20, 9: 21, 10: 21, 11: 21, 12: 21,
        13: 21, 14: 20, 15: 20, 16: 21, 17: 22, 18: 24, 19: 26, 20: 26,
        21: 27, 22: 27, 23: 27, 24: 26, 25: 26, 26: 24, 27: 22, 28: 19,
    }
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        g.row(y, x0, x0 + w - 1, 'k')
    for y, w in silhouette.items():
        x0 = 16 - w // 2
        x1 = x0 + w - 1
        if y % 2 == 0:
            g.set(x0, y, '.')
            g.set(x1, y, '.')
        else:
            g.set(x0 - 1, y, 'k')
            g.set(x1 + 1, y, 'k')

    # ---- horns: thick, curved out, ROOTED two cells deep in the fur --------
    # C's horns floated above the head like antennae. These start inside the
    # mass (y4) and lean out, 3 wide at the base, 2 at the tip.
    horn_l = [(9, 4), (10, 4), (11, 4),
              (8, 3), (9, 3), (10, 3),
              (7, 2), (8, 2), (9, 2),
              (7, 1), (8, 1)]
    for x, y in horn_l:
        g.set(x, y, 'o')
        g.set(31 - x, y, 'o')

    # ---- face patch, high ---------------------------------------------------
    face = [(7, 12, 19), (8, 10, 21), (9, 9, 22), (10, 9, 22), (11, 9, 22),
            (12, 9, 22), (13, 10, 21), (14, 12, 19)]
    for y, x0, x1 in face:
        g.row(y, x0, x1, 'o')

    # ---- forehead fringe: fur teeth hanging OVER the patch -----------------
    # The reference grows fur over the face. C's patch had a shaved hairline.
    for x in (13, 14, 18):
        g.set(x, 7, 'k')
    g.set(12, 8, 'k')
    g.set(19, 8, 'k')

    # ---- belly ---------------------------------------------------------------
    belly = [(18, 13, 18), (19, 11, 20), (20, 10, 21), (21, 10, 21),
             (22, 10, 21), (23, 10, 21), (24, 11, 20), (25, 13, 18)]
    for y, x0, x1 in belly:
        g.row(y, x0, x1, 'o')

    # ---- paws: small nubs HUGGING the silhouette, not floating bars --------
    for x, y in ((4, 15), (5, 15), (4, 16), (5, 16)):
        g.set(x, y, 'k')
        g.set(31 - x, y, 'k')

    # ---- feet: narrower stubs with a toe notch -------------------------------
    for x0 in (8, 19):
        g.rect(x0, 29, x0 + 4, 31, 'k')
        g.set(x0 + 2, 31, '.')

    # ---- face: small eyes, one glint, narrow smile, two fangs ---------------
    for x0 in (12, 18):
        g.rect(x0, 10, x0 + 1, 11, 'e')
        g.set(x0, 10, 'w')
    g.row(13, 14, 17, 'e')
    g.set(13, 12, 'w')
    g.set(18, 12, 'w')

    # ---- fur tufts: broken interior so the mass is not flat ------------------
    for x, y in ((8, 15), (9, 15), (23, 15), (24, 15),
                 (6, 19), (7, 19), (25, 19), (26, 19),
                 (7, 21), (8, 21), (24, 21), (25, 21),
                 (7, 24), (8, 24), (24, 24), (25, 24)):
        if g.cells[y][x] == 'k':
            g.set(x, y, 'd')

    # ---- volume: darken outline cells (same rule as C) ------------------------
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


def render_rows(rows, path, pal, orange, scale=12, bg='#1C1916'):
    shade = d.ramp(orange, len(rows))
    img = Image.new('RGB', (len(rows[0]) * scale, len(rows) * scale), d.rgb(bg))
    px = ImageDraw.Draw(img)
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            col = shade[r] if ch == 'o' else pal.get(ch)
            if not col:
                continue
            px.rectangle([c * scale, r * scale, c * scale + scale - 1,
                          r * scale + scale - 1], d.rgb(col))
    img.save(path)


def strip(paths, out, scale=10, gap=16, bg='#1C1916'):
    imgs = [Image.open(p) for p in paths]
    w = sum(i.width for i in imgs) + gap * (len(imgs) - 1)
    h = max(i.height for i in imgs)
    sheet = Image.new('RGB', (w, h), d.rgb(bg))
    x = 0
    for i in imgs:
        sheet.paste(i, (x, 0))
        x += i.width + gap
    sheet.save(out)


if __name__ == '__main__':
    rows_d = build_d().rows()
    render_rows(rows_d, 'draft32-d.png', APP_PAL, APP_ORANGE)
    render_rows(rows_d, 'draft32-d-gem.png', GEM_PAL, GEM_ORANGE)
    strip(['draft32.png', 'draft32-c.png', 'draft32-d.png', 'draft32-d-gem.png'],
          'draft32-choices2.png')
    print('d, d-gem, choices2 ok')
