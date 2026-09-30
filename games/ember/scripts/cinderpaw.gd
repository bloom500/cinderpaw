class_name Cinderpaw
extends Node2D
## The player: hops while walking, jumps, catches with its paws out, flinches
## in the rain. Drawn from the character art (art/cheer.png); Task 10 swaps
## the flat drawing for a bone rig.

const GROUND := 214.0
const SPEED := 240.0
const HOP_V := -120.0
const JUMP_V := -320.0
const GRAVITY := 900.0
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

func step(dt: float, input: Dictionary) -> void:
	var dir := int(input.get("right", false)) - int(input.get("left", false))
	var mx: float = input.get("mouse_x", -1.0)
	if dir == 0 and mx >= 0.0 and absf(mx - position.x) > 8.0:
		dir = 1 if mx > position.x else -1
	if stunned > 0.0:
		stunned -= dt
		dir = 0
	if dir != 0:
		facing = float(dir)
	vel.x = dir * SPEED
	if position.y >= GROUND:
		if input.get("jump", false) and stunned <= 0.0:
			vel.y = JUMP_V
			squash = 0.8
		elif dir != 0:
			vel.y = HOP_V
	vel.y += GRAVITY * dt
	position += vel * dt
	if position.y > GROUND:
		squash = 0.75 if vel.y > 200.0 else minf(squash, 0.92)  # a hard landing squashes more
		position.y = GROUND
		vel.y = 0.0
	position.x = clampf(position.x, MIN_X, MAX_X)
	squash_v += (-(squash - 1.0) * 220.0 - squash_v * 14.0) * dt  # springs back with a little wobble
	squash += squash_v * dt
	queue_redraw()

func catches(p: Vector2) -> bool:
	return p.distance_to(position + Vector2(0, -HEIGHT * 0.7)) < CATCH_R

func flinch() -> void:
	stunned = 0.6
	squash = 1.2

func _draw() -> void:
	var tex := tex_flinch if stunned > 0.0 else tex_normal
	var w := HEIGHT * tex.get_width() / tex.get_height()
	draw_set_transform(Vector2.ZERO, 0.0, Vector2(facing / sqrt(maxf(squash, 0.4)), squash))
	draw_texture_rect(tex, Rect2(-w / 2.0, -HEIGHT, w, HEIGHT), false)
