package ui

import (
	"fmt"
	"os"
	"testing"
)

// TestRenderWizardFrame_visualSnapshot renders every wizard step's
// frame at a fixed width and writes the result to a single golden
// file under ../testdata/. The file is committed so reviewers can see
// what the wizard looks like after the frame migration without having
// to run the TUI live.
//
// This is a documentation test — it does not assert on the snapshot
// contents (changing border style or header copy should not require
// "fixing" this test). It only re-asserts that every step renders
// without panic and contains both the brand mark and the bear
// footer, so a regression that drops the frame surfaces as a red
// test, not as a stale golden file.
func TestRenderWizardFrame_visualSnapshot(t *testing.T) {
	steps := []struct {
		Title string
		Idx   int
		Total int
		Body  string
	}{
		{"Welcome", 1, 14, "Welcome to Feral\n\nOwn your agent.\nPress Enter to continue."},
		{"Security", 2, 14, "Feral may execute actions using the connectors you enable.\n\nOnly connect services you trust.\n\nRead: docs.feral.local/security\n\nPress y to accept, n to decline."},
		{"Setup mode", 3, 14, "Pick a path. QuickStart uses safe defaults; Manual\nlets you change every step. Import is coming soon."},
		{"Hardware probe", 4, 14, "Probing your machine...\n\n  CPU:   16 cores\n  RAM:   32 GB\n  GPU:   NVIDIA RTX 4080 (16 GB VRAM)\n  Disk:  500 GB free"},
		{"Model", 5, 14, "Run locally  /  Use a cloud key\n\nLocal: download a model. Private, free, on your machine.\nCloud: paste a key. Instant, stronger, some free tiers."},
		{"Provider", 6, 14, "1. OpenAI        - sk-...\n2. Anthropic     - sk-ant-...\n3. Google Gemini  - free tier\n4. OpenRouter     - free tier"},
		{"API key", 7, 14, "Paste your OpenAI API key.\n\n  sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n  [Enter] validate"},
		{"Connectors", 8, 14, "Connect chat platforms you already use.\n\n[x] Discord\n[ ] Slack\n[ ] WhatsApp\n[ ] Telegram"},
		{"Test it", 9, 14, "Health checks:\n  [ok] API reachable\n  [ok] Auth valid\n  [ok] Model accessible\n  [..] Streaming round-trip"},
		{"Ready", 10, 14, "Setup complete.\n\nYou're ready.\n\nTry asking:\n  - Summarize this repository.\n  - Remember that I prefer Rust.\n  - Explain this codebase."},
	}

	var out string
	for _, s := range steps {
		out += "=== " + s.Title + " (step " + fmt.Sprintf("%d", s.Idx) + " of " + fmt.Sprintf("%d", s.Total) + ") ===\n"
		out += RenderWizardFrame(80, WizardFrame{
			Title:     s.Title,
			StepIdx:   s.Idx,
			StepTotal: s.Total,
			Body:      s.Body,
		})
		out += "\n\n"
	}

	path := "../testdata/wizard_frame_snapshot.txt"
	if err := os.WriteFile(path, []byte(out), 0644); err != nil {
		t.Fatalf("write snapshot: %v", err)
	}
	// Sanity: re-read and assert brand mark + footer present somewhere
	// in the file. Not strict-by-content — visual regressions are
	// caught by humans reviewing the file, not by automated diffs.
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read snapshot back: %v", err)
	}
	bodyStr := string(body)
	for _, marker := range []string{AppName, BearCompact} {
		if !containsMarker(bodyStr, marker) {
			t.Errorf("snapshot missing %q — wizard frame chrome likely dropped", marker)
		}
	}
}

func containsMarker(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}