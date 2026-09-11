"""All 23 mascot states at 32px, composed on the D body (draft32_d, GEM palette).

One shared body, one face kit, one arm kit. Every state differs from idle and
no two states wear the same face (checked in-script, same rule as the app's
frames.test.ts, shifted to the 32px face rows).

Run from scripts/mascot:  python states32.py   ->  states32-faces.png
"""
import draft32 as d
import draft32_d as base
from PIL import Image, ImageDraw

W = H = 32
# His palette, measured off darius-sprite.png: near-black fill, grey outline,
# vivid orange, beige horn nubs, plus our expression keys (pink cheeks,
# steel, yellow, blue).
PAL = dict(base.GEM_PAL, y='#f1c40f', b='#2980b9', r='#FF9999',
           n='#fbb060', s='#7f8c8d')
PAL['k'] = '#191919'
PAL['R'] = '#424242'
ORANGE = '#ed8622'

from traced_body import FACE_ROWS, FACE_KEY_ROWS, outline


def fresh():
    """His body, face zone ready. The patch and outline stay traced; only
    features get redrawn, and row 12 is cleared first (the trace has melted
    eye remnants there). Outline stays baked everywhere except hand-drawn
    limbs, which call outline() themselves."""
    import traced_body
    g = traced_body.build()
    g.row(12, 11, 13, 'o')
    g.row(12, 17, 19, 'o')
    return g


def translate(g, dy):
    out = d.Grid(W, H)
    for y in range(H):
        for x in range(W):
            c = g.cells[y][x]
            if c != '.':
                out.set(x, y + dy, c)
    return out


# ---- face kit ---------------------------------------------------------------
# His eyes are big dots: 3 wide, 2 tall, glint top-left. The whole kit keys
# off these two rectangles; move them and every expression follows.
EYE_L, EYE_R, EYE_Y = 11, 17, 10


def e_open(g, x0=None):
    for x in (EYE_L, EYE_R):
        g.rect(x, EYE_Y, x + 2, EYE_Y + 1, 'e')
        g.set(x, EYE_Y, 'w')


def e_blink(g):
    g.row(11, 11, 13, 'e')
    g.row(11, 17, 19, 'e')


def e_happy(g):
    g.row(10, 11, 13, 'e')
    g.row(10, 17, 19, 'e')


def e_sleep(g):
    g.row(10, 11, 14, 'w')
    g.row(10, 17, 20, 'w')


def e_calm(g):
    g.row(11, 11, 13, 'e')
    g.row(11, 17, 19, 'e')


def e_wide(g):
    for x0 in (10, 17):
        g.rect(x0, 9, x0 + 3, 11, 'w')
        g.rect(x0 + 1, 10, x0 + 2, 11, 'e')


def e_look(g, side):
    for x0 in (10, 17):
        g.rect(x0, 10, x0 + 3, 11, 'w')
    for x0 in (10, 17):
        g.set(x0 + (0 if side == 'L' else 3), 10, 'e')
        g.set(x0 + (0 if side == 'L' else 3), 11, 'e')


def e_down(g):
    for x0 in (11, 17):
        g.rect(x0, 11, x0 + 2, 12, 'e')
        g.set(x0, 12, 'w')


def e_dizzy(g):
    for x0 in (11, 17):
        for dx, dy in ((0, 0), (1, 1), (2, 2), (2, 0), (0, 2)):
            g.set(x0 + dx, 10 + dy, 'e')


def e_shades(g):
    g.rect(10, 9, 21, 10, 'e')
    g.set(12, 9, 'w')
    g.set(19, 9, 'w')


def e_goggles(g, shine=12):
    g.rect(11, 9, 20, 10, 'e')
    g.set(shine, 9, 'w')
    g.set(shine + 6, 10, 'w')


def e_brows(g):
    e_open(g)
    for x0 in (12, 18):
        g.set(x0, 9, 'e')
        g.set(x0 + 1, 9, 'e')


def m_smile(g, x0=14, x1=17):
    g.row(13, x0, x1, 'e')
    g.set(x0 - 1, 12, 'e')
    g.set(x1 + 1, 12, 'e')


def m_fangs(g):
    g.set(13, 12, 'w')
    g.set(18, 12, 'w')


def m_grin(g):
    g.row(13, 14, 17, 'e')
    g.row(14, 14, 17, 'w')


def m_open(g):
    g.row(12, 14, 17, 'e')
    g.row(13, 14, 17, 'e')
    g.row(14, 15, 16, 'e')
    g.row(13, 15, 16, 'e')


