"""The mascot's seven poses, traced from the character art into SVG paths.

Reads the flat poses of docs/design/moodboard/SVG/ (the seven PNGs Darius drew,
1254x1254, transparent) and writes
  frontend-react/src/components/chat/mascot/scenes.ts
one scene per pose: a path per colour layer (the main orange, the lighter
orange of the lit parts, the crease tone, the cream face window, the eyes), the
parts that move on their own (tail, a waving arm, the paws on the keys) cut out
with a margin of body under them, the small marks drawn beside the creature
(action lines, the Zzz) and, for the laptop pose, the laptop.

Every pose is scaled so its face window has the same area, which puts the head at
one size whatever the pose, and placed with its lowest point at y=110.5 of the
128x132 drawing (the soles line the composer perch sits the creature on).

Run from the repo root, in an environment with numpy and scikit-image:
  python scripts/mascot/svg/trace_poses.py [path/to/moodboard/SVG]
"""
import os
import sys

import numpy as np
from skimage import filters, io, measure, morphology
from skimage.draw import polygon as draw_polygon

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'design', 'moodboard', 'SVG')
DST = os.path.join(ROOT, 'frontend-react', 'src', 'components', 'chat', 'mascot', 'scenes.ts')

# The face window of every pose becomes this many units across (sqrt of its area).
FACE_UNITS = 34.0
GROUND = 110.5

# Regions are polygons in the source image's pixels. A part is the silhouette
# inside its region (grown by `margin`, so a small rotation never opens a gap);
# the body is the silhouette outside it. `pivot` is where the part turns.
POSES = {
    'wave': dict(file='120983f8-4253-4c8c-b93c-edf4e67f9b17', anchor='feet', parts={
        'tail': dict(region=[(250, 815), (392, 815), (400, 1000), (470, 1030), (250, 1035)], margin=14, pivot=(392, 950)),
        'arm': dict(region=[(930, 540), (1110, 540), (1110, 765), (1010, 765), (962, 738), (930, 690), (936, 640)], margin=16, pivot=(972, 745)),
    }),
    'laptop': dict(file='24aa624f-b0f1-4afc-aa90-bd7fbc9fa2d4', anchor='fixed', fixed=(0.106, 70, 4.5, 1015, 111), parts={
        'tail': dict(region=[(30, 540), (320, 540), (320, 688), (258, 700), (132, 820), (30, 820)], margin=14, pivot=(195, 760)),
        'pawL': dict(region=[(378, 873), (692, 873), (706, 900), (712, 940), (700, 1040), (378, 1040)], margin=3, pivot=(400, 930)),
        'pawR': dict(region=[(692, 873), (800, 873), (800, 1040), (700, 1040), (712, 940), (706, 900)], margin=3, pivot=(690, 920)),
    }),
    'sleep': dict(file='2623978d-2d5b-432a-be12-d6b30986ab21', anchor='bbox', parts={
        'tail': dict(region=[(90, 590), (262, 590), (262, 700), (215, 835), (90, 835)], margin=14, pivot=(230, 760)),
    }),
    'surprised': dict(file='3fbfcb9f-c4c6-44eb-9b35-faaeaa59736f', anchor='feet', parts={
        'tail': dict(region=[(290, 835), (452, 835), (463, 900), (456, 1015), (290, 1015)], margin=14, pivot=(456, 950)),
    }),
    'think': dict(file='8dedb715-7d01-4ee7-b26d-1ff3ecc308cc', anchor='feet', parts={
        'tail': dict(region=[(285, 835), (420, 835), (436, 905), (404, 1040), (285, 1040)], margin=14, pivot=(422, 970)),
    }),
    'sit': dict(file='9cdaea19-4b81-4486-b210-82869a46460c', anchor='feet', parts={
        'tail': dict(region=[(255, 800), (500, 800), (492, 815), (396, 1078), (255, 1078)], margin=14, pivot=(444, 950)),
    }),
    'cheer': dict(file='e218d07c-9b9a-4a53-95ea-e28f32e5d7fb', anchor='feet', parts={
        'tail': dict(region=[(200, 885), (430, 885), (450, 935), (444, 940), (388, 1088), (200, 1088)], margin=14, pivot=(420, 1010)),
    }),
}


def disk(n):
    return morphology.disk(n)


def keep(mask, above):
    """Drop connected pieces smaller than `above` pixels (speckle in the art)."""
    lab = measure.label(mask)
    out = np.zeros_like(mask)
    for p in measure.regionprops(lab):
        if p.area > above:
            out[lab == p.label] = True
    return out


def region(pts, shape):
    m = np.zeros(shape, bool)
    rr, cc = draw_polygon([p[1] for p in pts], [p[0] for p in pts], shape)
    m[rr, cc] = True
    return m


