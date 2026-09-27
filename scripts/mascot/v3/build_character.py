"""Build the Cinderpaw clay character in Blender from code, then render a turnaround.

Run headless:
  blender --background --factory-startup --python build_character.py -- --out renders --res 900

Reference: the turnaround and hero on his "Mascot Design / Concept V2" board (5f5d22c7),
plus the tail from the "Hey Darius" board (d2a86ea2). Units: 1.0 = 100 px on the 2x
turnaround crop, so the numbers below can be checked against that picture directly.
Blender axes: X right, -Y is the character's front, Z up. Feet stand on Z = 0.
"""
import math
import os
import sys

import json
import re
import stat

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, arg("--out", "renders"))
RES = int(arg("--res", "900"))
VIEWS = arg("--views", "front,threequarter,side,back,hero").split(",")
SILHOUETTE = "--silhouette" in ARGS

# ---- proportions, measured on the reference turnaround ----------------------
HEAD_C = Vector((0.0, 0.0, 1.79))        # hood centre
HEAD_R = Vector((1.125, 0.86, 0.89))     # half width, half depth, half height
HEAD_E = (0.90, 0.90)                    # squareness: front outline, plan outline (1 = ellipse)
FACE_INSET = 0.04                        # how far the visor sits inside the hood
VISOR = dict(cz=1.69, hw=0.85, hh=0.52, n=3.0)   # rounded-rectangle hole in the hood
EYE = dict(x=0.425, z=1.66, rx=0.115, rz=0.245, depth=0.045)
BODY_C = Vector((0.0, 0.0, 0.62))
BODY_R = Vector((0.60, 0.55, 0.50))   # depth read off the board's side view (~1.12 front to back)
BELLY = dict(cz=0.62, rx=0.38, rz=0.40)
# Everything above the hips is raised by this much to make the legs longer. He first asked for
# long legs to animate, then (27 Sep, later) for stubs like the board: 0 keeps the board's legs.
LEG_LIFT = 0.0
# a small thumb on each mitten; False gives the board's plain round hands
THUMBS = True
# how far the arm stands off the body below the shoulder (the armpit gap)
ARM_OUT = 0.03      # arms are their own clay now; a hair off the body so the two never intersect
# how much the joins of the fused clay are rounded (SDF fillet passes)
FILLET_ITERATIONS = 20

# Fitted to the board's outlines by fit_board.py (fit.json); the hand-set values above stay as
# the fallback when fit.json is missing. Legs (LEG_LIFT) and the tail are his choices.
FIT = json.load(open(os.path.join(HERE, "fit.json"))) if os.path.exists(os.path.join(HERE, "fit.json")) else None
if FIT:
    _h = FIT["hood"]
    HEAD_C = Vector((0.0, _h["centre_y"], _h["centre_z"]))
    HEAD_R = Vector((_h["half_width"], _h["half_depth"], _h["half_height"]))
    # the fit says 0.653 (squarest outline), but he wants the head rounder, like the board looks
    # in 3D: 0.75 costs 1.2% of front overlap (97.8 -> 96.6), and round from above (1.0)
    HEAD_E = (0.75, 1.0)
    VISOR.update(cz=FIT["visor"]["centre_z"], hw=FIT["visor"]["half_width"], hh=FIT["visor"]["half_height"])
    EYE.update(x=FIT["eye"]["x"], z=FIT["eye"]["z"], rx=FIT["eye"]["rx"], rz=FIT["eye"]["rz"])
    BODY_R = Vector((FIT["body"]["half_width"], BODY_R.y, BODY_R.z))

EMBER = (0.80, 0.115, 0.018)   # lit clay lands near the board's #E0662F
CREAM = (0.955, 0.87, 0.77)
BELLY_C = (0.99, 0.80, 0.60)
INK = (0.012, 0.009, 0.008)
PAPER = (0.93, 0.89, 0.83)


def sgnpow(v, p):
    return math.copysign(abs(v) ** p, v)