def m_small_o(g):
    g.rect(15, 12, 16, 13, 'e')


def m_smirk(g):
    g.row(13, 15, 18, 'e')


def m_wavy(g):
    for x, y in ((14, 13), (15, 12), (16, 13), (17, 12)):
        g.set(x, y, 'e')


def m_blush(g):
    for x, y in ((10, 12), (11, 12), (20, 12), (21, 12)):
        g.set(x, y, 'r')


# ---- arm kit ------------------------------------------------------------------
def clear_hanging(g, side):
    xs = range(3, 6) if side == 'L' else range(26, 29)
    for x in xs:
        for y in range(14, 25):
            g.set(x, y, '.')


def arm_up(g, side):
    clear_hanging(g, side)
    xs = (27, 28) if side == 'R' else (3, 4)
    for x in xs:
        for y in range(6, 15):
            if g.cells[y][x] == '.':
                g.set(x, y, 'k')
    g.rect(xs[0], 4, xs[1], 5, 'o')
    outline(g)


def arm_tip_wave(g, side, alt):
    xs = (27, 28) if side == 'R' else (3, 4)
    g.set(xs[0], 4 - alt, 'o')
    g.set(xs[1], 4, 'o')


def arm_out(g, reach):
    clear_hanging(g, 'L')
    clear_hanging(g, 'R')
    for x in range(3 - reach, 4):
        g.set(x, 16, 'k')
        g.set(31 - x, 16, 'k')
    for x in (3 - reach, 28 + reach):
        g.set(x, 15, 'o')
        g.set(x, 16, 'o')
    outline(g)


def arm_forward(g):
    clear_hanging(g, 'L')
    clear_hanging(g, 'R')
    for x, y in ((13, 22), (14, 22), (17, 22), (18, 22)):
        g.set(x, y, 'k')


def phone(g):
    g.rect(23, 8, 25, 12, 'e')
    g.set(24, 7, 'e')


def controller(g, alt=0):
    g.rect(13, 20, 18, 22, 'b')
    g.set(14 + alt, 21, 'y')
    g.set(17, 21, 'w')


def sparkles(g, pts):
    for x, y, c in pts:
        g.set(x, y, c)


# ---- states ---------------------------------------------------------------------
def st_idle():
    a = fresh()
    e_open(a)
    m_smile(a)
    m_fangs(a)
    m_blush(a)
    b = fresh()
    e_blink(b)
    m_smile(b)
    m_fangs(b)
    m_blush(b)
    return [a, a, b, a]


def st_typing():
    g = fresh()
    e_open(g)
    g.row(13, 14, 17, 'e')
    return [g]


def st_thinking():
    l, r = fresh(), fresh()
    e_look(l, 'L')
    m_smile(l)
    e_look(r, 'R')
    m_smile(r)
    return [l, r]


def st_calling():
    a, b = fresh(), fresh()
    for g in (a, b):
        phone(g)
        e_open(g)
    m_open(a)
    m_smile(b)
    return [a, b]


def st_done():
    g = fresh()
    e_happy(g)
    m_open(g)
    return [g]


def st_done_thumb():
    """Second done pose: thumbs up, off the spec sheet's Interaction frame."""
    g = fresh()
    arm_up(g, 'R')
    g.set(27, 3, 'o')
    g.set(28, 3, 'o')
    e_happy(g)
    m_open(g)
    return [g]


def st_running():
    out = []
    for shift, lift in ((0, 0), (2, -1)):
        g = fresh()
        if lift:
            g = translate(g, lift)
        for x in range(6, 26):
            for y in (29, 30, 31):
                g.set(x, y, '.')
        f1 = (7 + shift, 29, 11 + shift, 31)
        f2 = (20 - shift, 28 + lift, 24 - shift, 30 + lift)
        g.rect(*f1, 'k')
        g.rect(*f2, 'k')
        e_brows(g)
        m_smile(g)
        out.append(g)
    return out


def st_wave():
    out = []
    for alt in (0, 1, 0, -1):
        g = fresh()
        arm_up(g, 'R')
        arm_tip_wave(g, 'R', alt)
        e_open(g)
        m_open(g)
        out.append(g)
    return out


def st_sleep():
    a = fresh()
    e_sleep(a)
    g = fresh()
    g.row(13, 14, 17, 'e')
    b = translate(g, 1)
    e_sleep(b)
    return [a, a, a, b, b, a]


