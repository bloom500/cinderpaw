"""Generate the whole mascot: bodies, scenes, and the variant table.

One creature, drawn once per expression, and every prop it has ever had comes
from the reference pack and stands in the margin beside it. That is how the 75
illustrations were composed, and it is what this produces.
"""
import io, json, re

OUT = '../../frontend-react/src/components/chat/mascot/'
CANVAS_W, CANVAS_H = 60, 54
FX_MARGIN_X, FX_MARGIN_TOP = 14, 20
Y0 = FX_MARGIN_TOP + 1
CLEARANCE = 3

# Occupancy comes from the REAL mascot, not a generated stand-in. Its `k` is
# black FUR, not an outline -- the creature is a dark furry monster with orange
# horns, an orange face patch and a round orange belly, and the sprite has
# always been a faithful translation of it.
#
# EVERY frame, not the resting one. A state animates: `wave` raises an arm,
# `celebrate` throws both up. Placing against the resting pose alone put
# scenes on top of the creature's own limbs the moment it moved --
# invisible while it sat still, a pixel welded to the arm as soon as it waved.
# The union of all 50 frames is the footprint, so a prop clears the creature in
# every pose it can take, and a redrawn frame re-clears the props automatically.
_src = io.open(OUT + 'frames.ts', encoding='utf-8').read()
bodies = {name: re.findall(r"'([^']*)'", body)
          for name, body in re.findall(r"const (\w+): Frame = \[(.*?)\];", _src, re.S)}
props = json.loads(io.open('props.json', encoding='utf-8').read())
ASSIGN = json.loads(io.open('assign.json', encoding='utf-8').read())

# The accessory sheets, used only where the fragment has a shape of its own.
# It reads OM, in letters, with sparks either side. It was filed under `wave`
# because it looked like a greeting at thumbnail size; rendered next to the
# creature it is unmistakably somebody sitting and humming.
ASSIGN.setdefault('meditating', []).append('artboard-24cla')
ASSIGN.setdefault('celebrate', []).append('artboard-4cla')   # a burst
ASSIGN.setdefault('done', []).append('artboard-25cla3')      # an arrow, climbing
ASSIGN.setdefault('calling', []).append('artboard-3cla')     # a paw and a window
ASSIGN.setdefault('excited', []).append('artboard-2cla')     # sparks

# ---- where our creature stands, from the body we just built ----------------
idle_rows = bodies['F32_IDLE_0_0']
occupied = {(Y0 + r, FX_MARGIN_X + c)
            for rows in bodies.values()
            for r, row in enumerate(rows) for c, ch in enumerate(row) if ch != '.'}
ourTop = min(r for r, _ in occupied); ourBottom = max(r for r, _ in occupied)
ourLeft = min(c for _, c in occupied); ourRight = max(c for _, c in occupied)
ourW, ourH = ourRight - ourLeft + 1, ourBottom - ourTop + 1

# `sceneFor` lifts the whole scene one cell DOWN on half the ticks, so a prop is
# drawn at y and at y+1. Placement used to be scored at y only, and 14 of the 66
# scenes spent half their frames either inside the creature or off the bottom of
# the canvas -- a pixel stuck on the animal, which is the exact defect this
# pipeline exists to remove, reappearing every fourth frame. So the body is
# treated as one cell taller upward and the canvas as one row shorter downward:
# both positions have to be legal, not just the resting one.
occupiedLift = occupied | {(y - 1, x) for y, x in occupied}

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

    # Some props are not standing NEXT to the creature, they are standing
    # AROUND it: the glow of `in-glowing-aura` is drawn on all four sides at
    # once. Sliding one of those to find three cells of air is the wrong move
    # and it shows -- the aura ends up bunched on the right, which is a light
    # source in the room rather than a creature that is glowing. A scene with
    # cells on both sides of the body was composed around it, so it is left
    # where it was mapped, and only the cells that land ON the creature go.
    above = any(dr < 0 for dr, _, _ in p['scene'])
    below = any(dr >= H for dr, _, _ in p['scene'])
    leftof = any(dc < 0 for _, dc, _ in p['scene'])
    rightof = any(dc >= W for _, dc, _ in p['scene'])
    wraps = (above and below) or (leftof and rightof)
    if wraps:
        seen, kept = set(), []
        for x, y, col in raw:
            if not (0 <= x < CANVAS_W and 0 <= y and y + 1 < CANVAS_H):
                continue
            if (y, x) in occupiedLift or (y, x) in seen:
                continue
            seen.add((y, x))
            kept.append([x, y, col])
        return kept

    best = None
    for dy in range(-34, 16):
        for dx in range(-28, 29):
            off = over = crowd = 0
            for x, y, _ in raw:
                X, Y = x + dx, y + dy
                if not (0 <= X < CANVAS_W and 0 <= Y and Y + 1 < CANVAS_H):
                    off += 1
                elif (Y, X) in occupiedLift:
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
        if not (0 <= X < CANVAS_W and 0 <= Y and Y + 1 < CANVAS_H):
            continue
        if (Y, X) in occupiedLift or (Y, X) in seen:
            continue
        seen.add((Y, X))
        kept.append([X, Y, col])
    return kept


# ---- where OUR paws go, from where THEIRS were ----------------------------
#
# Two positions, and they were arrived at by drawing ten and looking. On the
# belly rows a paw sits on the dark flank; beside the face it moves one column
# further out, because there the orange patch starts right behind the flank and
# a paw on it merges into the face and only makes the head look wider.
FLANK_L, FLANK_R = (4, 5), (26, 27)
HEAD_L, HEAD_R = (5, 6), (25, 26)
PAW_ROWS = (6, 27)      # never on the horns and face, never through the feet
FACE_ROWS = 18          # above this the face is what the paw would touch


def paws_for(name):
    """Map the reference's hand positions onto our creature.

    Their hands say which SIDE the creature is working on and how high, and
    that is all we take: the sprite is a different animal at a different size,
    so copying the offset directly would put a paw in the air. Side and height,
    snapped to the two positions our creature actually has.
    """
    p = props.get(name)
    if not p:
        return []
    W, H = p['body']
    out = []
    for dr, dc in p.get('hands', []):
        row = Y0 + int(round((dr / max(1, H - 1)) * (len(idle_rows) - 1)))
        row = max(Y0 + PAW_ROWS[0], min(Y0 + PAW_ROWS[1], row))
        left = dc + 1 < W / 2
        r = row - Y0
        cols = (HEAD_L if left else HEAD_R) if r < FACE_ROWS else (FLANK_L if left else FLANK_R)
        for rr in (r, r + 1):
            if not (PAW_ROWS[0] <= rr <= PAW_ROWS[1]):
                continue
            for cc in cols:
                out.append([cc, rr])
    seen, uniq = set(), []
    for cell in out:
        k = tuple(cell)
        if k not in seen:
            seen.add(k)
            uniq.append(cell)
    return uniq


scenes, report = {}, []
for state, names in ASSIGN.items():
    got = []
    for n in names:
        pl = place(n)
        if pl:
            got.append({'from': n, 'px': pl, 'paws': paws_for(n)})
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
