# Mascot v3: the clay character, built from code

`build_character.py` is the source of truth. It builds the whole character in Blender, fuses the
clay, rigs it, renders a turnaround and writes `cinderpaw-v3.blend` (read-only: rebuild instead of
saving over it; keep a hand edit with File > Save As).

    blender --background --factory-startup --python build_character.py -- --res 900
    blender --background --factory-startup --python build_character.py -- --res 700 --pose-test

Needs Blender 5.2 (the SDF grid nodes that fuse the clay). About 30 seconds.

The app's mascot loops (ANIMS in `build_character.py`, after the expression board) come from the
built .blend in two steps, then land next to the renderer as `sheet.webp` + `frames.ts`:

    blender --background --factory-startup --python render_frames.py     # frames/ (not committed)
    python pack_frames.py                                                 # marks, sheet, frame index

What it reads, all committed here:
- `fit.json` - part sizes fitted to the board's outlines by `fit_board.py`
- `logo/logo-paths.json` - the approved logo; its visor outline shapes the character's visor
- `refs/` - the board's straight views, pinned as see-through references in Blender

The fitting and checking scripts (`fit_board.py`, `measure_horn.py`, `make_refs.py`,
`compare_board.py`, `overlay.py`, `logo/trace_logo.py`) read the moodboard PNGs, which live
outside the repo (`C:\Users\Darius\Desktop\Cinderpaw Moodboard\`). They only need re-running if
the board changes.