def st_surprised():
    g = fresh()
    e_wide(g)
    m_small_o(g)
    return [g]


def st_curious():
    out = []
    for dx in (0, 1, 0, -1):
        g = fresh()
        for x0 in (12 + dx, 18 + dx):
            g.rect(x0, 10, x0 + 1, 11, 'e')
            g.set(x0, 10, 'w')
        g.row(13, 14 + dx, 17 + dx, 'e')
        out.append(g)
    return out


def st_celebrate():
    g = fresh()
    arm_up(g, 'L')
    arm_up(g, 'R')
    e_happy(g)
    m_open(g)
    g.row(12, 13, 18, 'e')
    h = translate(g, -2)
    return [g, h]


def st_reading():
    a, b = fresh(), fresh()
    for g in (a, b):
        e_down(g)
        g.row(13, 14, 17, 'e')
    c = fresh()
    e_blink(c)
    c.row(13, 14, 17, 'e')
    return [a, a, c]


def st_searching():
    a, b = fresh(), fresh()
    for g, s in ((a, 12), (b, 14)):
        e_goggles(g, s)
        g.row(13, 14, 17, 'e')
    return [a, b]


def st_building():
    g = fresh()
    e_brows(g)
    g.row(13, 14, 17, 'e')
    return [g]


def st_building_hat():
    """Second building pose: the crab's hard hat and wrench, on our body.

    Held props live in the frame (a paw genuinely holds them), standing props
    live in scenes. The hat brim covers the horns' inner cells; the horns poke
    out from under it, the way ears do under a real helmet.
    """
    g = fresh()
    e_brows(g)
    g.row(13, 14, 17, 'e')
    g.row(0, 13, 18, 'y')
    g.row(1, 12, 19, 'y')
    g.row(2, 11, 20, 'y')
    g.set(11, 2, 'n')
    g.set(20, 2, 'n')
    g.row(3, 10, 21, 'y')
    for x in range(25, 28):
        g.set(x, 12, 's')
        g.set(x, 14, 's')
    g.set(25, 13, 's')
    g.set(27, 13, 's')
    g.rect(26, 15, 27, 19, 's')
    g.set(27, 16, 'w')
    for x, y in ((25, 17), (26, 17), (25, 18), (26, 18)):
        g.set(x, y, 'k')
    return [g]


def st_writing_pencil():
    """Second writing pose: a pencil in the paw. Same honest rule as the
    wrench -- if the paw does not cover the handle, it is not holding it."""
    g = fresh()
    m_grin(g)
    e_open(g)
    g.rect(25, 13, 26, 19, 'y')
    g.set(25, 20, 'n')
    g.set(26, 20, 'n')
    g.set(26, 21, 'e')
    for x, y in ((25, 15), (26, 15), (25, 16), (26, 16)):
        g.set(x, y, 'k')
    return [g]


def st_writing():
    a, b = fresh(), fresh()
    m_grin(a)
    e_open(a)
    arm_forward(a)
    m_grin(b)
    e_open(b)
    arm_forward(b)
    for x in range(11, 13):
        b.set(x, 20, '.')
    return [a, b]


def st_stretching():
    out = []
    for reach in (0, 1, 2):
        g = fresh()
        arm_out(g, reach)
        e_open(g)
        m_smile(g)
        out.append(g)
    return out


def st_gaming():
    a, b = fresh(), fresh()
    for g, alt in ((a, 0), (b, 1)):
        e_brows(g)
        m_smile(g)
        arm_forward(g)
        controller(g, alt)
    return [a, b]


def st_love():
    a = fresh()
    e_open(a)
    m_open(a)
    m_blush(a)
    b = fresh()
    e_happy(b)
    m_open(b)
    m_blush(b)
    return [a, b]


def st_cool():
    g = fresh()
    e_shades(g)
    m_smirk(g)
    return [g]


def st_error():
    g = fresh()
    e_dizzy(g)
    m_wavy(g)
    return [g]


def st_error_angry():
    """Second error face: mad, not dizzy. Failure has two moods and the app
    can only report one state, so they take turns."""
    g = fresh()
    e_brows(g)
    g.row(13, 14, 17, 'e')
    g.set(13, 14, 'e')
    g.set(18, 14, 'e')
    return [g]


def st_thinking_sad():
    """Second thinking face: stuck, not pondering. A sad thinker reads as
    confused, which is honest for a long silent run."""
    g = fresh()
    e_down(g)
    g.row(13, 14, 17, 'e')
    g.set(13, 14, 'e')
    g.set(18, 14, 'e')
    g.set(11, 12, 'b')
    return [g]


