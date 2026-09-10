"""Render every scene beside the creature, as PNG contact sheets.

A scene is checked by LOOKING at it. The tests can prove a prop is not on the
creature; they cannot prove it reads as an object rather than as a fragment of
somebody else's character, and that is the whole failure this layer exists to
avoid.

    python preview.py           # writes preview-1.png .. preview-N.png
"""
import io, re, sys
from PIL import Image, ImageDraw

OUT = '../../frontend-react/src/components/chat/mascot/'
S, GAP, COLS, PER = 6, 10, 6, 24
MX, MT = 14, 20
Y0, W, H = MT + 1, 44, 38

src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
frames = {n: re.findall(r"'([^']*)'", b)
          for n, b in re.findall(r"const (\w+): Frame = \[(.*?)\];", src, re.S)}
PAL = dict(re.findall(r"(\w): '(#[0-9a-fA-F]+)'", src.split('PALETTE')[1].split('}')[0]))


def rgb(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    t = max(0, min(1, t))
    return '#' + ''.join('%02x' % round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


SHADE = []
for row in range(16):
    t = max(0, min(1, (row - 2) / 11))
    c = mix(mix('#cf7740', '#f4c285', max(0, 0.30 - t * 0.34)), '#7a3d1a', max(0, t - 0.45) * 0.55)
    belly = 1 - abs(row - 8) / 5
    SHADE.append(mix(c, '#ec8a33', belly * 0.30) if belly > 0 else c)

sc = io.open(OUT + 'scenes.ts', encoding='utf-8').read()
items = []
for m in re.finditer(r"\n  (\w+): \[\n(.*?)\n  \],", sc, re.S):
    for line in m.group(2).split('\n'):
        px = [(int(a), int(b), c) for a, b, c in re.findall(r'\[(\d+),(\d+),"(#[0-9a-fA-F]+)"\]', line)]
        if px:
            items.append((m.group(1), re.search(r'/\* (.*?) \*/', line).group(1), px))

CW, CH = W * S + GAP, H * S + GAP + 9
for sheet in range((len(items) + PER - 1) // PER):
    chunk = items[sheet * PER:(sheet + 1) * PER]
    rows = (len(chunk) + COLS - 1) // COLS
    img = Image.new('RGB', (COLS * CW, rows * CH), (24, 24, 27))
    d = ImageDraw.Draw(img)
    for i, (state, name, px) in enumerate(chunk):
        ox, oy = (i % COLS) * CW + GAP // 2, (i // COLS) * CH + 9
        d.text((ox, oy - 9), '%s / %s' % (state, name[:26]), fill=(150, 150, 160))
        for x, y, c in px:
            d.rectangle([ox + x * S, oy + y * S, ox + x * S + S - 1, oy + y * S + S - 1], rgb(c))
        for r, row in enumerate(frames['SPA']):
            for c, ch in enumerate(row):
                if ch == '.':
                    continue
                col = SHADE[r] if ch == 'o' else PAL.get(ch, '#ffffff')
                d.rectangle([ox + (MX + c) * S, oy + (Y0 + r) * S,
                             ox + (MX + c) * S + S - 1, oy + (Y0 + r) * S + S - 1], rgb(col))
    img.save('preview-%d.png' % (sheet + 1))
    print('preview-%d.png  %d scenes' % (sheet + 1, len(chunk)))
