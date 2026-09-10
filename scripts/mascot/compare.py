"""Reference illustration vs what we ship, side by side.

Left: the pack's own artwork, every pixel of it.
Right: what `scenes.ts` draws, on our canvas, beside our creature.

The question this answers is "is the prop still THEIR drawing" -- and the honest
answer is only visible with both on screen at once.
"""
import io, re, sys, json
from PIL import Image, ImageDraw

OUT = '../../frontend-react/src/components/chat/mascot/'
S, MX, MT = 10, 14, 20

src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
FW = int(re.search(r'export const FRAME_W = (\d+);', src).group(1))
FH = int(re.search(r'export const FRAME_H = (\d+);', src).group(1))
ORANGE = re.search(r"const MASCOT_ORANGE = '(#[0-9a-fA-F]+)';", src).group(1)
Y0, W, H = MT + 1, FW + MX * 2, FH + 2 + MT
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
for row in range(FH):
    t = max(0, min(1, (row - 4) / 24))
    c = mix(mix(ORANGE, '#f7c98d', max(0, 0.32 - t * 0.36)), '#6e3418', max(0, t - 0.5) * 0.6)
    belly = 1 - abs(row - 21) / 7
    SHADE.append(mix(c, '#f08c2e', belly * 0.35) if belly > 0 else c)

ref = json.loads(io.open('refpack.json', encoding='utf-8').read())
sc = io.open(OUT + 'scenes.ts', encoding='utf-8').read()
ours = {}
for m in re.finditer(r"\n  (\w+): \[\n(.*?)\n  \],", sc, re.S):
    for line in m.group(2).split('\n'):
        px = [(int(a), int(b), c) for a, b, c in re.findall(r'\[(\d+),(\d+),"(#[0-9a-fA-F]+)"\]', line)]
        if px:
            ours[re.search(r'/\* (.*?) \*/', line).group(1)] = (m.group(1), px)

names = sys.argv[1:]
PAD = 16
cellW = max(max(ref[n]['w'] for n in names), W) * S + PAD
img = Image.new('RGB', (cellW * 2, len(names) * (H * S + PAD + 12)), (24, 24, 27))
d = ImageDraw.Draw(img)
for i, name in enumerate(names):
    oy = i * (H * S + PAD + 12) + 12
    state, px = ours[name]
    d.text((4, oy - 11), 'REFERENCE  %s' % name, fill=(150, 150, 160))
    d.text((cellW + 4, oy - 11), 'OURS  %s / %s' % (state, name), fill=(150, 150, 160))
    v = ref[name]
    for r, row in enumerate(v['rows']):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            d.rectangle([4 + c * S, oy + r * S, 4 + c * S + S - 1, oy + r * S + S - 1],
                        rgb(v['colors'][int(ch, 16)]))
    for x, y, c in px:
        d.rectangle([cellW + x * S, oy + y * S, cellW + x * S + S - 1, oy + y * S + S - 1], rgb(c))
    for r, row in enumerate(frames['F32_IDLE_0']):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            col = SHADE[r] if ch == 'o' else PAL.get(ch, '#ffffff')
            d.rectangle([cellW + (MX + c) * S, oy + (Y0 + r) * S,
                         cellW + (MX + c) * S + S - 1, oy + (Y0 + r) * S + S - 1], rgb(col))
img.save('compare.png')
print('compare.png:', ', '.join(names))
