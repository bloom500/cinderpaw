class_name Cinderpaw
extends Node2D
## The player: hops while walking, jumps, catches with its paws out, flinches
## in the rain. Drawn from the character art (art/cheer.png); Task 10 swaps
## the flat drawing for a bone rig.

const GROUND := 214.0
const SPEED := 240.0
const JUMP_V := -340.0
const GRAVITY := 900.0
const FALL_GRAVITY := 1500.0  # falls faster than it rises: snappier, less floaty
const JUMP_CUT := 0.45  # letting go of jump early keeps this much of the rise
const ACCEL := 2600.0
const DECEL := 3200.0
const FOLLOW := 7.0  # mouse chase: speed per pixel of distance, so it eases in instead of shaking
const JUMP_BUFFER := 0.12  # a jump pressed this long before landing still happens
const COYOTE := 0.08  # and one pressed this long after walking off the ground
const MIN_X := 150.0
const MAX_X := 780.0
const CATCH_R := 30.0
const HEIGHT := 76.0

var vel := Vector2.ZERO
var stunned := 0.0
var squash := 1.0
var squash_v := 0.0
var facing := 1.0
var tex_normal: Texture2D = preload("res://art/cheer.png")
var tex_flinch: Texture2D = preload("res://art/surprised.png")
var rig: Rig
var _t := 0.0
var _horn := 0.0
var _horn_v := 0.0
var _buffer := 0.0
var _coyote := 0.0
var _held := false

func _ready() -> void:
	rig = Rig.new()
	rig.build(JSON.parse_string(FileAccess.get_file_as_string("res://rig/rig.json")), tex_normal, HEIGHT)
	add_child(rig)

func step(dt: float, input: Dictionary) -> void:
	var dir := int(input.get("right", false)) - int(input.get("left", false))
	var mx: float = input.get("mouse_x", -1.0)
	var target := dir * SPEED
	if dir == 0 and mx >= 0.0:
		target = clampf((mx - position.x) * FOLLOW, -SPEED, SPEED)
		if absf(mx - position.x) < 1.0:
			target = 0.0
	var jump: bool = input.get("jump", false)
	if stunned > 0.0:
		stunned -= dt
		target = 0.0
		jump = false
	if absf(target) > 1.0:
		facing = signf(target)
	var rate := ACCEL if absf(target) > absf(vel.x) and signf(target) == signf(vel.x) or vel.x == 0.0 else DECEL
	vel.x = move_toward(vel.x, target, rate * dt)
	var grounded := position.y >= GROUND
	_coyote = COYOTE if grounded else maxf(0.0, _coyote - dt)
	_buffer = JUMP_BUFFER if jump and not _held else maxf(0.0, _buffer - dt)
	if _buffer > 0.0 and _coyote > 0.0:
		vel.y = JUMP_V
		squash = 0.8
		_buffer = 0.0
		_coyote = 0.0
	elif not jump and vel.y < 0.0 and _held:
		vel.y *= JUMP_CUT  # a tap is a small hop, a hold is the full jump
	_held = jump
	vel.y += (FALL_GRAVITY if vel.y > 0.0 else GRAVITY) * dt
	position += vel * dt
	if position.y > GROUND:
		squash = 0.75 if vel.y > 200.0 else minf(squash, 0.92)  # a hard landing squashes more
		position.y = GROUND
		vel.y = 0.0
	position.x = clampf(position.x, MIN_X, MAX_X)
	squash_v += (-(squash - 1.0) * 220.0 - squash_v * 14.0) * dt  # springs back with a little wobble
	squash += squash_v * dt
	# The rig follows the body a beat late: horns and arms flop on the hops, the tail swings.
	_t += dt
	_horn_v += (-(_horn - clampf(-vel.y * 0.03, -12.0, 12.0)) * 90.0 - _horn_v * 8.0) * dt
	_horn += _horn_v * dt
	rig.visible = stunned <= 0.0
	rig.scale = Vector2(facing / sqrt(maxf(squash, 0.4)), squash)
	# The walk bounces the drawing only: the feet (and the catch zone) stay on the ground.
	rig.position.y = -absf(sin(_t * 14.0)) * 4.0 * absf(vel.x) / SPEED if position.y >= GROUND else 0.0
	rig.bend("head", clampf(vel.x * 0.02, -6.0, 6.0))
	rig.bend("horn_l", -_horn)
	rig.bend("horn_r", _horn)
	rig.bend("arm_l", -_horn * 0.8 + sin(_t * 6.0) * 4.0)
	rig.bend("arm_r", _horn * 0.8 - sin(_t * 6.0) * 4.0)
	rig.bend("tail", sin(_t * 5.0) * 10.0 - vel.x * 0.03)
	queue_redraw()

func catches(p: Vector2) -> bool:
	return p.distance_to(position + Vector2(0, -HEIGHT * 0.7)) < CATCH_R

func flinch() -> void:
	stunned = 0.6
	squash = 1.2

func _draw() -> void:
	if stunned <= 0.0:
		return  # the rig draws Cinderpaw
	var w := HEIGHT * tex_flinch.get_width() / tex_flinch.get_height()
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(facing / sqrt(maxf(squash, 0.4)), squash))
	draw_texture_rect(tex_flinch, Rect2(-w / 2.0, -HEIGHT, w, HEIGHT), false)
