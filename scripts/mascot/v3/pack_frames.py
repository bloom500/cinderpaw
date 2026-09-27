"""Pack the rendered mascot loops into the app's sheet and frame index.

Reads frames/<anim>/NNN.png and frames/anchors.json (render_frames.py), draws each loop's marks
after the expression board (sparkles, ??, ..., !, Zzz) and writes, next to the renderer:
  frontend-react/src/components/chat/mascot/sheet.webp   every drawn frame, 16 per row
  frontend-react/src/components/chat/mascot/frames.ts    MascotState -> sheet index per tick

    python scripts/mascot/v3/pack_frames.py
"""
import json
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SRC = os.path.join(HERE, "frames")
DST = os.path.join(ROOT, "frontend-react", "src", "components", "chat", "mascot")
COLS = 16
TICK_FPS = 24        # the renderer's clock: a 12 fps loop holds each frame 2 ticks, 8 fps 3, 6 fps 4
SS = 4               # marks are drawn 4x and scaled down, so their edges are smooth
# Ember, not the board's charcoal: a dark mark vanishes on the dark theme (the v2 lesson).
MARK = (198, 90, 46)

# App state -> the loop it plays. Eight loops after the expression board stand in for the
# 29 states the app already tracks (useMascotState); the state hook is unchanged.
STATES = {
    "idle": "idle", "typing": "focused", "thinking": "thinking", "calling": "focused", "done": "happy",
    "running": "focused", "wave": "waving", "sleep": "sleepy", "surprised": "surprised", "curious": "curious",
    "celebrate": "happy", "reading": "focused", "searching": "curious", "building": "focused",
    "writing": "focused", "stretching": "idle", "gaming": "focused", "love": "happy", "cool": "idle",
    "error": "surprised", "excited": "happy", "spawning": "waving", "asking": "curious", "waiting": "idle",
    "speaking": "idle", "listening": "curious", "blocked": "thinking", "scheduling": "thinking",
    "storing": "thinking",
}


class Pen:
    """Round-capped strokes in frame pixels, drawn on a 4x overlay."""

    def __init__(self, size, u):
        self.im = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
        self.d, self.u = ImageDraw.Draw(self.im), u

    def dot(self, x, y, r, a=255):
        r *= self.u * SS
        self.d.ellipse((x * SS - r, y * SS - r, x * SS + r, y * SS + r), fill=MARK + (a,))

    def line(self, pts, w, a=255):
        self.d.line([(x * SS, y * SS) for x, y in pts], fill=MARK + (a,), width=round(w * self.u * SS), joint="curve")
        for x, y in (pts[0], pts[-1]):
            self.dot(x, y, w / 2, a)

    def rays(self, cx, cy, angles, r0, r1, w=4.5):
        """Short strokes pointing out from (cx, cy): the board's sparkle and alarm lines."""
        u = self.u
        for deg in angles:
            c, s = math.cos(math.radians(deg)), -math.sin(math.radians(deg))
            self.line([(cx + c * r0 * u, cy + s * r0 * u), (cx + c * r1 * u, cy + s * r1 * u)], w)

    def question(self, x, y, h, w=4.5):
        """A '?' h tall, its top-left at (x, y)."""
        u, r = self.u, 0.27 * h * self.u
        cx, cy = x + r, y + r
        pts = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(190, 421, 10)]
        pts.append((cx, cy + 1.9 * r))
        self.line(pts, w)
        self.dot(cx, y + h * u, w * 0.62)

    def zed(self, x, y, s, w=4, a=255):
        s *= self.u
        self.line([(x, y), (x + s, y), (x, y + s), (x + s, y + s)], w, a)


