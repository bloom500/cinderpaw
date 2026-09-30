class_name Bridge
extends Node
## The only door between the game and the app: JSON strings over
## window.postMessage. `decode` and `encode` are pure so the headless tests
## hold them to the contract; the app's side is emberBridge.ts.

signal started(best: int)
signal spark(kind: String)
signal ended(ok: bool)
signal paused(on: bool)

const KINDS: Array[String] = ["search", "read", "build", "other"]

var _on_message_cb  # a JavaScriptObject; the browser drops a callback nobody holds
## Everything the game has said, in order: what the headless tests read.
var sent: Array[Dictionary] = []

static func decode(text: String) -> Dictionary:
	var msg = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY or typeof(msg.get("type")) != TYPE_STRING:
		return {}
	match msg["type"]:
		"start":
			var best = msg.get("best")
			return {"type": "start", "best": maxi(0, int(best)) if typeof(best) in [TYPE_INT, TYPE_FLOAT] else 0}
		"spark":
			var kind = msg.get("kind")
			return {"type": "spark", "kind": kind if kind in KINDS else "other"}
		"end":
			return {"type": "end", "ok": typeof(msg.get("ok")) == TYPE_BOOL and msg["ok"]}
		"pause", "resume":
			return {"type": msg["type"]}
	return {}

static func encode(msg: Dictionary) -> String:
	return JSON.stringify(msg)

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_on_message_cb = JavaScriptBridge.create_callback(_on_message)
	JavaScriptBridge.get_interface("window").addEventListener("message", _on_message_cb)
	send({"type": "ready"})

func send(msg: Dictionary) -> void:
	sent.append(msg)
	if OS.has_feature("web"):
		# encode() gives JSON text; stringify it again to embed it as a JS string literal.
		JavaScriptBridge.eval("window.parent.postMessage(%s, window.location.origin)" % JSON.stringify(encode(msg)))

func _on_message(args: Array) -> void:
	var event = args[0]
	if str(event.origin) != str(JavaScriptBridge.eval("window.location.origin")):
		return
	receive(str(event.data))

func receive(text: String) -> void:
	var msg := decode(text)
	match msg.get("type", ""):
		"start":
			started.emit(msg["best"])
		"spark":
			spark.emit(msg["kind"])
		"end":
			ended.emit(msg["ok"])
		"pause":
			paused.emit(true)
		"resume":
			paused.emit(false)