def superquadric(name, radii, e1, e2, centre, nu=128, nv=64, taper=0.0):
    """Closed superellipsoid mesh. e < 1 squares it off; taper > 0 widens the bottom."""
    a, b, c = radii
    verts, faces = [(0.0, 0.0, -c)], []
    for i in range(1, nv):
        v = -math.pi / 2 + math.pi * i / nv
        for j in range(nu):
            u = -math.pi + 2 * math.pi * j / nu
            cv, sv = sgnpow(math.cos(v), e1), sgnpow(math.sin(v), e1)
            x, y, z = a * cv * sgnpow(math.cos(u), e2), b * cv * sgnpow(math.sin(u), e2), c * sv
            k = 1.0 + taper * (-z / c)
            verts.append((x * k, y * k, z))
    verts.append((0.0, 0.0, c))
    top = len(verts) - 1
    ring = lambda i, j: 1 + (i - 1) * nu + (j % nu)
    for j in range(nu):
        faces.append((0, ring(1, j + 1), ring(1, j)))
    for i in range(1, nv - 1):
        for j in range(nu):
            faces.append((ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i + 1, j)))
    for j in range(nu):
        faces.append((top, ring(nv - 1, j), ring(nv - 1, j + 1)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.location = centre
    bpy.context.collection.objects.link(ob)
    return ob


def inside(p, radii, e1, e2):
    """Superellipsoid inside-outside value: < 1 inside, 1 on the surface."""
    a, b, c = radii
    xy = (abs(p.x / a) ** (2 / e2) + abs(p.y / b) ** (2 / e2)) ** (e2 / e1)
    return xy + abs(p.z / c) ** (2 / e1)


def front_y(x, z, radii, e1, e2):
    """Where the hood's front surface is, at (x, z) relative to its centre."""
    lo, hi = -radii.y, 0.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if inside(Vector((x, mid, z)), radii, e1, e2) > 1.0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def logo_visor(samples=96):
    """The visor outline from the approved logo (logo/logo-paths.json), unit-sized."""
    path = os.path.join(HERE, "logo", "logo-paths.json")
    if not os.path.exists(path):
        return None
    nums = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", json.load(open(path))["visor"])]
    anchors = [(nums[1 + 6 * k + 4], nums[1 + 6 * k + 5]) for k in range((len(nums) - 2) // 6)]
    xs, ys = [p[0] for p in anchors], [p[1] for p in anchors]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    hw, hh = (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2
    unit = [((x - cx) / hw, -(y - cy) / hh) for x, y in anchors]   # SVG y points down
    out, n = [], len(unit)
    per = samples // n
    for i in range(n):
        p0, p1, p2, p3 = (Vector(unit[(i + k) % n]) for k in (-1, 0, 1, 2))
        for t in (j / per for j in range(per)):
            out.append(tuple(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                                    + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)))
    return out


def visor_cutter():
    """A prism in the shape of the logo's visor, pointing into the face, to open the hood."""
    unit = logo_visor()
    if unit is None:
        n = VISOR["n"]
        unit = [(sgnpow(math.cos(t), 2 / n), sgnpow(math.sin(t), 2 / n))
                for t in (2 * math.pi * k / 96 for k in range(96))]
    pts = [(VISOR["hw"] * x, VISOR["hh"] * z) for x, z in unit]
    verts = [(x, -2.0, z) for x, z in pts] + [(x, -0.2, z) for x, z in pts]
    m = len(pts)
    faces = [tuple(range(m))[::-1], tuple(range(m, 2 * m))]
    faces += [(k, (k + 1) % m, m + (k + 1) % m, m + k) for k in range(m)]
    me = bpy.data.meshes.new("VisorCutter")
    me.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    ob = bpy.data.objects.new("VisorCutter", me)
    ob.location = (0.0, 0.0, VISOR["cz"])
    bpy.context.collection.objects.link(ob)
    ob.hide_render = True
    ob.display_type = "WIRE"
    return ob


def tube(name, points, radii, material, tip=True, bury=0.0):
    """A round tube along a smooth curve, tapering by radius, the far end rounded off.
    Round in every direction and the curve keeps its bend; the Skin modifier squared the
    sections off and straightened the horns."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.resolution_u = 24
    cu.bevel_mode = "ROUND"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = 24          # 10 left faceted stripes along the horns after the fuse
    cu.use_fill_caps = True
    if bury:
        # start further inside the part it grows from: the flat start cap showed at the horn roots
        p0, p1 = Vector(points[0]), Vector(points[1])
        points = [tuple(p0 - (p1 - p0).normalized() * bury)] + list(points)
        radii = [radii[0]] + list(radii)
    if tip:
        # close the end with a dome made of the tube's own radius, so there is no seam
        end, before, r = Vector(points[-1]), Vector(points[-2]), radii[-1]
        d = (end - before).normalized()
        points = list(points) + [tuple(end + d * r * k) for k in (0.55, 0.9, 1.0)]
        radii = list(radii) + [r * 0.84, r * 0.45, r * 0.02]
    sp = cu.splines.new("NURBS")
    sp.points.add(len(points) - 1)
    for p, (x, y, z), r in zip(sp.points, points, radii):
        p.co = (x, y, z, 1.0)
        p.radius = r
    sp.order_u = min(4, len(points))
    sp.use_endpoint_u = True
    sp.use_smooth = True
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    cu.materials.append(material)
    return ob


def fuse_clay(parts, material, voxel=0.01, name="Clay"):
    """Melt the clay parts into one surface: voxel remesh, then a volume-keeping smooth, applied."""
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for ob in parts:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
        me.transform(ob.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for part in parts:
        bpy.data.objects.remove(part, do_unlink=True)
    # Join in a distance field, not on the surface: mesh -> SDF grid -> fillet (rounds only the
    # inside corners, the joins) -> light mean (voxel steps) -> mesh. Growing and shrinking the
    # surface along its normals (27 Sep) folded into fins under the chin and at the thumbs.
    ng = bpy.data.node_groups.new("ClayFuse", "GeometryNodeTree")
    ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gin, gout = ng.nodes.new("NodeGroupInput"), ng.nodes.new("NodeGroupOutput")
    sdf = ng.nodes.new("GeometryNodeMeshToSDFGrid")
    sdf.inputs["Voxel Size"].default_value, sdf.inputs["Band Width"].default_value = voxel, 6
    fillet = ng.nodes.new("GeometryNodeSDFGridFillet")
    fillet.inputs["Iterations"].default_value = FILLET_ITERATIONS
    mean = ng.nodes.new("GeometryNodeSDFGridMean")
    mean.inputs["Width"].default_value, mean.inputs["Iterations"].default_value = 1, 1
    to_mesh = ng.nodes.new("GeometryNodeGridToMesh")
    to_mesh.inputs["Threshold"].default_value = 0.0          # the surface of a distance field is 0
    smooth = ng.nodes.new("GeometryNodeSetShadeSmooth")
    links = ng.links
    links.new(gin.outputs["Geometry"], sdf.inputs["Mesh"])
    links.new(sdf.outputs["SDF Grid"], fillet.inputs["Grid"])
    links.new(fillet.outputs["Grid"], mean.inputs["Grid"])
    links.new(mean.outputs["Grid"], to_mesh.inputs["Grid"])
    links.new(to_mesh.outputs["Mesh"], smooth.inputs["Mesh"])
    links.new(smooth.outputs["Mesh"], gout.inputs["Geometry"])
    ob.modifiers.new("Fuse", "NODES").node_group = ng
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    ob.modifiers.clear()
    ob.data = baked
    for p in baked.polygons:
        p.use_smooth = True
    baked.materials.clear()
    baked.materials.append(material)
    return ob


def ember_tip(material, tip, reach=0.35):
    """Warm the last stretch of the tail to Flame orange, like a cinder's glowing end."""
    nt = material.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    dist = nt.nodes.new("ShaderNodeVectorMath")
    dist.operation = "DISTANCE"
    dist.inputs[1].default_value = tuple(tip)
    nt.links.new(tc.outputs["Object"], dist.inputs[0])
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value, ramp.inputs["From Max"].default_value = reach, 0.0
    nt.links.new(dist.outputs["Value"], ramp.inputs["Value"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*EMBER, 1.0)
    mix.inputs["B"].default_value = (1.0, 0.30, 0.06, 1.0)
    nt.links.new(ramp.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])


def assert_clear_of_hood(name, points, radii, margin=0.03):
    """Stop the build if a tube (with its round end) would pass through the hood.
    27 Sep: the tail's tip ended inside the back of the head once the head grew to the board's size."""
    end, before, r = Vector(points[-1]), Vector(points[-2]), radii[-1]
    d = (end - before).normalized()
    pts = [Vector(p) for p in points] + [end + d * r * k for k in (0.55, 0.9, 1.0)]
    rs = list(radii) + [r * 0.84, r * 0.45, r * 0.02]
    for (p0, r0), (p1, r1) in zip(zip(pts, rs), zip(pts[1:], rs[1:])):
        for t in (k / 20 for k in range(21)):
            p, rr = p0.lerp(p1, t), r0 + (r1 - r0) * t
            grown = HEAD_R + Vector((rr + margin,) * 3)
            if inside(p - HEAD_C, grown, *HEAD_E) < 1.0:
                raise SystemExit(f"{name} passes through the hood near {tuple(round(c, 2) for c in p)}")


def blob(name, radii, centre, material, parent=None, along=None, e=0.9):
    """A soft rounded lump: a hand, a foot, the round end of a tube."""
    ob = superquadric(name, radii, e, e, Vector(centre), nu=48, nv=24)
    ob.data.materials.append(material)
    if along is not None:
        ob.rotation_euler = Vector(along).normalized().to_track_quat("Z", "Y").to_euler()
    if parent is not None:
        ob.parent = parent
    return ob


def conform_patch(name, target, cx, cz, rx, rz, depth, material, rings=28, spokes=96, soft=6.0):
    """A raised patch lying on the front of `target`: elliptical from the front, flat on top,
    rounded at the rim, following the body's curve. Clay pressed on clay, not paint."""
    bpy.context.view_layer.update()
    base = target.location

    def surface_y(x, z):
        hit, loc, _n, _i = target.ray_cast(Vector((x, -5.0, z)) - base, Vector((0, 1, 0)))
        return (loc + base).y if hit else 0.0

    verts, faces = [], []
    verts.append((cx, surface_y(cx, cz) - depth, cz))
    for i in range(1, rings + 1):
        rho = i / rings
        lift = depth * (1 - rho ** soft) ** (1 / soft)   # lower soft = a gentler rim, less sticker
        for j in range(spokes):
            t = 2 * math.pi * j / spokes
            x, z = cx + rx * rho * math.cos(t), cz + rz * rho * math.sin(t)
            verts.append((x, surface_y(x, z) - lift + (0.004 if i == rings else -0.002), z))
    ring = lambda i, j: 1 + (i - 1) * spokes + (j % spokes)
    faces += [(0, ring(1, j), ring(1, j + 1)) for j in range(spokes)]
    for i in range(1, rings):
        faces += [(ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j + 1)) for j in range(spokes)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(material)
    return ob


def mirrored(points):
    return [(-x, y, z) for x, y, z in points]


def principled(name, color, rough, sss=0.0, sheen=0.0, coat=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Subsurface Weight"].default_value = sss
    bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
    bsdf.inputs["Subsurface Scale"].default_value = 0.06
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    bsdf.inputs["Sheen Weight"].default_value = sheen
    bsdf.inputs["Coat Weight"].default_value = coat
    return mat, bsdf


def clay_bump(mat, bsdf, strength=0.03):
    """A faint matte grain, the way real modelling clay catches light."""
    nt = mat.node_tree
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 140.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def belly_material():
    """Body clay with the cream belly painted on in the shader, flush, no seam."""
    mat, bsdf = principled("BodyClay", EMBER, 0.62, sss=0.18, sheen=0.12)
    clay_bump(mat, bsdf)
    nt = mat.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])

    def math_node(op, a, b=None):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = op
        for idx, val in ((0, a), (1, b)):
            if val is None:
                continue
            if isinstance(val, (int, float)):
                n.inputs[idx].default_value = val
            else:
                nt.links.new(val, n.inputs[idx])
        return n.outputs[0]

    dz = math_node("SUBTRACT", sep.outputs["Z"], BELLY["cz"] - BODY_C.z)
    ex = math_node("POWER", math_node("DIVIDE", sep.outputs["X"], BELLY["rx"]), 2.0)
    ez = math_node("POWER", math_node("DIVIDE", dz, BELLY["rz"]), 2.0)
    e = math_node("ADD", ex, ez)
    inside_ellipse = math_node("LESS_THAN", e, 1.0)
    front = math_node("LESS_THAN", sep.outputs["Y"], -0.2)
    mask = math_node("MULTIPLY", inside_ellipse, front)
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*EMBER, 1.0)
    mix.inputs["B"].default_value = (*BELLY_C, 1.0)
    nt.links.new(mask, mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    return mat


def look_at(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


def area_light(name, loc, energy, size, color, target=(0, 0, 1.5)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.size, data.color = energy, size, color
    ob = bpy.data.objects.new(name, data)
    ob.location = loc
    bpy.context.collection.objects.link(ob)
    look_at(ob, target)
    return ob


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene

    clay, clay_bsdf = principled("Clay", EMBER, 0.62, sss=0.18)
    clay_bump(clay, clay_bsdf)
    cream, _ = principled("Visor", CREAM, 0.55, sss=0.12)
    ink, _ = principled("Eyes", INK, 0.5)

    # hood with the visor opened in it; the face is the same hood shrunk inward
    hood = superquadric("Hood", HEAD_R, *HEAD_E, HEAD_C)
    hood.data.materials.append(clay)

    face_r = HEAD_R - Vector((FACE_INSET,) * 3)
    face = superquadric("Face", face_r, *HEAD_E, HEAD_C)
    face.data.materials.append(cream)

    for s in (-1, 1):
        x, z = s * EYE["x"], EYE["z"]
        y = front_y(x, z - HEAD_C.z, face_r, *HEAD_E)
        eye = superquadric(f"Eye.{'L' if s < 0 else 'R'}", (EYE["rx"], EYE["depth"], EYE["rz"]), 0.9, 1.0,
                           Vector((x, y, z)), nu=48, nv=24)
        eye.data.materials.append(ink)

    body = superquadric("Body", BODY_R, 0.85, 0.85, BODY_C, taper=0.06)
    for v in body.data.vertices:            # a small round belly pushing forward
        if v.co.y < 0:
            v.co.y -= 0.06 * math.exp(-((v.co.z + 0.04) / 0.26) ** 2) * min(1.0, -v.co.y / 0.3)
    body.data.update()
    body.data.materials.append(clay)

    # horns as on the board: a wide base on the head's corner, then one continuous taper that
    # leans out and bends up, with a small round tip
    horn = [(0.78, 0.10, 2.38), (0.95, 0.10, 2.58), (1.02, 0.12, 2.78), (0.97, 0.14, 2.96)]
    horn_r = [0.30, 0.25, 0.17, 0.085]
    if FIT:
        horn, horn_r = [tuple(p) for p in FIT["horn"]["points"]], FIT["horn"]["radii"]
    # arms as on the board: one piece, broad at the shoulder, growing thicker toward a round
    # end (the hand), no wrist; long enough to wave and hold things once rigged
    arm = [(0.40, 0.0, 0.94), (0.56, -0.02, 0.76), (0.66, -0.03, 0.58), (0.72, -0.04, 0.44)]
    arm_r = [0.17, 0.16, 0.18, 0.20]
    if FIT:
        arm, arm_r = [tuple(p) for p in FIT["arm"]["points"]], FIT["arm"]["radii"]
    # the arm touches the body only at the shoulder: below it, stand it off by ARM_OUT so the fuse
    # leaves an armpit gap. Glued along the side, a raised arm tore the side skin with it.
    arm = [arm[0]] + [(x + ARM_OUT * min(1.0, k / 2), y, z) for k, (x, y, z) in enumerate(arm[1:], 1)]
    global ARM, ARM_R
    ARM, ARM_R = arm, arm_r
    for side, flip in (("R", 1), ("L", -1)):
        m = lambda pts: [(flip * x, y, z) for x, y, z in pts]
        tube(f"Horn.{side}", m(horn), horn_r, clay, bury=0.25)
        tube(f"Arm.{side}", m(arm), arm_r, clay)
        if THUMBS:
            # a small thumb on each mitten, pointing forward and in: a hand, not a stump
            end = Vector(m(arm)[-1])
            tube(f"Thumb.{side}", [tuple(end + Vector((-0.04 * flip, -0.10, 0.06))),
                                   tuple(end + Vector((-0.09 * flip, -0.19, 0.10)))], [0.075, 0.06], clay)
    # like a flame behind the back: out, up, the tip curling forward, and kept clear of the hood
    global TAIL
    tail = TAIL = [(0.0, 0.45, 0.40), (0.10, 0.80, 0.45), (0.22, 0.98, 0.70), (0.22, 0.95, 0.92), (0.15, 0.85, 1.02)]
    tail_r = [0.12, 0.15, 0.14, 0.10, 0.06]
    assert_clear_of_hood("Tail", tail, tail_r)
    tube("Tail", tail, tail_r, clay)

    # everything above the hips goes up by LEG_LIFT, which leaves room for real legs
    for ob in list(bpy.data.objects):
        if ob.parent is None:
            ob.location.z += LEG_LIFT
    for side, flip in (("R", 1), ("L", -1)):
        # stubs like the board's, outer edge at its +-0.62 lower-body line
        leg = tube(f"Leg.{side}", [(flip * 0.35, 0.0, 0.40), (flip * 0.36, -0.01, 0.28), (flip * 0.36, -0.02, 0.18)],
                   [0.26, 0.26, 0.25], clay, tip=False)
        # a foot a little longer toward the front, flatter underneath
        blob(f"Foot.{side}", (0.255, 0.30, 0.14), (flip * 0.36, -0.06, 0.14), clay, parent=leg, e=0.75)

    # one piece of clay: fuse the parts so the joins are soft and no caps or rings show; visor,
    # eyes and belly stay apart so they keep their colours and the eyes can still blink
    clay_parts = [ob for ob in bpy.data.objects if ob.name.split(".")[0] in
                  ("Hood", "Body", "Horn", "Tail", "Leg", "Foot")]
    fused = fuse_clay(clay_parts, clay)
    # Arms are separate pieces rooted in the shoulder, under the hood's edge. Fused into the body,
    # the fillet always bridged a web from arm to hip that tore into a strip when the arm lifted.
    for side in ("L", "R"):
        fuse_clay([bpy.data.objects[n] for n in (f"Arm.{side}", f"Thumb.{side}") if n in bpy.data.objects],
                  clay, name=f"ArmClay.{side}")
    # cut the visor after the fuse: cut first, the voxel grid turned the lip into a staircase
    cut = visor_cutter()
    cut.location.z += LEG_LIFT
    boolean = fused.modifiers.new("Visor", "BOOLEAN")
    boolean.operation, boolean.solver, boolean.object = "DIFFERENCE", "EXACT", cut
    rim = fused.modifiers.new("SoftRim", "BEVEL")
    rim.limit_method, rim.angle_limit, rim.width, rim.segments = "ANGLE", math.radians(35), 0.05, 6
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(fused.evaluated_get(dg), depsgraph=dg)
    fused.modifiers.clear()
    fused.data = baked
    bpy.data.objects.remove(cut, do_unlink=True)
    ember_tip(clay, Vector(tail[-1]) + Vector((0, 0, LEG_LIFT)))
    belly, _ = principled("Belly", BELLY_C, 0.58, sss=0.12)
    clay_bump(belly, belly.node_tree.nodes["Principled BSDF"], 0.04)
    conform_patch("Belly", fused, 0.0, BELLY["cz"] + LEG_LIFT, BELLY["rx"], BELLY["rz"], 0.018, belly, soft=2.5)

    # studio: paper floor, warm key, soft fill, rim to lift the silhouette
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "Floor"
    paper, _ = principled("Paper", PAPER, 0.9)
    floor.data.materials.append(paper)
    area_light("Key", (-4.0, -5.5, 6.0), 650, 5.0, (1.0, 0.94, 0.86))
    area_light("Fill", (5.0, -4.0, 3.0), 70, 6.0, (1.0, 0.90, 0.82))
    area_light("Rim", (2.5, 5.0, 5.0), 450, 3.0, (1.0, 0.86, 0.72))
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    wn = world.node_tree
    seen = wn.nodes["Background"]
    seen.inputs["Color"].default_value = (*PAPER, 1.0)
    seen.inputs["Strength"].default_value = 1.0
    ambient = wn.nodes.new("ShaderNodeBackground")
    ambient.inputs["Color"].default_value = (*PAPER, 1.0)
    ambient.inputs["Strength"].default_value = 0.18
    path = wn.nodes.new("ShaderNodeLightPath")
    mix = wn.nodes.new("ShaderNodeMixShader")
    wn.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    wn.links.new(ambient.outputs["Background"], mix.inputs[1])
    wn.links.new(seen.outputs["Background"], mix.inputs[2])
    wn.links.new(mix.outputs["Shader"], wn.nodes["World Output"].inputs["Surface"])
    sc.world = world

    sc.render.engine = "BLENDER_EEVEE"
    sc.eevee.taa_render_samples = 256     # 64 left grain in the deep shadow under the chin
    sc.eevee.use_raytracing = True
    sc.view_settings.view_transform = "Standard"   # keep brand oranges; AgX washes them to peach
    print("VIEW TRANSFORM", sc.view_settings.view_transform)
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.render.image_settings.file_format = "PNG"

    pivot = bpy.data.objects.new("CamPivot", None)
    pivot.location = (0, 0, 1.65)
    sc.collection.objects.link(pivot)
    cam_data = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_data)
    sc.collection.objects.link(cam)
    cam.parent = pivot
    sc.camera = cam
    return sc, pivot, cam, floor


def render(sc, pivot, cam, floor):
    os.makedirs(OUT, exist_ok=True)
    turns = {"front": 0, "threequarter": -35, "side": 90, "back": 180}
    for view in VIEWS:
        if view == "hero":
            cam.data.type, cam.data.lens = "PERSP", 85
            pivot.rotation_euler = (0, 0, math.radians(-22))
            cam.location = (0, -13.0, 0.65)
            cam.rotation_euler = (math.radians(90 - math.degrees(math.atan2(0.65, 13.0))), 0, 0)
        else:
            cam.data.type, cam.data.ortho_scale = "ORTHO", 3.8
            pivot.rotation_euler = (0, 0, math.radians(turns[view]))
            cam.location = (0, -10, 0)
            cam.rotation_euler = (math.radians(90), 0, 0)
        sc.render.filepath = os.path.join(OUT, f"{view}.png")
        bpy.ops.render.render(write_still=True)
    if SILHOUETTE:
        floor.hide_render = True
        sc.render.film_transparent = True
        sc.render.image_settings.color_mode = "RGBA"
        cam.data.type, cam.data.ortho_scale = "ORTHO", 3.8
        pivot.rotation_euler = (0, 0, 0)
        cam.location, cam.rotation_euler = (0, -10, 0), (math.radians(90), 0, 0)
        sc.render.filepath = os.path.join(OUT, "front-alpha.png")
        bpy.ops.render.render(write_still=True)
        floor.hide_render = False
        sc.render.film_transparent = False


def _seg(P, pts):
    """Distance from every row of P to a polyline, and how far along it (0..1) the closest point is."""
    pts = np.array([tuple(p) for p in pts], float)
    lens = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    total, start = lens.sum(), np.concatenate([[0], np.cumsum(lens)[:-1]])
    best_d = np.full(len(P), np.inf)
    best_t = np.zeros(len(P))
    for a, b, l0, ln in zip(pts[:-1], pts[1:], start, lens):
        ab = b - a
        u = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(P - (a + u[:, None] * ab), axis=1)
        closer = d < best_d
        best_d[closer], best_t[closer] = d[closer], (l0 + u[closer] * ln) / total
    return best_d, best_t


def _soft(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def bind_weights(ob, hp, ap, tp, arm_r, arms=True):
    """One vertex group per bone. A vertex belongs to a horn, arm, tail or leg when it lies within
    that part's radius of its centre line, fading out just past it; the rest is head (above the
    neck) or body (chest above, hips below). Rows are normalised so every vertex sums to 1."""
    n = len(ob.data.vertices)
    P = np.empty(n * 3)
    ob.data.vertices.foreach_get("co", P)
    P = P.reshape(n, 3) + np.array(ob.location)
    P[:, 2] -= LEG_LIFT
    W = {}
    for side, f in (("L", -1), ("R", 1)):
        m = lambda pts: [(f * p[0], p[1], p[2]) for p in pts]
        d, t = _seg(P, m(hp))
        w = (1 - _soft(0.30, 0.42, d)) * _soft(2.30, 2.50, P[:, 2]) * (np.sign(P[:, 0]) == f)
        W[f"horn_tip.{side}"], W[f"horn.{side}"] = w * _soft(0.40, 0.60, t), w * (1 - _soft(0.40, 0.60, t))
        d, t = _seg(P, m(ap))
        # only the arm's own clay: within its local radius (+ a little), so the side of the body
        # next to it stays with the chest when the arm lifts
        cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.array([tuple(p) for p in ap]), axis=0), axis=1))])
        r_here = np.interp(t, cum / cum[-1], arm_r)
        w = (1 - _soft(r_here + 0.01, r_here + 0.07, d)) * _soft(0.05, 0.25, t) * (np.sign(P[:, 0]) == f) * arms
        W[f"upper_arm.{side}"] = w * (1 - _soft(0.35, 0.55, t))
        W[f"forearm.{side}"] = w * _soft(0.35, 0.55, t) * (1 - _soft(0.80, 0.95, t))
        W[f"hand.{side}"] = w * _soft(0.80, 0.95, t)
        d, t = _seg(P, [(f * 0.35, 0, 0.42), (f * 0.36, 0, 0.16), (f * 0.36, -0.08, 0.10)])
        w = (1 - _soft(0.27, 0.36, d)) * (1 - _soft(0.24, 0.36, P[:, 2])) * (np.sign(P[:, 0]) == f)
        W[f"thigh.{side}"], W[f"foot.{side}"] = w * _soft(0.12, 0.20, P[:, 2]), w * (1 - _soft(0.12, 0.20, P[:, 2]))
    d, t = _seg(P, tp)
    w = (1 - _soft(0.17, 0.26, d)) * _soft(0.08, 0.25, t) * (P[:, 1] > 0.3)
    W["tail.1"], W["tail.2"], W["tail.3"] = (w * (1 - _soft(0.30, 0.45, t)), w * _soft(0.30, 0.45, t) * (1 - _soft(0.65, 0.80, t)),
                                             w * _soft(0.65, 0.80, t))
    parts = sum(W.values())
    over = np.maximum(parts, 1.0)
    for k in W:
        W[k] = W[k] / over
    rest_w = np.clip(1 - parts / over, 0, 1)
    head = _soft(0.95, 1.12, P[:, 2])
    W["head"] = rest_w * head
    W["chest"] = rest_w * (1 - head) * _soft(0.55, 0.85, P[:, 2])
    W["hips"] = rest_w * (1 - head) * (1 - _soft(0.55, 0.85, P[:, 2]))
    for bone_name, w in W.items():
        vg = ob.vertex_groups.new(name=bone_name)
        q = np.round(w * 20).astype(int)            # 20 levels, one add() call per level
        for level in range(1, 21):
            idx = np.nonzero(q == level)[0]
            if len(idx):
                vg.add(idx.tolist(), level / 20, "REPLACE")


