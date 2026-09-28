# Design sources for the 2026 rebrand

- `canvas/` is an export of the approved Design canvas "Cinderpaw UI final"
  (https://claude.ai/artifact/33TzhEqAGZjxuXJ1MPkXTN), taken 28 Sep 2026. One `.dc.html` file per
  artboard; `canvas.json` gives their titles. The short files (`Chat`, `ChatDark`, `HomeDark`,
  `Browser`, `SettingsLook`, `SettingsMemory`) import `Main` or `Settings` with different props, so
  read those two for the markup. They need the canvas runtime to render; read them as the source of
  sizes, colours, radii, spacing and copy. `assets/` holds the images they point at: the approved
  logo head (`logo-head.svg`, the same file as `frontend-react/src/assets/logo.svg`) and four clay
  mascot frames.
- `moodboard/` is Darius's input, AI-generated: five app boards (root), ten component boards
  (`Components/`) and seven flat mascot poses (`SVG/`, PNG files despite the folder name).

Rules for using them, from `docs/superpowers/specs/2026-09-27-app-ui-final-design.md`:
the spec decides behaviour, the canvas decides the look. The canvas is drawn in arbitrary pixel
sizes; the app keeps its nine-step type scale and icon sizes 12/14/16/20/28
(`frontend-react/src/test/scale.test.ts`), so map each canvas size to the nearest step.
The moodboards are inputs, not targets: anything fake in them (old model names, people photos,
Share buttons, permanent CPU meters) was ruled out in the spec.
