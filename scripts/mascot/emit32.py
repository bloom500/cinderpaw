"""Replace the 16x16 frames in frames.ts with the 32x32 set from states32.py.

One variant group per state: pose variety now comes from SCENES (drawn
independently around the body), which is the design scenes.ts documents.
FRAMES (variant[0] per state) keeps working untouched.

Run from scripts/mascot:  python emit32.py
"""
import io
import re

import states32

TS = '../../frontend-react/src/components/chat/mascot/frames.ts'


def main():
    src = io.open(TS, encoding='utf-8').read()

    names = list(states32.STATES)
    assert len(names) == 23, names

    consts, variants = [], {}
    for state in names:
        frames = [g.rows() for g in states32.STATES[state]()]
        group = []
        for i, f in enumerate(frames):
            assert len(f) == 32 and all(len(r) == 32 for r in f), (state, i)
            cname = 'F32_%s_%d' % (state.upper(), i)
            group.append(cname)
            consts.append('const %s: Frame = [\n%s\n];' % (
                cname, '\n'.join("  '%s'," % r for r in f)))
        variants[state] = group

    # 1. dimensions + palette. `d` (fur shadow) is new: every 32px frame uses
    # it, and frames.test.ts requires every char to be a known key.
    src = src.replace('export const FRAME_W = 16;', 'export const FRAME_W = 32;')
    src = src.replace('export const FRAME_H = 16;', 'export const FRAME_H = 32;')
    src = src.replace("const MASCOT_ORANGE = '#cf7740';",
                      "const MASCOT_ORANGE = '#f2822c';")
    src = src.replace("  k: '#584c42', e: '#1c1c1e',",
                      "  k: '#4a4b53', e: '#1c1c1e',")
    src = src.replace("  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',",
                      "  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',\n"
                      "  d: '#31323a',")

    # 2. swap every 16x16 frame const for the 32px set.
    bodies, n = re.subn(r"const \w+: Frame = \[.*?\];", '', src, flags=re.S)
    print('removed %d old frame consts' % n)
    assert n >= 100, n

    # 3. fresh VARIANTS. FRAMES (variant[0] each) below it keeps working.
    m = re.search(r"export const VARIANTS: Record<MascotState, Frame\[\]\[\]> = \{.*?\n\};",
                  bodies, re.S)
    assert m, 'VARIANTS block not found'
    lines = ['export const VARIANTS: Record<MascotState, Frame[][]> = {']
    for state in names:
        lines.append('  %s: [[%s]],' % (state.ljust(11), ','.join(variants[state])))
    lines.append('};')
    bodies = bodies[:m.start()] + '\n'.join(lines) + bodies[m.end():]

    # 4. the new consts go right before VARIANTS.
    anchor = 'export const VARIANTS'
    bodies = bodies.replace(anchor, '\n\n'.join(consts) + '\n\n' + anchor, 1)

    io.open(TS, 'w', encoding='utf-8', newline='\n').write(bodies)
    total = sum(len(v) for v in variants.values())
    print('frames.ts: %d frames across 23 states' % total)


if __name__ == '__main__':
    main()
