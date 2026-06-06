# Feral Mascot (8-bit) — Design

**Date:** 2026-06-06
**Target release:** v0.1.5
**Status:** Approved

## Summary

An animated 8-bit mascot that perches permanently on the top edge of the chat
typing bar and reacts to key interaction moments. It gives Feral an emotional,
"alive" presence (the Bloom Media branding goal) — the equivalent of the Claude
Code crab, but as Feral's own character.

The character: a fluffy black vinyl-toy monster — two curved orange horns, a
round orange face with big black eyes (white highlights), a small smile with two
white fangs, a round orange belly, stubby black arms/legs. Rendered as hand-
authored 16×16 pixel art in a 3-color palette.

## Visual reference

Palette (3 colors + 1 accent):

| Token       | Use                              | Value (start; tune in impl)  |
|-------------|----------------------------------|------------------------------|
| `fur`       | body, horns base shadow, limbs   | `#1c1c1e` (near-black)       |
| `orange`    | horns, face, belly               | brand orange (`--brand`)     |
| `white`     | eye highlights, fangs            | `#ffffff`                    |
| `red` (dot) | mouth interior (1–2 px, optional)| `#c0392b`                    |

Silhouette features that MUST read at 16×16: two horns on top, orange face mass
with two eyes + smile, black body, orange belly oval, two short legs.

## Architecture

Three small, isolated units under
`frontend-react/src/components/chat/mascot/`:

### `frames.ts` — pure data
- Exports the palette and, per mascot state, an ordered array of frames.
- Each frame is a 16-row array of 16 single-char palette indices
  (e.g. `'.'`=transparent, `'k'`=fur, `'o'`=orange, `'w'`=white, `'r'`=red).
- No logic. This is the only file that changes when art is tweaked.

### `useMascotState.ts` — pure derivation hook
- Input: `streamStatus`, `agentPhase`, `isUserTyping` (boolean).
- Output: one of `'idle' | 'typing' | 'thinking' | 'calling' | 'done'`.
- `done` is transient: when `streamStatus` transitions to `'done'`, the hook
  returns `'done'` for ~1.2s (internal timer), then falls back to `'idle'`.
- Pure mapping otherwise (table below). Unit-testable in isolation.

### `FeralMascot.tsx` — canvas renderer
- Props: `state` only. `ChatInput` owns `useMascotState` (because `isUserTyping`
  originates from its local `text` state) and passes the resolved state down.
  This keeps the renderer dumb and the state logic in one place.
- Keeps a `<canvas>` ~34×34 CSS px (16×16 logical,
  `imageSmoothingEnabled = false`, integer scale).
- Runs a single `setInterval` (~150 ms) advancing the active state's frame
  index; redraws the current frame nearest-neighbor.
- The idle bob is a CSS `translateY` keyframe on the wrapper, not a redraw.
- `pointer-events-none` so it never steals clicks from the input.

## State mapping (app → mascot)

Covers **both** chat mode (where `agentPhase` is always `null`) and agent mode.

| Mascot state | Condition                                                        |
|--------------|------------------------------------------------------------------|
| `typing`     | textarea non-empty AND not streaming (user is composing)         |
| `thinking`   | streaming AND `agentPhase` ∈ {`thinking`, `processing`, `null`}  |
| `calling`    | streaming AND `agentPhase === 'calling'`                         |
| `done`       | `streamStatus === 'done'` (transient ~1.2s, then `idle`)         |
| `idle`       | everything else                                                  |

`isUserTyping` originates in `ChatInput` local state (`text.trim().length > 0`)
and is passed down to the mascot/hook.

## Animation intent (per state)

| State    | Motion                                                          |
|----------|----------------------------------------------------------------|
| `idle`   | slow vertical bob; occasional blink (~every 4 s)               |
| `typing` | attentive — looks toward the text; faster, smaller bob         |
| `thinking`| looks up; small `...` bubble or eye movement                  |
| `calling`| focused/working expression; subtle "busy" wobble              |
| `done`   | a happy hop with closed/smiling eyes, then settle to idle     |

Frame counts are small (≈2–4 per state); exact frames authored in `frames.ts`
using the visual reference.

## Placement

In `ChatInput.tsx`, the existing rounded container
(`rounded-3xl border ... bg-bg-surface`) gets `relative`. The mascot is rendered
as an `absolute`, `pointer-events-none` element perched on the **top edge**
(`-top-4`, horizontally centered or slightly left of center), so it reads as
sitting on the rim of the bar. The idle bob keeps it gently moving on the edge.

## Accessibility & performance

- Respect `prefers-reduced-motion`: render a single static idle frame, no bob,
  no frame interval.
- The frame interval runs only while mounted; single-frame states (e.g. resting
  idle between blinks) cost effectively nothing.
- One DOM element (the canvas) plus the wrapper — negligible footprint.

## Testing

- `useMascotState`: unit tests over every `streamStatus × agentPhase ×
  isUserTyping` combination → expected mascot state, including the transient
  `done → idle` timing.
- `frames.ts`: a lightweight invariant test (every frame is 16×16; every char is
  in the palette).
- Canvas rendering validated visually via `tauri dev`.

## Out of scope (future)

- Click/hover interactions with the mascot (e.g. petting reactions).
- Additional states beyond the five above.
- Sound. Theming the mascot per model/provider.

## Assets

No external files — all art lives in `frames.ts`. The reference photo (fluffy
black monster) guides the pixel authoring only; it is not shipped.
