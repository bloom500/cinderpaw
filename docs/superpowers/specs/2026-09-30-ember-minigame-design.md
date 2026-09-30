# Ember: the campfire mini-game, design

Status: designed with Darius in chat on 30 Sep 2026; this file is for his review.

## Goal

While the agent works on a long task, the user can, if they want to, play a short game fed by what
the agent is actually doing. It never interrupts and never asks. It is also the testbed for a
bone-animated mascot: if Cinderpaw looks good moving here, the app's mascot may follow.

## Decisions (Darius, 30 Sep)

- **Concept:** "Focul lui Cinderpaw". Cinderpaw catches sparks and keeps a campfire going.
- **Offer:** a small campfire icon appears next to the mascot once a task has run for 15 s. No
  text, no popup; a click opens the game. A Settings toggle hides it for good. On by default,
  because it is only an icon.
- **Place:** a panel above the composer, as wide as the chat and about a quarter of the window
  tall. The answer stays visible above it. X or Esc closes it and pauses; reopening while the task
  still runs resumes the same round.
- **Only while the agent works:** sparks come only from real agent actions; the round ends when the
  run ends. No playing without a task.
- **Engine:** Godot 4.7.2, web export, single-threaded, loaded only when the panel opens.

## Gameplay

- Cinderpaw hops left and right (arrow keys or A/D, or follows the mouse) and jumps (Space, Up, or
  click). Hopping with squash and stretch, no run cycle, so no new drawings are needed.
- Every tool call in the chat store's `toolCallStream` throws a burst of sparks from the top, coloured
  by what it was: search blue, file read gold, build or command red, anything else orange. While the
  agent only thinks the sky is calm; when it works hard it rains sparks. The game's rhythm is the
  agent's rhythm.
- A caught spark feeds the fire, which grows. Rain drops fall between bursts: one that hits the fire
  shrinks it, one that hits Cinderpaw makes him sizzle and flinch for a moment.
- Five catches in a row make a big flame burst.
- **Round end** (`streamStatus` goes to `done`): sparks stop, the fire flares into fireworks, and the
  panel shows the fire's size (the score), the personal best, and a button back to the answer. On an
  error the fire dims quietly; no losing wording.
- The personal best is kept locally.

## The mascot in the game

A Godot `Skeleton2D` rig built from the existing drawings, as `Polygon2D` meshes weighted to bones:
the body squashes and stretches, horns and tail bend. No new art for v1.

## Architecture

- `games/ember/`: the Godot project (scenes, GDScript), committed.
- Exported at build time by a script beside `src-tauri/scripts/build-sidecar.mjs`, into the
  frontend's static assets (not committed). Without Godot on the machine the script says so and
  skips, and the app never shows the campfire: the feature exists only where the export does. CI
  installs Godot 4.7.2 and only the web entries of its template archive (the archive is 1.28 GB;
  the web templates are a small part, fetched with range reads as in the probe).
- Frontend: an invite (the campfire icon and its timing) and a panel (an iframe plus the bridge).
- **Bridge**, `postMessage` with JSON strings:
  - app to game: `start`, `spark {kind}`, `end {ok}`, `pause`, `resume`
  - game to app: `ready`, `score {value, best}`, `close`
- Reduced motion: the campfire icon holds still. The game itself is opt-in.

## Costs and risks (measured in the 30 Sep probe)

- The engine is `index.wasm`, 39.5 MB uncompressed (the installer compresses it). Loaded on demand;
  ready about 2 s after the panel opens in Chromium (WebView2's engine), WebGL 2, no special headers.
- **macOS runs WebKit, where the Godot web build is untested.** It must be tried on a Mac before
  release. Fallback: if the engine does not start, the campfire is not offered on that machine.
- Godot is MIT. Its notice, and the notices of what the export bundles, go into the app's
  third-party notices.
- Tauri embeds `frontendDist` into the binary. Whether 40 MB belongs in the exe or ships as a Tauri
  resource beside it is decided in the implementation plan.

## Testing

- Game logic in GDScript, tested headless with Godot.
- Frontend (vitest): the invite appears at 15 s of streaming and not before, stays hidden when the
  setting is off, and leaves when the run ends; a tool call maps to the right spark kind.
- End to end: headless Edge driven in real time over the DevTools protocol (the probe's `drive.ts`),
  checking `ready`, a spark round trip, and a screenshot.

## Out of scope for v1

Playing without a task, sound, leaderboards, and changing the app's own mascot.
