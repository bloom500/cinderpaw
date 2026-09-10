"""Split each reference illustration into CREATURE and SCENE.

The pack draws one body and puts everything else around it. That is the whole
finding, and it means the props can be lifted out mechanically: find the
creature, subtract it, and what remains is the prop with coordinates relative
to the body it was drawn beside.
"""
import io, json, collections

BODY = '#d97757'
INK = '#2f2f38'

ref = json.loads(io.open('refpack.json', encoding='utf-8').read())


def creature_cells(v):
    """Largest connected run of body colour, plus any ink inside its box."""
    idx = {c: i for i, c in enumerate(v['colors'])}
    if BODY not in idx:
        return None
    b = '%x' % idx[BODY]
    rows = v['rows']
    H, W = len(rows), len(rows[0])
    seen = set()
    best = set()
    for r in range(H):
        for c in range(W):
            if rows[r][c] != b or (r, c) in seen:
                continue
            comp, stack = set(), [(r, c)]
            seen.add((r, c))
            while stack:
                y, x = stack.pop()
                comp.add((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and (ny, nx) not in seen and rows[ny][nx] == b:
                        seen.add((ny, nx))
                        stack.append((ny, nx))
            if len(comp) > len(best):
                best = comp
    return best


WHITES = {'#fff', '#ffffff', '#fefefe'}


def strip_leftovers(cells, box):
    """Remove what is left of THEIR character after the body is subtracted.

    Subtracting the largest run of body colour finds one creature. The sheets
    have more than one: a second character standing beside the first, a paw, a
    tail, and -- in every single illustration -- the white eyes and mouth, which
    survive because they are drawn as separate specks and not in body colour.

    Rendered next to OUR creature those fragments are unmistakable: a row of six
    little bodies over the composer, a face floating in the middle of a prop, a
    small white smile hanging beside our own. So:

    - every pixel of body colour goes, not only the largest blob. That colour IS
      their character; nothing else in the pack is drawn in it.
    - white in runs shorter than six cells goes, but ONLY where a face can be:
      inside the creature's own box, or right beside a patch of body colour
      that was just removed, which is where a SECOND character's face was.

    Anywhere else, small white is a prop and stays. The first version of this
    rule stripped every short white run, and it ate the rays of
    `in-glowing-aura` -- the one illustration in the pack that is a creature
    glowing, and the reason there is a `meditating` state at all.

    Coloured specks are left alone. Sparkles, confetti and light rays are small
    on purpose, and they are props.
    """
    r0, r1, c0, c1 = box
    theirs = {(r, c) for r, c, col in cells if col == BODY}
    near_theirs = {(r + dy, c + dx) for r, c in theirs
                   for dy in (-2, -1, 0, 1, 2) for dx in (-2, -1, 0, 1, 2)}
    keep = [c for c in cells if c[2] != BODY]
    white = {(r, c) for r, c, col in keep if col.lower() in WHITES}
    doomed, seen = set(), set()
    for cell in white:
        if cell in seen:
            continue
        comp, stack = set(), [cell]
        seen.add(cell)
        while stack:
            y, x = stack.pop()
            comp.add((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    n = (y + dy, x + dx)
                    if n in white and n not in seen:
                        seen.add(n)
                        stack.append(n)
        if len(comp) >= 6:
            continue
        in_box = all(r0 <= r <= r1 and c0 <= c <= c1 for r, c in comp)
        if in_box or (comp & near_theirs):
            doomed |= comp
    return [c for c in keep if (c[0], c[1]) not in doomed]


out = {}
for name, v in ref.items():
    body = creature_cells(v)
    if not body or len(body) < 40:
        continue
    r0 = min(r for r, _ in body); r1 = max(r for r, _ in body)
    c0 = min(c for _, c in body); c1 = max(c for _, c in body)
    # Ink inside the body box is the face, not a prop.
    idx = {c: i for i, c in enumerate(v['colors'])}
    ink = ('%x' % idx[INK]) if INK in idx else None
    scene = []
    for r, row in enumerate(v['rows']):
        for c, ch in enumerate(row):
            if ch == '.' or (r, c) in body:
                continue
            if ink and ch == ink and r0 <= r <= r1 and c0 <= c <= c1:
                continue
            scene.append([r - r0, c - c0, v['colors'][int(ch, 16)]])
    scene = strip_leftovers(scene, (0, r1 - r0, 0, c1 - c0))
    out[name] = {
        'body': [c1 - c0 + 1, r1 - r0 + 1],
        'bodyCells': len(body),
        'scene': scene,
    }

io.open('props.json', 'w', encoding='utf-8').write(json.dumps(out, separators=(',', ':')))

sizes = sorted(out.items(), key=lambda kv: -len(kv[1]['scene']))
print('illustrations split: %d' % len(out))
print('body box, most common:', collections.Counter(tuple(v['body']) for v in out.values()).most_common(4))
print()
print('%-38s %-8s %s' % ('name', 'body', 'scene cells'))
for n, v in sizes[:14]:
    print('%-38s %-8s %d' % (n, '%dx%d' % tuple(v['body']), len(v['scene'])))
print('...')
for n, v in sizes[-5:]:
    print('%-38s %-8s %d' % (n, '%dx%d' % tuple(v['body']), len(v['scene'])))
