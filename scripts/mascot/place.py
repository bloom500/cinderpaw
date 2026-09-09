"""Place each reference scene into OUR canvas, around OUR creature.

The reference body is 20x11 and ours is taller and narrower, so a scene cannot
just be pasted at the same offsets. It is anchored by SIDE instead: anything
drawn left of their body goes left of ours, anything above goes above, and
anything spanning the body is spread across ours proportionally. That keeps a
prop on the side it was composed on, which is what makes it read.
"""
import io, json, re, sys

SRC = '../../frontend-react/src/components/chat/mascot/frames.ts'
# The margin grows UPWARD, not downward. Below the creature's feet is the
# composer's text field, and a prop drawn there covers what someone is typing.
# Above it is empty chat, which is why the perch already bleeds 24px up.
FX_MARGIN_X, FX_MARGIN_TOP = 14, 20
CANVAS_W, CANVAS_H = 16 + FX_MARGIN_X * 2, 18 + FX_MARGIN_TOP
Y0 = FX_MARGIN_TOP + 1

# Which illustration dresses which state. Only where the scene says the same
# thing the state does; a state with nothing honest to show gets nothing.
CHOICE = {
    'thinking':  'thinking-in-code',
    'calling':   'multi-window-workflow',
    'done':      'with-success-checkmark',
    'running':   'fast-performance-trail',
    'wave':      'welcome-pixel-banner',
    'sleep':     'sleeping-soundly',
    'curious':   'confusion-spiral-pixel',
    'celebrate': 'happy-pixel-celebrating',
    'reading':   'reading-data-document',
    'searching': 'examining-green-globe',
    'building':  'building-colorful-blocks',
    'writing':   'writing-software-code',
    'love':      'love-cloud-pixel',
    'error':     'system-error-alert',
    'excited':   'idea-lightbulb-pixel',
}

props = json.loads(io.open('props.json', encoding='utf-8').read())

src = io.open(SRC, encoding='utf-8').read()
m = re.search(r"const SPA: Frame = \[(.*?)\];", src, re.S)
spa = re.findall(r"'([^']*)'", m.group(1))
occupied = {(Y0 + r, FX_MARGIN_X + c) for r, row in enumerate(spa)
            for c, ch in enumerate(row) if ch != '.'}
ourTop = min(r for r, _ in occupied); ourBottom = max(r for r, _ in occupied)
ourLeft = min(c for _, c in occupied); ourRight = max(c for _, c in occupied)
ourW = ourRight - ourLeft + 1
ourH = ourBottom - ourTop + 1

# How far a prop has to stand off the creature.
#
# Minimising travel alone parks every scene right against the body, which reads
# as clutter even when nothing technically overlaps -- the reference always
# leaves air between the character and the thing beside it. This is that air,
# priced: landing inside the halo costs more the closer in it lands.
CLEARANCE = 3
halo = {}
for (by, bx) in occupied:
    for dy in range(-CLEARANCE, CLEARANCE + 1):
        for dx in range(-CLEARANCE, CLEARANCE + 1):
            d = max(abs(dy), abs(dx))
            k = (by + dy, bx + dx)
            if k in occupied:
                continue
            halo[k] = max(halo.get(k, 0), CLEARANCE - d + 1)


def axis(d, span, lo, hi, ourSpan):
    if d < 0:
        return lo + d
    if d >= span:
        return hi + (d - span) + 1
    return lo + round(d * (ourSpan - 1) / max(1, span - 1))


out, report = {}, []
for state, name in CHOICE.items():
    p = props.get(name)
    if not p:
        report.append((state, name, 0, 0, 'MISSING'))
        continue
    W, H = p['body']
    kept, raw, lost_edge, lost_body = [], [], 0, 0
    seen = set()
    for dr, dc, col in p['scene']:
        x = axis(dc, W, ourLeft, ourRight, ourW)
        y = axis(dr, H, ourTop, ourBottom, ourH)
        raw.append((x, y, col))
    # Slide the WHOLE scene to where it fits, instead of clipping it in half.
    # A prop that loses a third of itself at the canvas edge is not a smaller
    # prop, it is a broken one.
    best = None
    for dy in range(-34, 16):
        for dx in range(-28, 29):
            inside = off = over = crowd = 0
            for x, y, _ in raw:
                X, Y = x + dx, y + dy
                if not (0 <= X < CANVAS_W and 0 <= Y < CANVAS_H):
                    off += 1
                elif (Y, X) in occupied:
                    over += 1
                else:
                    inside += 1
                    crowd += halo.get((Y, X), 0)
            # Overlap is the expensive one now, not clipping. A prop drawn
            # across the creature is the exact defect this whole change
            # exists to remove, and there are 800 free cells to move into --
            # so landing on the body has to cost far more than travelling.
            score = (off * 6 + over * 25 + crowd * 1.5 + abs(dx) * 0.05 + abs(dy) * 0.05)
            if best is None or score < best[0]:
                best = (score, dx, dy, inside, off, over)
    _, dx, dy, inside, lost_edge, lost_body = best
    for x, y, col in raw:
        X, Y = x + dx, y + dy
        if not (0 <= X < CANVAS_W and 0 <= Y < CANVAS_H):
            continue
        if (Y, X) in occupied or (Y, X) in seen:
            continue
        seen.add((Y, X))
        kept.append([X, Y, col])
    out[state] = kept
    report.append((state, name, len(p['scene']), len(kept), '%d off-canvas, %d behind the body' % (lost_edge, lost_body)))

print('%-11s %-30s %5s %5s  %s' % ('state', 'illustration', 'orig', 'kept', 'lost'))
for r in report:
    print('%-11s %-30s %5d %5d  %s' % r)
print()
print('our body box: cols %d..%d, rows %d..%d (%dx%d) in a %dx%d canvas'
      % (ourLeft, ourRight, ourTop, ourBottom, ourW, ourH, CANVAS_W, CANVAS_H))
print('free cells: %d' % (CANVAS_W * CANVAS_H - len(occupied)))
print('largest scene placed: %d cells' % max(len(v) for v in out.values()))

if '--write' in sys.argv:
    io.open('scenes.json', 'w', encoding='utf-8').write(json.dumps(out, separators=(',', ':')))
    print('written scenes.json')
