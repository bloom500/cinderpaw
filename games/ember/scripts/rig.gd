class_name Rig
extends Node2D
## Cinderpaw as a skinned mesh. rig/rig.json (from rig/build_rig.py) holds the
## mesh over art/cheer.png, the bones and every vertex's weights; `build` turns
## it into a Skeleton2D and a Polygon2D, `bend` turns one bone from its rest.
## The node's origin is the middle of the feet.

var bones := {}

func build(data: Dictionary, texture: Texture2D, height: float) -> void:
	var k := height / float(data["size"][1])
	var origin := Vector2(data["size"][0] * 0.5, data["size"][1])
	var skel := Skeleton2D.new()
	skel.name = "Skeleton"
	add_child(skel)
	var heads := {}
	var paths := {}  # bone name -> its path under the Skeleton2D, e.g. "hips/body/head"
	for b in data["bones"]:  # parents come before their children in rig.json
		var head: Vector2 = (Vector2(b["head"][0], b["head"][1]) - origin) * k
		var tail: Vector2 = (Vector2(b["tail"][0], b["tail"][1]) - origin) * k
		heads[b["name"]] = head
		paths[b["name"]] = b["name"] if b["parent"] == null else paths[b["parent"]] + "/" + b["name"]
		var bone := Bone2D.new()
		bone.name = b["name"]
		bone.set_autocalculate_length_and_angle(false)
		bone.set_length((tail - head).length())
		bone.set_bone_angle((tail - head).angle())
		bone.position = head if b["parent"] == null else head - heads[b["parent"]]
		(skel if b["parent"] == null else bones[b["parent"]]).add_child(bone)
		bone.rest = bone.transform
		bones[b["name"]] = bone
	var poly := Polygon2D.new()
	poly.name = "Mesh"
	poly.texture = texture
	var pts := PackedVector2Array()
	var uv := PackedVector2Array()
	for p in data["points"]:
		uv.append(Vector2(p[0], p[1]))
		pts.append((Vector2(p[0], p[1]) - origin) * k)
	poly.polygon = pts
	poly.uv = uv
	poly.internal_vertex_count = data["internal"]
	var tris := []
	for tri in data["triangles"]:
		tris.append(PackedInt32Array(tri))
	poly.polygons = tris
	add_child(poly)
	# Paths are written out rather than asked of get_path_to(), which needs the
	# nodes inside a scene tree; the headless test builds the rig outside one.
	poly.skeleton = NodePath("../Skeleton")
	for b in data["bones"]:
		poly.add_bone(NodePath(paths[b["name"]]), PackedFloat32Array(b["weights"]))

func bend(bone: String, degrees: float) -> void:
	bones[bone].rotation = deg_to_rad(degrees)