def trace_pose(name, spec):
    im = io.imread(os.path.join(SRC, spec['file'] + '.png')).astype(int)
    r, g, b, a = im[..., 0], im[..., 1], im[..., 2], im[..., 3]
    shape = a.shape
    opaque = a >= 128

    dark = opaque & (r < 90) & (g < 90) & (b < 90)
    cream = opaque & (r > 215) & (g > 190) & (b > 165) & ((r - b) < 70)
    grey = opaque & ~dark & ~cream & (abs(r - g) < 50) & (abs(g - b) < 50)
    warm = opaque & ~dark & ~cream & ~grey

    laptop = keep(grey, 20000)
    laptop |= grey & morphology.dilation(laptop, disk(30))  # its loose edge bits
    laptop_filled = morphology.remove_small_holes(laptop | (cream & morphology.dilation(laptop, disk(3))), max_size=20000)
    creams = keep(cream & ~laptop_filled, 5000)
    # The face window is the biggest cream shape; the rest (the belly) is cream too.
    cream_parts = sorted(measure.regionprops(measure.label(creams)), key=lambda p: -p.area)
    face_only = measure.label(creams) == cream_parts[0].label
    face_filled = morphology.remove_small_holes(face_only, max_size=10 ** 6)
    face_box = cream_parts[0].bbox  # (y0, x0, y1, x1)

    # The creature: every big warm piece (horns can stand apart behind a thin
    # gap), with the cream and the eyes it holds. Small warm pieces are marks.
    body = keep(warm, 8000)
    # An eye is a dark shape centred inside the face window's box (one can
    # touch the laptop lid, which breaks the window's outline around it).
    fy0, fx0, fy1, fx1 = face_box
    dark_lab = measure.label(keep(dark, 400))
    eyes = np.zeros(shape, bool)
    for p in measure.regionprops(dark_lab):
        cy, cx = p.centroid
        if fy0 <= cy <= fy1 and fx0 <= cx <= fx1:
            eyes |= dark_lab == p.label
    face_mask = creams
    creature = morphology.remove_small_holes(body | face_mask | eyes, max_size=3000)
    marks = keep((warm & ~body) | ((dark | grey) & ~eyes & ~laptop & ~morphology.dilation(creature, disk(4))), 150)

    # Tones, read against this image's own orange after the paper grain is
    # smoothed away: lighter (the lit horns, tail, limbs), a thin mid-dark
    # outline (around hands and limbs) and the deep shadow (under the head).
    sm = np.stack([filters.gaussian(im[..., i].astype(float), sigma=1.5, preserve_range=True) for i in range(3)], -1)
    inside = warm & creature
    main = np.median(im[inside & morphology.erosion(creature, disk(6))][:, :3], axis=0)
    dg = sm[..., 1] - main[1]
    dr = sm[..., 0] - main[0]
    light = keep(morphology.opening(inside & (dg >= 6) & (dr >= 2), disk(2)), 1500)
    shadow = keep(morphology.opening(inside & (dg <= -22), disk(1)), 120)
    outline = keep(morphology.opening(inside & (dg <= -9) & ~shadow, disk(1)), 120)
    tone = lambda m: '#%02X%02X%02X' % tuple(im[m][:, :3].mean(0).astype(int)) if m.any() else None

    # Placement: one head size for every pose, the lowest point on the ground.
    if spec['anchor'] == 'fixed':
        s, x_ref, x_to, y_ref, y_to = spec['fixed']
        tx, ty = x_to - x_ref * s, y_to - y_ref * s
    else:
        s = FACE_UNITS / np.sqrt(face_only.sum())
        ys, xs = np.nonzero(creature | laptop)
        bottom = ys.max()
        if spec['anchor'] == 'feet':
            low = creature & (np.arange(shape[0])[:, None] > bottom - 0.08 * (bottom - ys.min()))
            cx = np.nonzero(low)[1].mean()
        else:
            cx = (xs.min() + xs.max()) / 2
        tx, ty = 64 - cx * s, GROUND - bottom * s
    X = lambda x: x * s + tx
    Y = lambda y: y * s + ty

    def trace(mask, tol=1.6, sigma=1.4):
        f = filters.gaussian(np.pad(mask.astype(float), 2), sigma=sigma)
        out = []
        for c in measure.find_contours(f, 0.5):
            if len(c) < 10:
                continue
            c = measure.approximate_polygon(c, tolerance=tol)
            pts = [(X(p[1] - 2), Y(p[0] - 2)) for p in c]
            out.append('M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts) + 'Z')
        return ''.join(out)

    sil = morphology.dilation(creature, disk(2))
    grow = lambda m, n: morphology.dilation(m, disk(n)) if n else m
    rest = np.ones(shape, bool)
    parts = {}
    for pname, p in spec['parts'].items():
        reg = region(p['region'], shape)
        rest &= ~reg
        wide = grow(reg, p['margin'])
        parts[pname] = dict(
            sil=trace(sil & wide), light=trace(light & wide),
            outline=trace(outline & wide, tol=1.0, sigma=0.9), shadow=trace(shadow & wide),
            pivot=(round(X(p['pivot'][0]), 1), round(Y(p['pivot'][1]), 1)),
        )

    eye_list = []
    for p in sorted(measure.regionprops(measure.label(eyes)), key=lambda p: p.centroid[1]):
        y0, x0, y1, x1 = p.bbox
        eye_list.append(dict(
            d=trace(measure.label(eyes) == p.label, tol=0.8),
            at=(round(X(p.centroid[1]), 1), round(Y(p.centroid[0]), 1)),
            rx=round((x1 - x0) * s / 2, 1), ry=round((y1 - y0) * s / 2, 1),
        ))

    mark_list = []
    for p in sorted(measure.regionprops(measure.label(marks)), key=lambda p: p.centroid[1]):
        m = measure.label(marks) == p.label
        col = im[m][:, :3].mean(0).astype(int)
        mark_list.append(dict(d=trace(m, tol=0.8), color='#%02X%02X%02X' % tuple(col)))

    scene = dict(
        base=dict(sil=trace(sil & rest), light=trace(light & rest),
                  outline=trace(outline & rest, tol=1.0, sigma=0.9), shadow=trace(shadow & rest)),
        colors=dict(main='#%02X%02X%02X' % tuple(main.astype(int)), light=tone(light) or '', outline=tone(outline) or '',
                    shadow=tone(shadow) or '', cream=tone(face_only), eye=tone(eyes)),
        parts=parts,
        face=trace(face_mask),
        faceBox=(round(X(fx0), 1), round(Y(fy0), 1), round(X(fx1), 1), round(Y(fy1), 1)),
        eyes=eye_list,
        marks=mark_list,
        # The source image maps onto the drawing as x*scale+x0, y*scale+y0:
        # what the overlay check lays the artwork under the trace with.
        place=(round(float(s), 5), round(float(tx), 2), round(float(ty), 2)),
    )
    if laptop.any():
        logo = keep(cream & laptop_filled & ~laptop, 200)
        base = grey & (r <= 150)
        lid = grey & (r > 150)
        scene['laptop'] = dict(lid=trace(grow(lid, 1) & ~logo), base=trace(grow(base, 1)), logo=trace(logo))
    return scene


def num(x):
    x = float(x)
    # Coordinates need one decimal; a scale factor needs all of its.
    return str(round(x, 5)) if abs(x) < 1 else str(round(x, 1))


def ts(v, ind=''):
    """A small JSON-ish printer that keeps paths on one line each."""
    if isinstance(v, dict):
        inner = ',\n'.join(f"{ind}  {k}: {ts(x, ind + '  ')}" for k, x in v.items())
        return '{\n' + inner + f',\n{ind}}}'
    if isinstance(v, (list, tuple)):
        if all(isinstance(x, (int, float, np.floating, np.integer)) for x in v):
            return '[' + ', '.join(num(x) for x in v) + ']'
        return '[\n' + ',\n'.join(f'{ind}  {ts(x, ind + "  ")}' for x in v) + f',\n{ind}]'
    if isinstance(v, str):
        return "'" + v + "'"
    return num(v)


def main():
    scenes = {name: trace_pose(name, spec) for name, spec in POSES.items()}
    with open(DST, 'w') as f:
        f.write('// GENERATED by scripts/mascot/svg/trace_poses.py from the flat poses in\n')
        f.write('// docs/design/moodboard/SVG/. Do not edit; change the script and regenerate.\n\n')
        f.write("export interface Layers { sil: string; light: string; outline: string; shadow: string }\n")
        f.write("export interface Part extends Layers { pivot: readonly [number, number] }\n")
        f.write("export interface Scene {\n  base: Layers;\n")
        f.write("  /** The tones measured in this pose's artwork. */\n")
        f.write("  colors: { main: string; light: string; outline: string; shadow: string; cream: string; eye: string };\n")
        f.write("  parts: { tail?: Part; arm?: Part; pawL?: Part; pawR?: Part };\n  face: string;\n")
        f.write("  /** The face window's box: x0, y0, x1, y1. */\n  faceBox: readonly [number, number, number, number];\n")
        f.write("  eyes: { d: string; at: readonly [number, number]; rx: number; ry: number }[];\n")
        f.write("  marks: { d: string; color: string }[];\n  laptop?: { lid: string; base: string; logo: string };\n")
        f.write("  /** Source image to drawing: x * scale + x0, y * scale + y0. */\n  place: readonly [number, number, number];\n}\n\n")
        f.write('export type SceneName = ' + ' | '.join(f"'{n}'" for n in scenes) + ';\n\n')
        f.write('export const SCENES: Record<SceneName, Scene> = ' + ts(scenes) + ';\n')
    print('wrote', DST, os.path.getsize(DST), 'bytes')


if __name__ == '__main__':
    main()
