extends Node2D
## One round of the campfire. Sparks come from the agent's tool calls through
## the Bridge, rain falls between bursts, Cinderpaw catches. Everything moves
## in `step(dt, input)`, so the headless tests play the world without a window.

const W := 800.0
const H := 240.0
const GROUND := Cinderpaw.GROUND
const FIRE_X := 70.0
const SPAWN_MIN_X := 150.0
const SPAWN_MAX_X := 780.0
const RAIN_GAP := Vector2(1.4, 3.0)
const RAIN_SPEED := 220.0
const COLORS := {"search": Color("#5E8BE0"), "read": Color("#F2B54A"), "build": Color("#F0506E"), "other": Color("#FF8A3D")}

var rules := Rules.new()
var rng := RandomNumberGenerator.new()
var sparks: Array[Dictionary] = []
var drops: Array[Vector2] = []
var rain_in := 2.0
var running := false
var ended := false
var ok := true
var best := 0
var flare := 0.0
var time := 0.0
var _mouse_x := -1.0
var _clicked := false

@onready var bridge: Bridge = $Bridge
@onready var cat: Cinderpaw = $Cinderpaw

func _ready() -> void:
	rng.randomize()
	bridge.started.connect(start)
	bridge.spark.connect(add_burst)
	bridge.ended.connect(end)
	bridge.paused.connect(func(on: bool) -> void: get_tree().paused = on)

func start(p_best: int) -> void:
	rules = Rules.new()
	sparks.clear()
	drops.clear()
	best = p_best
	running = true
	ended = false
	flare = 0.0

func add_burst(kind: String) -> void:
	if not running:
		return
	for i in rules.burst_size(kind, sparks.size()):
		sparks.append({
			"p": Vector2(rng.randf_range(SPAWN_MIN_X, SPAWN_MAX_X), -rng.randf_range(0.0, 80.0)),
			"v": Vector2(rng.randf_range(-25.0, 25.0), rng.randf_range(60.0, 110.0)),
			"kind": kind,
		})

func end(p_ok: bool) -> void:
	if ended:
		return
	running = false
	ended = true
	ok = p_ok
	sparks.clear()
	drops.clear()
	best = maxi(best, rules.score())
	bridge.send({"type": "score", "value": rules.score()})

func fire_radius() -> float:
	return 10.0 + rules.fire * 0.45

func step(dt: float, input: Dictionary) -> void:
	time += dt
	flare = maxf(0.0, flare - dt)
	cat.step(dt, input)
	for i in range(sparks.size() - 1, -1, -1):
		var s: Dictionary = sparks[i]
		s["p"] += s["v"] * dt
		if cat.catches(s["p"]):
			if rules.catch_spark():
				flare = 1.2
			sparks.remove_at(i)
		elif s["p"].y > GROUND:
			rules.miss_spark()
			sparks.remove_at(i)
	if running:
		rain_in -= dt
		if rain_in <= 0.0 and sparks.is_empty():  # rain falls between bursts, not during them
			rain_in = rng.randf_range(RAIN_GAP.x, RAIN_GAP.y)
			drops.append(Vector2(rng.randf_range(20.0, SPAWN_MAX_X), -10.0))
	for i in range(drops.size() - 1, -1, -1):
		drops[i].y += RAIN_SPEED * dt
		var d := drops[i]
		if absf(d.x - FIRE_X) < fire_radius() and d.y > GROUND - fire_radius() * 1.6:
			rules.rain_on_fire()
			drops.remove_at(i)
		elif cat.catches(d):
			cat.flinch()
			drops.remove_at(i)
		elif d.y > GROUND:
			drops.remove_at(i)

func _process(dt: float) -> void:
	step(dt, {
		"left": Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A),
		"right": Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D),
		"jump": _clicked or Input.is_key_pressed(KEY_SPACE) or Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W),
		"mouse_x": _mouse_x,
	})
	_clicked = false
	queue_redraw()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		_mouse_x = get_local_mouse_position().x
	elif event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_clicked = true
	elif event is InputEventKey and event.pressed:
		if event.keycode == KEY_ESCAPE:
			bridge.send({"type": "close"})  # focus is in the game, so the app cannot see this key
		elif event.keycode in [KEY_LEFT, KEY_RIGHT, KEY_A, KEY_D]:
			_mouse_x = -1.0  # the keys take over from the mouse

func _draw() -> void:
	draw_rect(Rect2(0, 0, W, H), Color("#241a16"))
	draw_rect(Rect2(0, GROUND, W, H - GROUND), Color("#3a2a22"))
	var r := fire_radius() * (1.0 + 0.06 * sin(time * 9.0)) + flare * 14.0
	if ended and not ok:
		r *= 0.6  # the agent stopped: the fire dims quietly, no losing screen
	draw_rect(Rect2(FIRE_X - 26, GROUND - 6, 52, 8), Color("#6B4A33"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.55), r, Color("#F45B20"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.45), r * 0.62, Color("#FFB347"))
	draw_circle(Vector2(FIRE_X, GROUND - r * 0.35), r * 0.3, Color("#FFF1C1"))
	for s in sparks:
		draw_circle(s["p"], 4.0, COLORS[s["kind"]])
	for d in drops:
		draw_line(d, d + Vector2(0, 9), Color("#8FD0FF"), 2.0)
	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(W - 212, 26), "Fire %d   Best %d" % [rules.score(), maxi(best, rules.score())], HORIZONTAL_ALIGNMENT_RIGHT, 200, 16, Color("#F6EFE6"))
	if ended:
		var line := ("Your fire reached %d" if ok else "The agent stopped. Your fire: %d") % rules.score()
		draw_string(font, Vector2(0, 112), line, HORIZONTAL_ALIGNMENT_CENTER, W, 22, Color("#FFF1C1"))
		if ok:
			for i in 5:  # fireworks
				var k := fmod(time * 0.8 + i * 0.2, 1.0)
				var c := Vector2(FIRE_X + 90 + i * 130, 60 + (i % 2) * 30)
				var col: Color = COLORS.values()[i % 4]
				col.a = 1.0 - k
				draw_arc(c, 6 + k * 40, 0, TAU, 24, col, 2.0)
	elif not running:
		draw_string(font, Vector2(0, 120), "Waiting for the agent…", HORIZONTAL_ALIGNMENT_CENTER, W, 18, Color("#F6EFE6"))
