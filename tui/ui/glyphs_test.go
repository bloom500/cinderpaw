package ui

import "testing"

func TestPickDefaultsToUnicode(t *testing.T) {
	env := map[string]string{}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "⏺" {
		t.Fatalf("default ToolMark = %q, want ⏺", g.ToolMark)
	}
}

func TestPickASCIIViaEnv(t *testing.T) {
	env := map[string]string{"FERAL_ASCII": "1"}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "*" {
		t.Fatalf("FERAL_ASCII=1 ToolMark = %q, want *", g.ToolMark)
	}
	if g.Cursor != "|" || g.Prompt != ">" {
		t.Fatalf("ascii set not fully applied: %+v", g)
	}
}

func TestPickASCIIViaDumbTerm(t *testing.T) {
	env := map[string]string{"TERM": "dumb"}
	g := pickWith(func(k string) string { return env[k] })
	if g.ToolMark != "*" {
		t.Fatalf("TERM=dumb ToolMark = %q, want *", g.ToolMark)
	}
}

// noAsciiByte asserts every rune in every field (and every spinner frame)
// of the Ascii set is < 128 — the automatable half of spec §22 acceptance
// #19 (FERAL_ASCII=1 emits zero non-ASCII bytes).
func TestAsciiSetIsPureASCII(t *testing.T) {
	check := func(name, s string) {
		for _, r := range s {
			if r > 127 {
				t.Fatalf("Ascii.%s contains non-ASCII rune %q", name, r)
			}
		}
	}
	check("Prompt", Ascii.Prompt)
	check("ToolMark", Ascii.ToolMark)
	check("Result", Ascii.Result)
	check("ThinkClosed", Ascii.ThinkClosed)
	check("ThinkOpen", Ascii.ThinkOpen)
	check("On", Ascii.On)
	check("Off", Ascii.Off)
	check("Event", Ascii.Event)
	check("Spark", Ascii.Spark)
	check("OK", Ascii.OK)
	check("Err", Ascii.Err)
	check("Running", Ascii.Running)
	check("Down", Ascii.Down)
	check("Up", Ascii.Up)
	check("Ellipsis", Ascii.Ellipsis)
	check("Cursor", Ascii.Cursor)
	for i, f := range Ascii.Spinner {
		check("Spinner["+string(rune('0'+i))+"]", f)
	}
}
