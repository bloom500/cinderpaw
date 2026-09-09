# Checkpoint: the mascot scene layer, and a night of QoL — 10 September 2026

Written to resume cold. Branch `voice/audit-followup`.

## What shipped, committed

- `79e4c01` **feat(mascot): it remembers you between sessions.** `familiarity.ts`
  keeps pokes / throws / sessions / finished turns in localStorage, only ever
  upward — no hunger, no decay, no death. Tier colours behaviour only: a
  stranger is startled by a touch, a familiar creature greets it and warms up
  in fewer pokes. `?bond=3` or `localStorage['cinderpaw.bond.force']` shows a
  tier that has not been earned. 13 tests.
- `9d9d7d8` **fix(voice): a call that cannot hear you says so.** A local call
  refuses to start when the build has no on-device transcriber; the blind
  `greet()` after `start()` is gone; a session that never reaches `listening`
  tells the person on screen after 12s. `docs/CONTRIBUTING.md` no longer sends
  contributors to `--features whisper`, which cannot link.
- `7548357` **fix(ui): drafts, models, keys.** Composer draft survives leaving,
  per conversation. Ctrl+N works in the composer. The shortcut hint is
  platform-correct. Search advertises Ctrl+K. The model pill no longer says
  "Add a model" on a machine that has models. The context ring says what it is.
  Keyboard focus rings restored on the pill and the mode toggle.

## Uncommitted, verified, waiting on Darius's eyes

`tsc` clean; 726 frontend tests pass (one flaky run failed once and passed on
the immediate re-run — not identified, watch for it).

- **`mascot/scenes.ts` (new).** 63 scenes, 5651 pixels, extracted mechanically
  from the reference pack: their character found and subtracted, what remained
  anchored to the side of OUR body it was composed on, then slid as one piece
  to a spot with three cells of air around the creature. A state can hold
  several scenes and shows a different one each time it comes round — that is
  where a state's variety comes from now.
- **`mascot/effects.ts`** cut from 203 lines to 46. Every old procedural prop
  is gone: they were four to six pixels each in a canvas with a thousand free
  cells, and they duplicated props that were also carved into the sprite (a
  sleeping creature drew its Z's twice, at two sizes).
- **`mascot/frames.ts`** 127 frames → 98. The unreadable 2-4px props are
  stripped, the sunglasses are redrawn to read as one object, and the variants
  that existed only because of a stripped prop are gone (70 → 59).
- **Canvas is now 44×38** (`FX_MARGIN_X` 14, `FX_MARGIN_TOP` 20), up from
  36×26. It grows upward and sideways only: below the creature's feet is the
  text field. Layout footprint is unchanged at 48px.
- **`frames.test.ts`** — three snapshot assertions replaced with properties: no
  two variants of a state are the same animation, a multi-frame loop actually
  moves, and every state still looks different from resting. The old ones
  pinned counts, passed happily while nine variants were the same pose with a
  different unreadable pixel, and failed the moment those were removed.
- **`MessageList.tsx`** — the jump-to-bottom button. It was `absolute bottom-20`
  INSIDE the scroll container, so it was positioned against the scrolling
  content and turned up in the middle of the screen. It now hangs off a
  non-scrolling wrapper, at the composer's measured height plus 12px, tracked
  with a `ResizeObserver` because the field grows as you type.
- **`scripts/mascot/`** the pipeline, checked in with its derived data so it
  runs without the zip. Read its README before touching the sprite.

## The mistake, so it is not repeated

Mid-session the entire sheet was regenerated as a flat orange block, on the
reasoning that `k` was a one-pixel outline freezing the silhouette. **`k` is
the creature's FUR.** Cinderpaw's mascot is a dark furry monster with orange
horns, an orange face patch and a round orange belly (`D:\WEBSITES\hero
photo.png`); the sprite was always a faithful translation of it. The
regeneration produced the reference pack's own character. Reverted from git.

The pack supplies **props**. Never anatomy.

## Open, in Darius's order

1. **One pose of OUR creature per illustration — 75 of them.** This is the
   task Darius set for tomorrow, and it is the right one: in the reference pack
   the body is redrawn for every scene, not just the scene. Sad narrows and
   tapers, happy is a compact block with no ears, thinking shears its head,
   dizzy wears a ring of ink for eyes, angry drops the inner brow.

   Both halves are already on disk. `scripts/mascot/bodies.json` holds all 73
   reference creatures at native size with their eyes and mouths marked, and
   the vocabulary read off them is in `build_body.py` (`EYES`, `MOUTH`, `LEGS`,
   plus a shear for the tilt). What is missing is the translation into OUR
   anatomy — fur flanks, orange face patch of about 10×4 cells, round belly,
   two horns — which is the part that must not be shortcut. Do NOT reuse
   `build_body.py`'s output as-is: it generates the flat orange block, which is
   the mistake recorded above.

   Method for the morning: for each illustration, read its body out of
   `bodies.json`, name the expression, then draw that expression inside our
   anatomy. Check every one in the frame inspector before it lands.
2. **`idle` variant 2 is a strobe.** `IMA` has no eyes at all, so paired with
   `IMB` at 160ms the face flashes three times a second. The only art decision
   left in the old sheet: draw it with eyes, or drop the variant.
3. **Six states have no scene**: `idle`, `typing` (correct — rest shows
   nothing), and `cool`, `gaming`, `stretching`, `spawning` (no illustration in
   the pack says the same thing).
4. **A new Astra prompt.** The old one, `docs/astra-audit-prompt.md`, was
   untracked and is gone; only the 6 Sep checkpoint describes its shape.
   Darius's scope for the next one is narrower and better: hardening,
   telemetry, and a stranger's first-run experience, no new features. Two
   conditions learned tonight — every claim must carry a line that can be
   re-located (three audits in a row cited lines 70 off), and it must read the
   BUILD COMMAND, not only the source: tonight's real cause was `moonshine`
   missing from a gitignored launcher, invisible to any source-only audit.
   Not the mascot: that is taste, and a low-effort run has speed, not taste.
5. **Cutting the 22 states.** Blocked, deliberately, on moving live tool-call
   telemetry into the chat UI first — the mascot currently *is* that display,
   and `calling` / `building` / `searching` mean nothing to a non-technical
   user who still needs to see what the agent is doing.

## Pages to look at

- Frame inspector, every sprite pixel-addressable — `claude.ai/code/artifact/79235686-1949-4bb9-a64d-dca9d13b516f`
- Reference teardown, all 75 illustrations at native scale — `claude.ai/code/artifact/56d72696-80dc-4196-a06f-94b4bc4a5cef`
- Mascot sheet, every state with every scene — `claude.ai/code/artifact/992425a1-e9e0-42d0-889d-eef503f4383b`
