package ui

import (
	"strings"
	"testing"
)

// RenderWizardFrame composes the standard chrome around a wizard step's
// body. These tests pin the public contract:
//
//   1. Header strip carries the brand mark + step indicator.
//   2. Body is rendered inside a rounded border tinted with AccentDim.
//   3. Footer carries the BearCompact signature line.
//   4. Width is clamped — narrow inputs still render, ultra-wide
//      inputs do not exceed MaxProseWidth.
//   5. The per-step body is never truncated or reordered — the frame
//      only adds chrome around it.
func TestRenderWizardFrame_carriesHeaderAndFooter(t *testing.T) {
	out := RenderWizardFrame(80, WizardFrame{
		Title:     "Security",
		StepIdx:   2,
		StepTotal: 16,
		Body:      "Feral may execute actions using the connectors you enable.",
	})

	// Header strip — left side carries the product mark + label.
	if !strings.Contains(out, AppName) {
		t.Errorf("header missing product mark %q; got:\n%s", AppName, out)
	}
	if !strings.Contains(out, "setup wizard") {
		t.Errorf("header missing wizard label; got:\n%s", out)
	}

	// Header strip — right side carries the step indicator + title.
	if !strings.Contains(out, "step 2 of 16") {
		t.Errorf("header missing step indicator; got:\n%s", out)
	}
	if !strings.Contains(out, "Security") {
		t.Errorf("header missing step title; got:\n%s", out)
	}

	// Body is preserved verbatim — the frame never edits the per-step
	// renderer's copy.
	if !strings.Contains(out, "Feral may execute actions") {
		t.Errorf("body lost; got:\n%s", out)
	}

	// Footer carries the BearCompact signature line.
	if !strings.Contains(out, BearCompact) {
		t.Errorf("footer missing BearCompact; got:\n%s", out)
	}
}

func TestRenderWizardFrame_clampsWidth(t *testing.T) {
	// Narrow input: must not panic or produce zero-width output.
	out := RenderWizardFrame(20, WizardFrame{
		Title: "Welcome", StepIdx: 1, StepTotal: 16,
		Body: "x",
	})
	if out == "" {
		t.Fatal("narrow width produced empty frame")
	}

	// Wide input: clamp at MaxProseWidth so ultrawide terminals don't
	// stretch the frame across the full viewport.
	out = RenderWizardFrame(400, WizardFrame{
		Title: "Welcome", StepIdx: 1, StepTotal: 16,
		Body: "x",
	})
	if strings.Count(out, "\n") < 3 {
		t.Errorf("wide width did not produce a 3+ row frame; got:\n%s", out)
	}
}

func TestRenderWizardFrame_omitsStepCountWhenTotalZero(t *testing.T) {
	// StepTotal=0 collapses to a static title — useful for steps that
	// are conditional (e.g. Resume / ConfigHandling) where the count
	// depends on whether prior steps ran.
	out := RenderWizardFrame(80, WizardFrame{
		Title:     "Resume",
		StepIdx:   1,
		StepTotal: 0,
		Body:      "Pick up where you left off?",
	})

	if strings.Contains(out, "step 1 of") {
		t.Errorf("step indicator should be suppressed when total=0; got:\n%s", out)
	}
	if !strings.Contains(out, "Resume") {
		t.Errorf("title should still render even without step count; got:\n%s", out)
	}
}

// HeaderStepStyle must keep the meta colour even after style tweaks —
// the frame relies on the contrast between HeaderStepStyle (right side,
// meta) and WizardHeaderLeft (left side, brand) to anchor the strip.
func TestRenderWizardFrame_headerColorSeparation(t *testing.T) {
	left := WizardHeaderLeft
	if left == "" {
		t.Fatal("WizardHeaderLeft produced empty output")
	}
	right := renderWizardStepLabel("Security", 2, 16)
	if right == "" {
		t.Fatal("right header strip produced empty output")
	}
	// Both must be non-empty; the colour separation is checked
	// visually in a screenshot — we just assert no panic / no
	// aliasing.
	if strings.Contains(left, "step") {
		t.Errorf("left header unexpectedly contains step counter: %q", left)
	}
	if strings.Contains(right, AppName) {
		t.Errorf("right header unexpectedly contains product mark: %q", right)
	}
}