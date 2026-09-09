"""Generate the whole mascot: bodies, scenes, and the variant table.

One creature, drawn once per expression, and every prop it has ever had comes
from the reference pack and stands in the margin beside it. That is how the 75
illustrations were composed, and it is what this produces.
"""
import io, json, re

OUT = '../../frontend-react/src/components/chat/mascot/'
CANVAS_W, CANVAS_H = 44, 38
FX_MARGIN_X, FX_MARGIN_TOP = 14, 20
Y0 = FX_MARGIN_TOP + 1
CLEARANCE = 3

# Occupancy comes from the REAL mascot, not a generated stand-in. Its `k` is
# black FUR, not an outline -- the creature is a dark furry monster with orange
# horns, an orange face patch and a round orange belly, and the sprite has
# always been a faithful translation of it.
_src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
_m = re.search(r"const SPA: Frame = \[(.*?)\];", _src, re.S)
bodies = {'IDLE': re.findall(r"'([^']*)'", _m.group(1))}
props = json.loads(io.open('props.json', encoding='utf-8').read())
ASSIGN = json.loads(io.open('assign.json', encoding='utf-8').read())

# The accessory sheets, used only where the fragment has a shape of its own.
ASSIGN.setdefault('wave', []).append('artboard-24cla')       # a "hi" and two arms
ASSIGN.setdefault('celebrate', []).append('artboard-4cla')   # a burst
ASSIGN.setdefault('done', []).append('artboard-25cla3')      # an arrow, climbing
ASSIGN.setdefault('calling', []).append('artboard-3cla')     # a paw and a window
ASSIGN.setdefault('excited', []).append('artboard-2cla')     # sparks

# ---- where our creature stands, from the body we just built ----------------
idle = bodies['IDLE']
occupied = {(Y0 + r, FX_MARGIN_X + c)
            for r, row in enumerate(idle) for c, ch in enumerate(row) if ch != '.'}
ourTop = min(r for r, _ in occupied); ourBottom = max(r for r, _ in occupied)
ourLeft = min(c for _, c in occupied); ourRight = max(c for _, c in occupied)
ourW, ourH = ourRight - ourLeft + 1, ourBottom - ourTop + 1

halo = {}
for (by, bx) in occupied:
    for dy in range(-CLEARANCE, CLEARANCE + 1):
        for dx in range(-CLEARANCE, CLEARANCE + 1):
            k = (by + dy, bx + dx)
            if k in occupied:
                continue
            halo[k] = max(halo.get(k, 0), CLEARANCE - max(abs(dy), abs(dx)) + 1)


def axis(d, span, lo, hi, ourSpan):
    if d < 0:
        return lo + d
    if d >= span:
        return hi + (d - span) + 1
    return lo + round(d * (ourSpan - 1) / max(1, span - 1))


def place(name):
    p = props.get(name)
    if not p or len(p['scene']) < 12:
        return None
    W, H = p['body']
    raw = [(axis(dc, W, ourLeft, ourRight, ourW), axis(dr, H, ourTop, ourBottom, ourH), col)
           for dr, dc, col in p['scene']]
    best = None
    for dy in range(-34, 16):
        for dx in range(-28, 29):
            off = over = crowd = 0
            for x, y, _ in raw:
                X, Y = x + dx, y + dy
                if not (0 <= X < CANVAS_W and 0 <= Y < CANVAS_H):
                    off += 1
                elif (Y, X) in occupied:
                    over += 1
                else:
                    crowd += halo.get((Y, X), 0)
            score = off * 6 + over * 25 + crowd * 1.5 + (abs(dx) + abs(dy)) * 0.05
            if best is None or score < best[0]:
                best = (score, dx, dy)
    _, dx, dy = best
    seen, kept = set(), []
    for x, y, col in raw:
        X, Y = x + dx, y + dy
        if not (0 <= X < CANVAS_W and 0 <= Y < CANVAS_H):
            continue
        if (Y, X) in occupied or (Y, X) in seen:
            continue
        seen.add((Y, X))
        kept.append([X, Y, col])
    return kept


scenes, report = {}, []
for state, names in ASSIGN.items():
    got = []
    for n in names:
        pl = place(n)
        if pl:
            got.append({'from': n, 'px': pl})
            report.append((state, n, len(props[n]['scene']), len(pl)))
    if got:
        scenes[state] = got

VARIANTS = {
    'idle':       [['IDLE', 'IDLE', 'IDLE', 'BLINK']],
    'typing':     [['TYPING', 'IDLE']],
    'thinking':   [['THINK_L', 'THINK_R']],
    'calling':    [['CALL', 'IDLE']],
    'done':       [['DONE']],
    'running':    [['RUN_A', 'RUN_B']],
    'wave':       [['WAVE', 'IDLE']],
    'sleep':      [['SLEEP', 'SLEEP', 'TIRED']],
    'surprised':  [['SURPRISED', 'IDLE']],
    'curious':    [['CURIOUS', 'IDLE']],
    'celebrate':  [['CELEBRATE', 'DONE']],
    'reading':    [['READ', 'IDLE']],
    'searching':  [['SEARCH', 'CURIOUS']],
    'building':   [['CALL', 'TYPING']],
    'writing':    [['TYPING', 'READ']],
    'stretching': [['STRETCH', 'IDLE']],
    'gaming':     [['GAMING', 'TYPING']],
    'love':       [['LOVE']],
    'cool':       [['COOL']],
    'error':      [['ERROR', 'ANGRY']],
    'excited':    [['EXCITED', 'DONE']],
    'spawning':   [['SPAWN', 'IDLE']],
}
used = []

print('%-11s %-32s %5s %5s' % ('state', 'illustration', 'orig', 'kept'))
for r in report:
    print('%-11s %-32s %5d %5d' % r)
print()
print('scenes placed : %d across %d states' % (sum(len(v) for v in scenes.values()), len(scenes)))
print('states without a scene: %s' % sorted(set(VARIANTS) - set(scenes)))

json.dump({'scenes': scenes}, io.open('built.json', 'w', encoding='utf-8'), separators=(',', ':'))
