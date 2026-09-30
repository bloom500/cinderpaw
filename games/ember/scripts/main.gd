extends Node2D
## Placeholder world: counts sparks and reports the count as the score.

var sparks := 0
@onready var bridge: Bridge = $Bridge

func _ready() -> void:
	bridge.spark.connect(func(_kind: String) -> void:
		sparks += 1
		queue_redraw())
	bridge.ended.connect(func(_ok: bool) -> void: bridge.send({"type": "score", "value": sparks}))

func _draw() -> void:
	draw_rect(Rect2(0, 0, 800, 240), Color("#241a16"))
	draw_circle(Vector2(70, 200), 12 + sparks * 2, Color("#F45B20"))
