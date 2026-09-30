extends RefCounted

func run(t) -> bool:
	var main = load("res://main.tscn").instantiate()
	t.root.add_child(main)  # _ready runs; outside the web the Bridge stays quiet
	main.rng.seed = 7
	main.start(3)
	t.check("world: a started round is running", main.running and main.best == 3)
	main.add_burst("build")
	t.check("world: a build burst throws 6 sparks", main.sparks.size() == 6)
	var fire_before: float = main.rules.fire
	for i in 360:
		var chase: float = main.sparks[0]["p"].x if main.sparks.size() > 0 else -1.0
		main.step(1.0 / 60.0, {"mouse_x": chase})
	t.check("world: a spark reached by Cinderpaw feeds the fire", main.rules.caught >= 1 and main.rules.fire > fire_before)
	t.check("world: every spark is caught or has fallen", main.sparks.is_empty())
	main.end(true)
	t.check("world: the end stops the round and keeps the best", main.ended and not main.running and main.best >= 3)
	t.check("world: the end reports the score to the app", main.bridge.sent.back() == {"type": "score", "value": main.rules.score()})
	var esc := InputEventKey.new()
	esc.keycode = KEY_ESCAPE
	esc.pressed = true
	main._unhandled_input(esc)
	t.check("world: Esc inside the game asks the app to close it", main.bridge.sent.back() == {"type": "close"})
	main.add_burst("search")
	t.check("world: no sparks after the end", main.sparks.is_empty())
	main.start(0)
	for i in 50:
		main.add_burst("build")
	t.check("world: live sparks are capped", main.sparks.size() <= Rules.MAX_LIVE_SPARKS)
	main.cat.flinch()
	t.check("world: a flinch stuns Cinderpaw", main.cat.stunned > 0.0)
	main.queue_free()
	return true