def bind_arm(ob, side, ap):
    """An arm piece belongs to its own bones only, split along its length; its buried root
    follows the chest so the shoulder turns rather than slides."""
    f = -1 if side == "L" else 1
    n = len(ob.data.vertices)
    P = np.empty(n * 3)
    ob.data.vertices.foreach_get("co", P)
    P = P.reshape(n, 3) + np.array(ob.location)
    P[:, 2] -= LEG_LIFT
    _, t = _seg(P, [(f * p[0], p[1], p[2]) for p in ap])
    W = {"chest": 1 - _soft(0.0, 0.12, t)}
    arm_w = _soft(0.0, 0.12, t)
    W[f"upper_arm.{side}"] = arm_w * (1 - _soft(0.35, 0.55, t))
    W[f"forearm.{side}"] = arm_w * _soft(0.35, 0.55, t) * (1 - _soft(0.80, 0.95, t))
    W[f"hand.{side}"] = arm_w * _soft(0.80, 0.95, t)
    for bone_name, w in W.items():
        vg = ob.vertex_groups.new(name=bone_name)
        q = np.round(w * 20).astype(int)
        for level in range(1, 21):
            idx = np.nonzero(q == level)[0]
            if len(idx):
                vg.add(idx.tolist(), level / 20, "REPLACE")


