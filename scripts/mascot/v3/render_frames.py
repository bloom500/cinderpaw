"""Render the app's mascot loops (ANIMS in build_character.py) from cinderpaw-v3.blend.

One transparent PNG per drawn frame in frames/<anim>/NNN.png, plus frames/anchors.json: each
loop's fps and, per frame, where the top of the head and the right hand land in the picture
(pack_frames.py draws the ?? / ... / Zzz marks there). Build the .blend first.

    blender --background --factory-startup --python render_frames.py -- [--size 256] [--only idle,waving]

Then: python pack_frames.py
"""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
sys.argv = sys.argv[:1]              # build_character reads its own flags at import
sys.path.insert(0, HERE)
import build_character as bc  # noqa: E402


def arg(name, default):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


SIZE = int(arg("--size", "256"))
ONLY = [a for a in arg("--only", "").split(",") if a]
OUT = os.path.join(HERE, "frames")

bpy.ops.wm.open_mainfile(filepath=os.path.join(HERE, "cinderpaw-v3.blend"))
sc = bpy.context.scene
sc.render.resolution_x = sc.render.resolution_y = SIZE
sc.render.film_transparent = True          # the app's surface shows through, light or dark
sc.render.image_settings.color_mode = "RGBA"
sc.eevee.taa_render_samples = 64           # 256 is for the 900 px turnaround; 64 is clean this small
bpy.data.objects["Floor"].hide_render = True
rig = bpy.data.objects["Rig"]
pivot, cam = bpy.data.objects["CamPivot"], bpy.data.objects["Cam"]
cam.data.type, cam.data.ortho_scale = "ORTHO", 3.8     # the same 3/4 view the poses were tuned in
pivot.rotation_euler = (0, 0, math.radians(-25))
cam.location, cam.rotation_euler = (0, -10, 0), (math.radians(90), 0, 0)
bpy.context.view_layer.update()


def pixel(p):
    u, v, _ = world_to_camera_view(sc, cam, rig.matrix_world @ p)
    return [round(u * SIZE), round((1 - v) * SIZE)]


path = os.path.join(OUT, "anchors.json")
anchors = json.load(open(path)) if ONLY and os.path.exists(path) else {}
for name, (pose, n, fps, extra) in bc.ANIMS.items():
    if ONLY and name not in ONLY:
        continue
    os.makedirs(os.path.join(OUT, name), exist_ok=True)
    heads, hands = [], []
    for i in range(n):
        bc.apply_pose(rig, pose, extra(i / n))
        heads.append(pixel(rig.pose.bones["head"].tail))
        hands.append(pixel(rig.pose.bones["hand.R"].head))
        sc.render.filepath = os.path.join(OUT, name, f"{i:03d}.png")
        bpy.ops.render.render(write_still=True)
    anchors[name] = {"fps": fps, "head_top": heads, "hand_r": hands}
json.dump(anchors, open(path, "w"), indent=1)
