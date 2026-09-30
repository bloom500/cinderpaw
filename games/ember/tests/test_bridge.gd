extends RefCounted

func run(t) -> bool:
	t.check("bridge: a spark keeps a known kind", Bridge.decode('{"type":"spark","kind":"read"}') == {"type": "spark", "kind": "read"})
	t.check("bridge: a spark of an unknown kind becomes 'other'", Bridge.decode('{"type":"spark","kind":"laser"}')["kind"] == "other")
	t.check("bridge: start carries the best score", Bridge.decode('{"type":"start","best":42}')["best"] == 42)
	t.check("bridge: a negative or missing best is 0", Bridge.decode('{"type":"start","best":-5}')["best"] == 0 and Bridge.decode('{"type":"start"}')["best"] == 0)
	t.check("bridge: end is ok only when ok is true", Bridge.decode('{"type":"end","ok":true}')["ok"] == true and Bridge.decode('{"type":"end","ok":"yes"}')["ok"] == false)
	t.check("bridge: pause and resume pass through", Bridge.decode('{"type":"pause"}') == {"type": "pause"} and Bridge.decode('{"type":"resume"}') == {"type": "resume"})
	t.check("bridge: garbage decodes to nothing", Bridge.decode("not json") == {} and Bridge.decode('{"kind":"read"}') == {} and Bridge.decode("[1,2]") == {})
	t.check("bridge: encode is JSON the app can parse", JSON.parse_string(Bridge.encode({"type": "score", "value": 12})) == {"type": "score", "value": 12.0})
	return true
