extends RefCounted

func run(t) -> bool:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://rig/rig.json"))
	t.check("rig: rig.json loads", typeof(data) == TYPE_DICTIONARY)
	var n: int = data["points"].size()
	var sums_ok := true
	for i in n:
		var s := 0.0
		for b in data["bones"]:
			s += b["weights"][i]
		sums_ok = sums_ok and absf(s - 1.0) < 0.01
	t.check("rig: every vertex's weights sum to 1", sums_ok)
	var tip := Vector2(data["bones"][7]["tail"][0], data["bones"][7]["tail"][1])  # the tail's tip
	var nearest := 0
	for i in n:
		if Vector2(data["points"][i][0], data["points"][i][1]).distance_to(tip) < Vector2(data["points"][nearest][0], data["points"][nearest][1]).distance_to(tip):
			nearest = i
	t.check("rig: the tail's tip hangs on the tail bone, not the head", data["bones"][7]["weights"][nearest] > data["bones"][2]["weights"][nearest])
	var rig := Rig.new()
	rig.build(data, preload("res://art/cheer.png"), 76.0)
	t.check("rig: builds every bone", rig.bones.size() == data["bones"].size())
	var poly: Polygon2D = rig.get_node("Mesh")
	t.check("rig: the mesh carries a weight table per bone", poly.get_bone_count() == data["bones"].size())
	rig.bend("tail", 20.0)
	t.check("rig: bend turns the bone", is_equal_approx(rig.bones["tail"].rotation, deg_to_rad(20.0)))
	rig.free()
	return true
