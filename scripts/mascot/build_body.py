"""Compose our creature out of the reference's own vocabulary.

The pack draws one solid 14x11 block and CUTS its features out of it: the mouth
is a gap, the legs are gaps, only the eyes are ink. No outline anywhere, which
is exactly why their body can change shape from one illustration to the next --
there is no drawn edge to redraw.

Ours had a one-pixel black outline on every side, which is what froze all 98
frames into the same silhouette. This builds the replacement: same 16x16 frame,
same palette characters, no outline, features cut out.

`o` is our shaded body char, `k` is ink, `.` is a hole.
"""
import io, json

W, H = 16, 16      # our frame, unchanged
BW, BH = 14, 11    # the reference body, unchanged
X0 = (W - BW) // 2  # 1

# The two tufts stay. They are the creature's own, not something borrowed from
# the reference -- which has notches cut into its head instead -- and the
# comment they were first drawn with asks for them to stay ambiguous between
# ears and horns. What was wrong was never the tufts: it was the 2-to-4-pixel
# props that kept landing ON them, so a state read as a horn growing a second
# horn. Those are gone; these are not.
#
# Two rows: a single pixel at the tip, widening into the skull below it.
TUFTS = ['..#........#..', '.##........##.']
Y0 = H - (BH + len(TUFTS))

# ---- the vocabulary, lifted straight off the reference bodies ---------------
# Each is one row of the 14-wide block. '#' is body, 'o' ink, '.' a hole.
EYES = {
    'open':      ['###o######o###'],
    'wide':      ['##o#o####o#o##', '###o######o###'],
    'happy':     ['##oo######oo##'],
    'dead':      ['##o.o####o.o##', '###o######o###'],
    'dizzy':     ['##o#o####o#o##', '###o######o###', '##o#o####o#o##'],
    'shut':      ['##ooo####ooo##'],
    'squint':    ['###oo####oo###'],
    'left':      ['##o#######o###'],
    'right':     ['###o#######o##'],
    # Angry: the ink drops one row on the inner side, which is a brow.
    'cross':     ['##o#######o###', '###o#####o####'],
    # Tired: a single wide ink line, no white anywhere.
    'heavy':     ['##ooo####ooo##', '###o######o###'],
}
MOUTH = {
    'smile':  ['#####.##.#####', '######..######'],
    'small':  ['######..######'],
    'open':   ['#####.##.#####', '#####.##.#####', '######..######'],
    'wide':   ['####.####.####', '####......####'],
    'flat':   ['#####....#####'],
    'none':   [],
}
LEGS = {
    'stand': ['#..#......#..#', '#..#......#..#'],
    'apart': ['...#......#...', '...#......#...'],
    'step':  ['#..#......#..#', '.#.#......#.#.'],
}


def block(eyes, mouth, legs, gap_before_eyes=1, lean=0):
    """One 14-wide body: tufts, filler, eyes, mouth, filler, legs."""
    rows = ['#' * BW] * gap_before_eyes
    rows += EYES[eyes]
    rows += MOUTH[mouth]
    legrows = LEGS[legs]
    while len(rows) < BH - len(legrows):
        rows.append('#' * BW)
    rows = rows[:BH - len(legrows)] + legrows
    # Tufts ride on top and shear with the head, so a tilt tilts them too.
    rows = list(TUFTS) + rows
    if lean:
        # Shear the body: each row up top shifts sideways, which is how the
        # reference tilts a head without redrawing an outline it does not have.
        out = []
        for i, r in enumerate(rows):
            k = round(lean * (len(rows) - 1 - i) / (len(rows) - 1))
            if k > 0:
                out.append('.' * k + r[:-k] if k < BW else '.' * BW)
            elif k < 0:
                out.append(r[-k:] + '.' * -k)
            else:
                out.append(r)
        rows = out
    return rows


def frame(**kw):
    """Drop a body into our 16x16 frame and translate to palette chars."""
    rows = block(**kw)
    grid = [['.'] * W for _ in range(H)]
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch == '#':
                grid[Y0 + r][X0 + c] = 'o'
            elif ch == 'o':
                grid[Y0 + r][X0 + c] = 'k'
    return [''.join(r) for r in grid]


# ---- the set ---------------------------------------------------------------
SET = {
    'WAVE':      dict(eyes='happy',  mouth='smile', legs='apart'),
    'STRETCH':   dict(eyes='shut',   mouth='wide',  legs='apart'),
    'GAMING':    dict(eyes='squint', mouth='small', legs='apart'),
    'COOL':      dict(eyes='shut',   mouth='smile', legs='stand'),
    'SPAWN':     dict(eyes='wide',   mouth='small', legs='apart'),
    'EXCITED':   dict(eyes='wide',   mouth='wide',  legs='apart'),
    'SEARCH':    dict(eyes='wide',   mouth='small', legs='stand', lean=-2),
    'ANGRY':     dict(eyes='cross',  mouth='flat',  legs='stand'),
    'TIRED':     dict(eyes='heavy',  mouth='small', legs='apart'),
    'IDLE':      dict(eyes='open',   mouth='smile', legs='stand'),
    'BLINK':     dict(eyes='shut',   mouth='smile', legs='stand'),
    'TYPING':    dict(eyes='squint', mouth='small', legs='step'),
    'THINK_L':   dict(eyes='left',   mouth='small', legs='stand', lean=1),
    'THINK_R':   dict(eyes='right',  mouth='small', legs='stand', lean=-1),
    'CALL':      dict(eyes='wide',   mouth='small', legs='stand'),
    'DONE':      dict(eyes='happy',  mouth='open',  legs='apart'),
    'CELEBRATE': dict(eyes='happy',  mouth='open',  legs='apart'),
    'SURPRISED': dict(eyes='wide',   mouth='flat',  legs='stand'),
    'CURIOUS':   dict(eyes='left',   mouth='small', legs='stand', lean=2),
    'SLEEP':     dict(eyes='shut',   mouth='small', legs='apart'),
    'ERROR':     dict(eyes='dizzy',  mouth='flat',  legs='apart'),
    'LOVE':      dict(eyes='happy',  mouth='smile', legs='stand'),
    'OFFLINE':   dict(eyes='dead',   mouth='flat',  legs='apart'),
    'READ':      dict(eyes='squint', mouth='small', legs='stand', lean=1),
    'RUN_A':     dict(eyes='open',   mouth='small', legs='step'),
    'RUN_B':     dict(eyes='open',   mouth='small', legs='stand'),
}

out = {k: frame(**v) for k, v in SET.items()}
io.open('newbody.json', 'w', encoding='utf-8').write(json.dumps(out, separators=(',', ':')))
for k in ['IDLE', 'THINK_L', 'CURIOUS', 'ERROR', 'DONE']:
    print('---', k)
    for r in out[k]:
        print('  ' + r)
print('built %d frames' % len(out))