def build_rig(tail):
    """Skeleton for the fused clay: bones follow the parts' centre lines, Blender's automatic
    (bone heat) weights bind the clay and the belly, the visor and eyes ride the head bone."""
    arm = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", arm)
    bpy.context.collection.objects.link(rig)
    rig.show_in_front = True
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones
    lift = Vector((0, 0, LEG_LIFT))

    def bone(name, head, tail_, parent=None, connect=False):
        b = eb.new(name)
        b.head, b.tail = Vector(head) + lift, Vector(tail_) + lift
        if parent:
            b.parent, b.use_connect = eb[parent], connect
        return b

    bone("root", (0, 0, 0), (0, -0.4, 0))
    bone("hips", (0, 0, 0.30), (0, 0, 0.70), "root")
    bone("chest", (0, 0, 0.70), (0, 0, 1.05), "hips", True)
    bone("head", (0, 0, 1.05), (0, 0, 2.70), "chest", True)
    hp = [Vector(p) for p in (FIT["horn"]["points"] if FIT else [(0.78, 0.1, 2.38), (1.02, 0.12, 2.78), (0.97, 0.14, 2.96)])]
    ap = [Vector(p) for p in ARM]
    for side, f in (("L", -1), ("R", 1)):
        m = lambda v: Vector((f * v.x, v.y, v.z))
        mid = (hp[0] + hp[-1]) / 2
        bone(f"horn.{side}", m(hp[0]), m(mid), "head")
        bone(f"horn_tip.{side}", m(mid), m(hp[-1]), f"horn.{side}", True)
        elbow, wrist = ap[0].lerp(ap[-1], 0.45), ap[-1]
        bone(f"upper_arm.{side}", m(ap[0]), m(elbow), "chest")
        bone(f"forearm.{side}", m(elbow), m(wrist), f"upper_arm.{side}", True)
        bone(f"hand.{side}", m(wrist), m(wrist + Vector((0.0, 0.0, -0.18))), f"forearm.{side}", True)
        bone(f"thigh.{side}", (f * 0.35, 0, 0.42), (f * 0.36, 0, 0.16), "hips")
        bone(f"foot.{side}", (f * 0.36, 0, 0.16), (f * 0.36, -0.32, 0.08), f"thigh.{side}", True)
    tp = [Vector(p) for p in tail]
    bone("tail.1", tp[0], tp[1], "hips")
    bone("tail.2", tp[1], tp[2], "tail.1", True)
    bone("tail.3", tp[2], tp[-1], "tail.2", True)
    bpy.ops.object.mode_set(mode="OBJECT")

    # bind: weights computed from the parts' centre lines. Blender's bone heat failed on the fused
    # clay (too dense), leaving it unbound, so a posed rig did not move the mesh at all.
    for name in ("Clay", "Belly", "ArmClay.L", "ArmClay.R"):
        ob = bpy.data.objects[name]
        if name.startswith("ArmClay"):
            bind_arm(ob, name[-1], ap)
        else:
            bind_weights(ob, hp, ap, tp, ARM_R, arms=False)
        mod = ob.modifiers.new("Rig", "ARMATURE")
        mod.object = rig
    # visor and eyes are rigid: they follow the head bone exactly
    head_mat = rig.matrix_world @ arm.bones["head"].matrix_local @ Matrix.Translation((0, arm.bones["head"].length, 0))
    for name in ("Face", "Eye.L", "Eye.R"):
        ob = bpy.data.objects[name]
        ob.parent, ob.parent_type, ob.parent_bone = rig, "BONE", "head"
        ob.matrix_parent_inverse = head_mat.inverted()
    bpy.ops.object.select_all(action="DESELECT")
    return rig


