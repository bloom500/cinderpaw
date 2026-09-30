extends SceneTree
## Headless checks for the campfire game:
##   "$CINDERPAW_GODOT" --headless --path games/ember --import
##   "$CINDERPAW_GODOT" --headless --path games/ember -s res://tests/run_tests.gd
## Prints PASS/FAIL per check; exits 1 when any check fails or a suite stops
## early (every suite's run() ends with `return true`), 2 when one hung. A script error aborts _initialize before quit() and would leave
## Godot idling forever (a CI job hung for hours), so a watchdog ends the run.

const SUITES := ["res://tests/test_bridge.gd", "res://tests/test_rules.gd", "res://tests/test_world.gd", "res://tests/test_rig.gd", "res://tests/test_controls.gd"]
const WATCHDOG_S := 20.0
var failed := 0

func check(name: String, ok: bool) -> void:
	print(("PASS  " if ok else "FAIL  ") + name)
	if not ok:
		failed += 1

func _initialize() -> void:
	create_timer(WATCHDOG_S).timeout.connect(func() -> void:
		print("FAIL  a suite crashed or hung (see the error above)")
		quit(2))
	# Suites run once the tree is live: a node a suite adds to root gets its
	# _ready (and its @onready vars) then, not during _initialize.
	process_frame.connect(_run_suites, CONNECT_ONE_SHOT)

func _run_suites() -> void:
	for path in SUITES:
		var suite = load(path)
		if suite == null or not suite.can_instantiate():
			check("load " + path, false)
			continue
		# A runtime error aborts run() and it returns without `true`: that suite
		# did not finish, and its remaining checks never ran.
		if suite.new().run(self) != true:
			check("finish " + path, false)
	print("%d failed" % failed)
	quit(1 if failed > 0 else 0)