def marks(anim, t, head, hand, size):
    """The marks for one frame at phase t, or None. head = top of the head, hand = right hand.
    They sit above the head, where the frame has room: the head tops land at y 56-82 of 256 and
    anything past x ~246 is cut off."""
    u = size / 256
    pen = Pen(size, u)
    hx, hy = head
    if anim == "happy":
        f = 0.6 + 0.4 * abs(math.sin(2 * math.pi * t))           # pulses with the hops
        pen.rays(hx - 100 * u, hy + 40 * u, (145, 180, 215), 14, 14 + 11 * f)
        pen.rays(hx + 100 * u, hy + 40 * u, (35, 0, -35), 14, 14 + 11 * f)
    elif anim == "curious":
        bob = 3 * u * math.sin(2 * math.pi * t)
        pen.question(hx + 44 * u, hy - 56 * u + bob, 26)              # above the right horn's tip
        pen.question(hx + 68 * u, hy - 46 * u - bob, 20, 4)
    elif anim == "thinking":
        for k in range(3):                                       # the dots arrive one by one
            if t * 4 % 4 >= k + 1:
                pen.dot(hx - 16 * u + 16 * k * u, hy - 30 * u, 4.5)
    elif anim == "surprised":
        pen.rays(hx + 84 * u, hy - 14 * u, (20, 55, 90), 14, 26 if t < 0.5 else 22)
    elif anim == "sleepy":
        for k, s in enumerate((11, 15, 19)):                     # each z rises and fades, one after another
            p = (t + k / 3) % 1
            a = round(255 * math.sin(math.pi * p))
            pen.zed(hx + (20 + 14 * k) * u, hy - (20 + 20 * k) * u - 16 * p * u, s, 4, a)
    elif anim == "waving":
        hx2, hy2 = hand
        f = 0.5 + 0.5 * abs(math.sin(4 * math.pi * t))
        pen.rays(hx2 + 6 * u, hy2 - 6 * u, (20, 50, 80), 26, 26 + 10 * f)
    else:
        return None
    return pen.im.resize((size, size), Image.LANCZOS)


def main():
    anchors = json.load(open(os.path.join(SRC, "anchors.json")))
    used = sorted(set(STATES.values()))
    assert set(used) <= set(anchors), f"not rendered: {set(used) - set(anchors)}"
    cells, ticks = [], {}
    for anim in used:
        info = anchors[anim]
        n, hold = len(info["head_top"]), round(TICK_FPS / info["fps"])
        seq = []
        for i in range(n):
            im = Image.open(os.path.join(SRC, anim, f"{i:03d}.png")).convert("RGBA")
            over = marks(anim, i / n, info["head_top"][i], info["hand_r"][i], im.width)
            if over:
                im.alpha_composite(over)
            seq += [len(cells)] * hold
            cells.append(im)
        ticks[anim] = seq
    size = cells[0].width
    rows = (len(cells) + COLS - 1) // COLS
    sheet = Image.new("RGBA", (COLS * size, rows * size), (0, 0, 0, 0))
    for i, im in enumerate(cells):
        sheet.paste(im, ((i % COLS) * size, (i // COLS) * size))
    sheet.save(os.path.join(DST, "sheet.webp"), "WEBP", quality=85, method=6)

    name = lambda a: "A_" + a.upper().replace("-", "_")
    states = list(STATES)
    ts = ["// GENERATED by scripts/mascot/v3/pack_frames.py from scripts/mascot/v3/frames/. Do not edit;",
          "// change ANIMS in build_character.py (the motion) or pack_frames.py (marks, state mapping) and regenerate.",
          "", "export type MascotState ="]
    for i in range(0, len(states), 6):
        ts.append("  | " + " | ".join(f"'{s}'" for s in states[i:i + 6]) + (";" if i + 6 >= len(states) else ""))
    ts += ["", f"/** One drawn frame is {size}x{size} (the clay character, rendered in Blender); sheet.webp holds",
           f" *  {len(cells)} of them, {COLS} per row. */",
           f"export const FRAME_W = {size};", f"export const FRAME_H = {size};",
           f"export const SHEET_COLS = {COLS};", f"export const FRAME_COUNT = {len(cells)};",
           f"/** The renderer's clock: {TICK_FPS} ticks a second. Each index below is held for one tick. */",
           f"export const TICK_MS = {round(1000 / TICK_FPS)};", "",
           "/** A frame index into sheet.webp. */", "export type Frame = number;", ""]
    for anim in used:
        info = anchors[anim]
        ts.append(f"// {anim}: {len(info['head_top'])} drawn frames at {info['fps']} fps")
        ts.append(f"const {name(anim)}: Frame[] = [{', '.join(map(str, ticks[anim]))}];")
    ts += ["", "export const VARIANTS: Record<MascotState, Frame[][]> = {"]
    ts += [f"  {s}: [{name(a)}]," for s, a in STATES.items()]
    ts += ["};", "", "export const FRAMES: Record<MascotState, Frame[]> = {"]
    ts += [f"  {s}: VARIANTS.{s}[0]," for s in STATES]
    ts += ["};", ""]
    open(os.path.join(DST, "frames.ts"), "w", encoding="utf-8", newline="\n").write("\n".join(ts))
    kb = os.path.getsize(os.path.join(DST, "sheet.webp")) / 1024
    print(f"{len(cells)} frames, sheet {sheet.width}x{sheet.height}, {kb:.0f} KiB")


if __name__ == "__main__":
    main()
