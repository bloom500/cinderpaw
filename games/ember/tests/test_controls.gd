extends RefCounted
## How Cinderpaw answers the keys and the mouse. "Clunky" was: full speed or
## nothing, a forced hop on every step, a mouse chase that shook at the target,
## and a jump lost when pressed a moment before landing.

const DT := 1.0 / 60.0

func _cat(t) -> Cinderpaw:
	var cat := Cinderpaw.new()
	t.root.add_child(cat)
	cat.position = Vector2(300, Cinderpaw.GROUND)
	return cat

func _run(cat: Cinderpaw, seconds: float, input: Dictionary) -> void:
	for i in int(seconds / DT):
		cat.step(DT, input)

func run(t) -> bool:
	var cat := _cat(t)
	_run(cat, 0.15, {"right": true})
	t.check("controls: holding right reaches full speed quickly", cat.vel.x >= Cinderpaw.SPEED * 0.95)
	_run(cat, 0.15, {})
	t.check("controls: letting go stops after a short slide", cat.vel.x == 0.0)

	var grounded := true
	for i in 60:
		cat.step(DT, {"left": true})
		grounded = grounded and cat.position.y == Cinderpaw.GROUND
	t.check("controls: walking keeps the feet on the ground", grounded)

	cat.position = Vector2(300, Cinderpaw.GROUND)
	cat.vel = Vector2.ZERO
	var flips := 0
	var last := 0.0
	for i in 120:
		cat.step(DT, {"mouse_x": 500.0})
		if last != 0.0 and signf(cat.vel.x) != 0.0 and signf(cat.vel.x) != signf(last):
			flips += 1
		if cat.vel.x != 0.0:
			last = cat.vel.x
	t.check("controls: the mouse is followed without shaking", absf(cat.position.x - 500.0) < 2.0 and flips == 0)

	cat.position = Vector2(300, Cinderpaw.GROUND - 4.0)
	cat.vel = Vector2(0, 200)
	cat.step(DT, {"jump": true})
	var jumped := false
	for i in 20:
		cat.step(DT, {})
		jumped = jumped or cat.vel.y < -100.0
	t.check("controls: a jump pressed just before landing still happens", jumped)

	var peaks := []
	for hold in [1, 40]:
		cat.position = Vector2(300, Cinderpaw.GROUND)
		cat.vel = Vector2.ZERO
		_run(cat, 0.3, {})
		var top := Cinderpaw.GROUND
		for i in 60:
			cat.step(DT, {"jump": i < hold})
			top = minf(top, cat.position.y)
		peaks.append(Cinderpaw.GROUND - top)
	t.check("controls: a tap jumps lower than a hold", peaks[1] > peaks[0] + 15.0)
	cat.free()
	return true