def turn(pb, axis, degrees):
    """Rotate a pose bone about a world axis (the rig sits at the origin, unrotated)."""
    M = pb.bone.matrix_local.to_3x3()
    local = M.inverted() @ Matrix.Rotation(math.radians(degrees), 3, axis) @ M
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = local.to_quaternion()


def pose_test(rig):
    """A wave with a head tilt, a horn wiggle and a tail flick, to see the rig bend the clay."""
    pb = rig.pose.bones
    # the head is wider than the arm is long: a wave goes out to the side, forearm up, so the
    # hand shows beside the head instead of disappearing behind it
    turn(pb["upper_arm.R"], "Y", -55)
    turn(pb["forearm.R"], "Y", -45)
    turn(pb["forearm.R"], "X", -40)         # the hand comes forward (-Y), in front of the head's side
    turn(pb["head"], "Y", 8)
    turn(pb["horn.R"], "Y", -12)
    turn(pb["horn.L"], "Y", 12)
    turn(pb["tail.2"], "X", -20)


def rest(rig):
    for b in rig.pose.bones:
        b.rotation_mode = "QUATERNION"
        b.rotation_quaternion = (1, 0, 0, 0)
        b.location = (0, 0, 0)


def add_references():
    """The board's straight views as see-through pictures pinned behind the model, each shown
    only in its own view (Front, Right, Back). Made by make_refs.py. They are raised by
    LEG_LIFT so head, horns and arms line up; the legs are longer than the board's on purpose."""
    path = os.path.join(HERE, "refs", "refs.json")
    if not os.path.exists(path):
        return
    refs = json.load(open(path))
    coll = bpy.data.collections.new("References")
    bpy.context.scene.collection.children.link(coll)
    # view: (rotation in degrees, where the picture stands, which world axis is the picture's right)
    placement = {"front": ((90, 0, 0), Vector((0, 2.5, 0)), Vector((1, 0, 0))),
                 "side": ((90, 0, 90), Vector((-2.5, 0, 0)), Vector((0, 1, 0))),
                 "back": ((90, 0, 180), Vector((0, -2.5, 0)), Vector((-1, 0, 0)))}
    for view, info in refs.items():
        rot, spot, right = placement[view]
        img = bpy.data.images.load(os.path.join(HERE, info["file"]), check_existing=True)
        img.filepath = "//" + info["file"]
        ob = bpy.data.objects.new(f"Ref.{view}", None)
        ob.empty_display_type = "IMAGE"
        ob.data = img
        ob.empty_display_size = info["size"]
        ob.empty_image_offset = (-0.5, -0.5)
        ob.empty_image_depth = "FRONT"            # drawn over the model, half see-through
        ob.use_empty_image_alpha = True
        ob.color = (1.0, 1.0, 1.0, 0.5)
        ob.show_empty_image_only_axis_aligned = True
        ob.show_empty_image_perspective = False
        ob.rotation_euler = tuple(math.radians(v) for v in rot)
        ob.location = spot + right * info["centre_h"] + Vector((0, 0, info["centre_z"] + LEG_LIFT))
        coll.objects.link(ob)


