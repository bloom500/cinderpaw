"""Every state's FIRST frame, side by side, big.

The reference pack reuses ONE body across all 73 illustrations and puts the
expression entirely in the eyes and mouth. This renders the same view of ours,
so a state that says nothing with its face is visible at a glance.
"""
import io, re
from PIL import Image, ImageDraw

OUT = '../../frontend-react/src/components/chat/mascot/'
src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
frames = {n: re.findall(r"'([^']*)'", b)
          for n, b in re.findall(r"const (\w+): Frame = \[(.*?)\];", src, re.S)}
PAL = dict(re.findall(r"(\w): '(#[0-9a-fA-F]+)'", src.split('PALETTE')[1].split('}')[0]))


def rgb(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    t = max(0, min(1, t))
    return '#' + ''.join('%02x' % round(x + (y - x) * t) for x, y in zip(rgb(a), rgb(b)))


W = int(re.search(r'export const FRAME_W = (\d+);', src).group(1))
H = int(re.search(r'export const FRAME_H = (\d+);', src).group(1))
ORANGE = re.search(r"const MASCOT_ORANGE = '(#[0-9a-fA-F]+)';", src).group(1)

# The same ramp frames.ts computes, so the preview matches the app.
SHADE = []
for row in range(H):
    t = max(0, min(1, (row - 4) / 24))
    c = mix(mix(ORANGE, '#f7c98d', max(0, 0.32 - t * 0.36)), '#6e3418', max(0, t - 0.5) * 0.6)
    belly = 1 - abs(row - 21) / 7
    SHADE.append(mix(c, '#f08c2e', belly * 0.35) if belly > 0 else c)

mv = re.search(r"export const VARIANTS[^=]*= \{(.*?)\n\};", src, re.S).group(1)
states = []
for m in re.finditer(r"(\w+)\s*:\s*\[(.*)\],\s*$", mv, re.M):
    first = re.findall(r"\[([^\[\]]+)\]", m.group(2))[0]
    states.append((m.group(1), [x.strip() for x in first.split(',')]))

S, COLS = 9, 6
CW, CH = W * S * 2 + 24, H * S + 18
rows_n = (len(states) + COLS - 1) // COLS
img = Image.new('RGB', (COLS * CW, rows_n * CH), (24, 24, 27))
d = ImageDraw.Draw(img)
for i, (state, fs) in enumerate(states):
    ox, oy = (i % COLS) * CW + 6, (i // COLS) * CH + 13
    d.text((ox, oy - 12), '%s  %s' % (state, '/'.join(fs[:2])), fill=(150, 150, 160))
    for k, fname in enumerate(fs[:2]):
        bx = ox + k * (W * S + 8)
        for r, row in enumerate(frames[fname]):
            for c, ch in enumerate(row):
                if ch == '.':
                    continue
                col = SHADE[r] if ch == 'o' else PAL.get(ch, '#ffffff')
                d.rectangle([bx + c * S, oy + r * S, bx + c * S + S - 1, oy + r * S + S - 1], rgb(col))
img.save('faces.png')
print('states:', len(states))