def st_excited():
    a, b = fresh(), fresh()
    for g in (a, b):
        e_wide(g)
        m_open(g)
    arm_up(a, 'L')
    arm_up(a, 'R')
    return [a, b]


def st_spawning():
    a = fresh()
    e_sleep(a)
    sparkles(a, [(8, 6, 'y'), (23, 5, 'w'), (25, 12, 'y'), (6, 14, 'w')])
    b = fresh()
    e_blink(b)
    m_smile(b)
    sparkles(b, [(9, 7, 'y'), (23, 6, 'w')])
    c = fresh()
    e_open(c)
    m_smile(c)
    m_fangs(c)
    return [a, b, c]


def st_meditating():
    a = fresh()
    e_calm(a)
    a.row(13, 14, 17, 'e')
    b = translate(a, -1)
    return [a, b]


STATES = {
    'idle': st_idle, 'typing': st_typing, 'thinking': st_thinking,
    'calling': st_calling, 'done': st_done, 'running': st_running,
    'wave': st_wave, 'sleep': st_sleep, 'surprised': st_surprised,
    'curious': st_curious, 'celebrate': st_celebrate, 'reading': st_reading,
    'searching': st_searching, 'building': st_building, 'writing': st_writing,
    'stretching': st_stretching, 'gaming': st_gaming, 'love': st_love,
    'cool': st_cool, 'error': st_error, 'excited': st_excited,
    'spawning': st_spawning, 'meditating': st_meditating,
}

# Second poses. Same body, different reading: a state that can say two true
# things takes turns saying them (the renderer picks at random on entry).
STATES_EXTRA = {
    'thinking': [st_thinking_sad],
    'building': [st_building_hat],
    'writing': [st_writing_pencil],
    'error': [st_error_angry],
    'done': [st_done_thumb],
}


def all_groups():
    """Every variant group, base first: {state: [[Grid, ...], ...]}."""
    out = {}
    for name, fn in STATES.items():
        out[name] = [fn()]
    for name, fns in STATES_EXTRA.items():
        for fn in fns:
            out[name].append(fn())
    return out


def face_key(grids):
    keys = set()
    for g in grids:
        rows = g.rows() if hasattr(g, 'rows') else g
        keys.add('|'.join(rows[r] for r in FACE_KEY_ROWS))
    return '//'.join(sorted(keys))


def check():
    # Mirrors frames.test.ts: the worn set is every face across every variant
    # of the state, so a second pose can never silently twin another state.
    groups = all_groups()
    seen = {}
    idle_key = face_key([g.rows() for grp in groups['idle'] for g in grp])
    for name, variants in groups.items():
        worn = set()
        for grp in variants:
            frames = [g.rows() for g in grp]
            for f in frames:
                assert len(f) == 32 and all(len(r) == 32 for r in f), name
                for r in f:
                    for ch in r:
                        assert ch in PAL or ch in ('.', 'o'), (name, ch)
            worn.add(face_key(frames))
        key = '//'.join(sorted(worn))
        if name != 'idle':
            assert key != idle_key, '%s matches idle' % name
        assert key not in seen.values(), '%s twins %s' % (
            name, [k for k, v in seen.items() if v == key])
        seen[name] = key
    print('faces: 23 states, all distinct, none idle. ok')


def sheet(scale=8):
    names = list(STATES)
    cell = 32 * scale
    cols = 6
    label_h = 14
    rows_n = (len(names) + cols - 1) // cols
    sheet_w = cols * (4 * cell + 24)
    sheet_h = rows_n * (cell + label_h + 16)
    img = Image.new('RGB', (sheet_w, sheet_h), d.rgb('#1C1916'))
    px = ImageDraw.Draw(img)
    for i, name in enumerate(names):
        frames = STATES[name]()[:4]
        cx = (i % cols) * (4 * cell + 24) + 12
        cy = (i // cols) * (cell + label_h + 16) + label_h + 8
        for j, g in enumerate(frames):
            base.render_rows(g.rows(), '_cell.png', PAL, ORANGE, scale)
            img.paste(Image.open('_cell.png'), (cx + j * (cell + 4), cy))
        px.text((cx, cy - label_h), name, fill='#888888')
    img.save('states32-faces.png')
    print('states32-faces.png ok')


if __name__ == '__main__':
    check()
    sheet()