def open_ready(pivot, cam):
    """When he opens the file: live render in the viewport, seen from the 3/4 camera."""
    cam.data.type, cam.data.ortho_scale = "ORTHO", 3.8
    pivot.rotation_euler = (0, 0, math.radians(-30))
    cam.location, cam.rotation_euler = (0, -10, 0), (math.radians(90), 0, 0)
    for screen in bpy.data.screens:
        for area in screen.areas:
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    space.shading.type = "RENDERED"
                    space.region_3d.view_perspective = "CAMERA"


if __name__ == "__main__":
    scene, pivot_ob, cam_ob, floor_ob = build()
    rig_ob = build_rig(TAIL)
    if "--pose-test" in ARGS:
        pose_test(rig_ob)
        cam_ob.data.type, cam_ob.data.ortho_scale = "ORTHO", 3.8
        for view, turn in (("pose-front", 0), ("pose-threequarter", -35)):
            pivot_ob.rotation_euler = (0, 0, math.radians(turn))
            cam_ob.location, cam_ob.rotation_euler = (0, -10, 0), (math.radians(90), 0, 0)
            scene.render.filepath = os.path.join(OUT, f"{view}.png")
            bpy.ops.render.render(write_still=True)
        rest(rig_ob)
    add_references()
    open_ready(pivot_ob, cam_ob)
    # The script is the source of truth and the .blend is its output. It stays read-only, so
    # a Save from an open Blender window fails loudly instead of quietly putting an older
    # model back (27 Sep: a window left open since 16:45 saved over three rounds of fixes).
    # To keep a hand edit, use File > Save As with another name.
    blend = os.path.join(HERE, "cinderpaw-v3.blend")
    if os.path.exists(blend):
        os.chmod(blend, stat.S_IREAD | stat.S_IWRITE)
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    os.chmod(blend, stat.S_IREAD)
    render(scene, pivot_ob, cam_ob, floor_ob)
