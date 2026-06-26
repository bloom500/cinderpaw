# Mascot 32×32 redraw — MiniMax authoring brief

**Owner split:** MiniMax authors the pixel frames (pure leaf, fixed contract
below). Opus owns the foundation (palette, scale/layout, state machine, tests)
and the final animation polish + integration. Do **not** touch anything outside
`frames.ts` frame arrays without flagging it.

## Goal

Re-skin the typing-bar mascot from the old all-orange "eared blob" (16×16) to
the **real Bloom Media mascot** at **32×32**, keeping the exact character.

Reference image: `D:\WEBSITES\Mascota BloomMedia.png`.

### Character (from the reference — match this, not the old sprite)
A round, **dark charcoal-fur monster**:
- **Two orange horns** (curved, pointing up-and-outward) at the top of the head.
- An **orange rounded face patch** in the upper-center holding: two **big round
  black eyes** with a small **white highlight** dot each, **rosy blush** cheeks,
  and a small friendly **smile** with one tiny **white fang** and a dark-red
  mouth interior.
- **Dark fur** body (wide, rounded), short dark arms at the sides.
- A big **orange round belly** patch low-center.
- Two **dark feet** at the bottom with toe separations.

## Contract

- File: `frontend-react/src/components/chat/mascot/frames.ts`.
- Each frame is a `Frame` = `string[]` of **exactly 32 rows × 32 chars**.
  (Opus will flip `FRAME_W`/`FRAME_H` to 32 and adjust `FeralMascot` display
  scale + `MascotPerch` width — you only author 32×32 arrays.)
- Allowed pixel chars are **only** keys of `PALETTE` (already in `frames.ts`):

  | key | use                          | key | use                         |
  |-----|------------------------------|-----|-----------------------------|
  | `.` | transparent                  | `d` | orange highlight `#ffb066`  |
  | `k` | darkest outline / eye black  | `e` | orange shadow `#c2611a`     |
  | `f` | fur base `#2d2d33`           | `h` | cheek blush `#f6a07a`       |
  | `l` | lit fur rim `#474750`        | `t` | dark-red mouth `#7e2418`    |
  | `o` | orange `#F57A1F`             | `w` | white (eye highlight, fang) |
  | `r` | red mouth `#c0392b`          |     |                             |

  Accent keys `y g b p c s n m` exist for effect props but the body should use
  the table above.

## Preview loop (mandatory — do not author blind)

A zero-dep PNG renderer exists: `frontend-react/tools/render-mascot.ts`.

```
# render arbitrary candidate frames from a JSON file (string[][] or string[][][])
bun tools/render-mascot.ts --file my-frames.json 14 out.png
# render a state already wired into frames.ts
bun tools/render-mascot.ts idle 14 out.png
bun tools/render-mascot.ts --all 8 all.png
```

**Step 1 first:** author ONLY the base idle frame, render it at scale 14, and
post the PNG for approval. Do not proceed to other states until the character
reads correctly (horns, eyes, blush, fang, belly, feet). Locking the base is
what keeps all 23 states on-model.

## States to deliver (after base is approved)

Mirror the existing semantics in `VARIANTS` / `FRAMES` — same state names, same
animation intent, just redrawn. Per-state, the body is the approved base; only
the marked part changes:

- `idle` (blink loop), `typing` (mouth/paws tap), `thinking` (eyes glance + 💭),
  `calling`, `done` (smile + ✓), `running` (side profile, legs cycle),
  `wave` (one paw up), `sleep` (eyes closed + Zzz), `surprised` (wide eyes),
  `curious` (head tilt), `celebrate`, `reading`, `searching`, `building`,
  `writing`, `stretching`, `gaming`, `love`, `cool` (shades), `error`,
  `excited`, `spawning`, `dreaming` (sleep body — Opus added; effect handled in
  `effects.ts`).

Keep ≥1 variant per state. If you change variant counts, update the expected
counts map in `__tests__/frames.test.ts`. Effects (`effects.ts`) stay Opus's —
their pixel coordinates assume the canvas margins, leave them.

## Acceptance gate
1. `bun tools/render-mascot.ts --all 8` reads as the same character in every pose.
2. `npx tsc --noEmit` clean (frame arrays are 32×32, only known palette keys).
3. `npx vitest run src/components/chat/mascot` green.
