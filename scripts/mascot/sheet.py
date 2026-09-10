"""The sprite sheet, out to a PNG and back again.

`frames.ts` is grids of text, which is the right storage for it: it diffs, it
reviews, and the pipeline reads it to know where props must not stand. It is a
terrible thing to DRAW in.

So this is the round trip. Export writes every frame into one PNG at one pixel
per cell, opens in Aseprite or anything else, and import reads it back and
rewrites `frames.ts`. Nothing else in the pipeline changes: `build_all.py` will
re-clear every prop against whatever comes back.

    python sheet.py export        # writes frames-sheet.png + frames-sheet.json
    python sheet.py import        # reads them back into frames.ts

Two things to know before drawing in it:

- The BODY char `o` is not one colour. It is shaded per ROW so the creature
  looks lit from above, and export paints that ramp. On the way back, any
  colour close to the ramp for that row becomes `o` again, so shading a body
  pixel by hand is pointless -- the ramp wins.
- Transparent is `.`, and it must stay genuinely transparent. A cell filled
  with the background colour is not empty and will come back as a pixel.
"""
import io
import json
import os
import re
import sys

from PIL import Image

M = '../../frontend-react/src/components/chat/mascot/'
SHEET = 'frames-sheet.png'
INDEX = 'frames-sheet.json'
COLS = 12


def read_ts():
    src = io.open(M + 'frames.ts', encoding='utf-8').read()
    frames = {n: re.findall(r"'([^']*)'", b)
              for n, b in re.findall(r"const (\w+): Frame = \[(.*?)\];", src, re.S)}
    pal = dict(re.findall(r"(\w): '(#[0-9a-fA-F]+)'", src.split('PALETTE')[1].split('}')[0]))
    return src, frames, pal


def rgb(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    t = max(0, min(1, t))
    return '#' + ''.join('%02x' % round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


def shade_ramp(orange, h):
    """The same ramp `frames.ts` computes, so a round trip is lossless."""
    out = []
    for row in range(h):
        t = max(0, min(1, (row - 2) / 11))
        c = mix(mix(orange, '#f4c285', max(0, 0.30 - t * 0.34)), '#7a3d1a', max(0, t - 0.45) * 0.55)
        belly = 1 - abs(row - 8) / 5
        out.append(mix(c, '#ec8a33', belly * 0.30) if belly > 0 else c)
    return out


def geometry(src, frames):
    w = int(re.search(r'export const FRAME_W = (\d+);', src).group(1))
    h = int(re.search(r'export const FRAME_H = (\d+);', src).group(1))
    orange = re.search(r"const MASCOT_ORANGE = '(#[0-9a-fA-F]+)';", src).group(1)
    return w, h, orange


def do_export():
    src, frames, pal = read_ts()
    W, H, orange = geometry(src, frames)
    shade = shade_ramp(orange, H)
    names = sorted(frames)
    rows = (len(names) + COLS - 1) // COLS
    img = Image.new('RGBA', (COLS * W, rows * H), (0, 0, 0, 0))
    for i, n in enumerate(names):
        ox, oy = (i % COLS) * W, (i // COLS) * H
        for r, row in enumerate(frames[n]):
            for c, ch in enumerate(row):
                if ch == '.':
                    continue
                col = shade[r] if ch == 'o' else pal.get(ch)
                if not col:
                    continue
                img.putpixel((ox + c, oy + r), rgb(col) + (255,))
    img.save(SHEET)
    io.open(INDEX, 'w', encoding='utf-8', newline='\n').write(json.dumps(
        {'cols': COLS, 'frame': [W, H], 'names': names}, indent=1))
    print('%s : %d frames, %dx%d cells each, %d columns'
          % (SHEET, len(names), W, H, COLS))
    print('%s : the order, so import knows which cell is which frame' % INDEX)


def do_import():
    if not (os.path.exists(SHEET) and os.path.exists(INDEX)):
        sys.exit('run "python sheet.py export" first, then draw in %s' % SHEET)
    src, frames, pal = read_ts()
    W, H, orange = geometry(src, frames)
    shade = shade_ramp(orange, H)
    meta = json.loads(io.open(INDEX, encoding='utf-8').read())
    if meta['frame'] != [W, H]:
        sys.exit('the sheet is %dx%d per frame and frames.ts is now %dx%d; re-export'
                 % (meta['frame'][0], meta['frame'][1], W, H))
    img = Image.open(SHEET).convert('RGBA')

    def nearest(px, row):
        """Which palette char this pixel is, with the row's body tone included.

        Nearest in plain RGB distance, because the palette is nine colours that
        are nowhere near each other -- anything cleverer would be precision
        nobody can use.
        """
        best, bd = None, None
        cands = [(ch, col) for ch, col in pal.items() if col] + [('o', shade[row])]
        for ch, col in cands:
            t = rgb(col)
            d = sum((a - b) ** 2 for a, b in zip(px[:3], t))
            if bd is None or d < bd:
                best, bd = ch, d
        return best

    out, changed = {}, []
    for i, n in enumerate(meta['names']):
        ox, oy = (i % meta['cols']) * W, (i // meta['cols']) * H
        rows = []
        for r in range(H):
            line = ''
            for c in range(W):
                px = img.getpixel((ox + c, oy + r))
                line += '.' if px[3] < 128 else nearest(px, r)
            rows.append(line)
        out[n] = rows
        if n in frames and frames[n] != rows:
            changed.append(n)

    new = src
    for n, rows in out.items():
        body = '\n  ' + ',\n  '.join("'" + r + "'" for r in rows) + '\n'
        m = re.search(r"(const %s: Frame = \[)(.*?)(\];)" % n, new, re.S)
        if not m:
            print('  skipped %s: no such frame in frames.ts' % n)
            continue
        new = new[:m.start(2)] + body + new[m.end(2):]
    io.open(M + 'frames.ts', 'w', encoding='utf-8', newline='\n').write(new)
    print('frames.ts : %d frames read back, %d changed' % (len(out), len(changed)))
    if changed:
        print('  ' + ', '.join(sorted(changed)))
    print('now: python build_all.py && python emit.py   (re-clears every prop)')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else ''
    if what == 'export':
        do_export()
    elif what == 'import':
        do_import()
    else:
        sys.exit(__doc__)
