package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestToolViewerPositionIndicator_P2_4 — when the tool list exceeds the
// visible cap (12), the header line shows "N/Total" so the user knows
// how deep they are. Below the cap, no indicator (just the count).
func TestToolViewerPositionIndicator_P2_4(t *testing.T) {
	t.Run("below cap shows just count", func(t *testing.T) {
		a := newTestApp()
		a.ToolViewer.Show = true
		a.ToolViewer.Rows = make([]ToolViewerRow, 5)
		a.ToolViewer.Idx = 2
		out := stripAnsi(a.renderToolViewerOverlay(""))
		if !strings.Contains(out, "5 calls") {
			t.Fatalf("header should contain '5 calls', got:\n%s", out)
		}
		if strings.Contains(out, "3/5") {
			t.Fatalf("header should NOT contain position indicator when rows≤cap, got:\n%s", out)
		}
	})

	t.Run("above cap shows position", func(t *testing.T) {
		a := newTestApp()
		a.ToolViewer.Show = true
		a.ToolViewer.Rows = make([]ToolViewerRow, 27)
		a.ToolViewer.Idx = 2 // 3rd row, 0-based
		out := stripAnsi(a.renderToolViewerOverlay(""))
		if !strings.Contains(out, "27 calls") {
			t.Fatalf("header should contain '27 calls', got:\n%s", out)
		}
		if !strings.Contains(out, "3/27") {
			t.Fatalf("header should contain '3/27' position, got:\n%s", out)
		}
	})
}

// TestModelPickerPositionIndicator_P2_4 — same contract for the model
// picker overlay: position shows in the header only when rows > cap.
func TestModelPickerPositionIndicator_P2_4(t *testing.T) {
	t.Run("below cap shows just count", func(t *testing.T) {
		a := newTestApp()
		a.ModelPicker.Show = true
		a.ModelPicker.Rows = make([]ModelEntry, 5)
		a.ModelPicker.Idx = 1
		out := stripAnsi(a.renderModelPickerOverlay(""))
		if !strings.Contains(out, "5 available") {
			t.Fatalf("header should contain '5 available', got:\n%s", out)
		}
		if strings.Contains(out, "/5") {
			t.Fatalf("header should NOT contain position indicator when rows≤cap, got:\n%s", out)
		}
	})

	t.Run("above cap shows position", func(t *testing.T) {
		a := newTestApp()
		a.ModelPicker.Show = true
		a.ModelPicker.Rows = make([]ModelEntry, 27)
		a.ModelPicker.Idx = 4 // 5th row
		out := stripAnsi(a.renderModelPickerOverlay(""))
		if !strings.Contains(out, "27 available") {
			t.Fatalf("header should contain '27 available', got:\n%s", out)
		}
		if !strings.Contains(out, "5/27") {
			t.Fatalf("header should contain '5/27' position, got:\n%s", out)
		}
	})
}

// TestToolViewerPreviewPaging_P2_4 — when the expanded preview is taller
// than the visible cap (16 lines), PgUp/PgDn adjusts PreviewOffset.
// Offset clamps to [0, total-cap].
func TestToolViewerPreviewPaging_P2_4(t *testing.T) {
	a := newTestApp()
	a.ToolViewer.Show = true
	a.ToolViewer.Expanded = true
	// 40-line preview so paging is meaningful.
	var lines []string
	for i := 0; i < 40; i++ {
		lines = append(lines, "line")
	}
	a.ToolViewer.Rows = []ToolViewerRow{{
		Call: ToolCall{Name: "demo", Status: ToolDone, Preview: strings.Join(lines, "\n")},
	}}
	a.ToolViewer.Idx = 0

	// Initial render: offset 0, lines 1..16 shown.
	if a.ToolViewer.PreviewOffset != 0 {
		t.Fatalf("initial PreviewOffset should be 0, got %d", a.ToolViewer.PreviewOffset)
	}

	// PgDn → advance by pageLines (16). New offset = 16, lines 17..32.
	a.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	if a.ToolViewer.PreviewOffset != 16 {
		t.Fatalf("after PgDn offset = %d, want 16", a.ToolViewer.PreviewOffset)
	}

	// PgDn again → offset clamped to total-cap = 40-16 = 24. With offset
	// 24 the visible window is lines 25..40 (last page, 16 lines).
	a.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	if a.ToolViewer.PreviewOffset != 24 {
		t.Fatalf("after second PgDn offset = %d, want 24 (clamped to total-cap=24)", a.ToolViewer.PreviewOffset)
	}

	// PgDn past the end → offset stays clamped at 24.
	a.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	if a.ToolViewer.PreviewOffset != 24 {
		t.Fatalf("PgDn past end should clamp at 24, got %d", a.ToolViewer.PreviewOffset)
	}

	// PgUp → back to 8 (24 - 16).
	a.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	if a.ToolViewer.PreviewOffset != 8 {
		t.Fatalf("after PgUp offset = %d, want 8", a.ToolViewer.PreviewOffset)
	}

	// PgUp × 2 → 0, clamped at 0 (8 - 16 would be -8 → clamped to 0).
	a.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	a.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	if a.ToolViewer.PreviewOffset != 0 {
		t.Fatalf("PgUp past start should clamp at 0, got %d", a.ToolViewer.PreviewOffset)
	}

	// Render with a tall preview should now show a paging hint.
	out := stripAnsi(a.renderToolViewerOverlay(""))
	if !strings.Contains(out, "lines 1-16 of 40") {
		t.Fatalf("paged preview should show 'lines 1-16 of 40', got:\n%s", out)
	}
}
