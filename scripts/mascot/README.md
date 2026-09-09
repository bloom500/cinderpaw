# The mascot pipeline

How `scenes.ts` is produced, and why it exists at all.

## The finding

The 127 sprite frames in `frames.ts` were drawn from a free pack of 75 pixel-art
illustrations (`Claude-Mascot-Pack-SVG.zip`, licensed for commercial use). Those
illustrations all share **one body** and put everything else **around** it: the
blocks below, the Z's above, the window beside. A prop in the pack occupies
roughly 200 cells; the whole of our sprite is 256.

Somebody translated those illustrations by carving the props **into** the 16×16
body instead — a leaf on a tuft, a green dot crossing the belly, a yellow bar
over a horn, two to four pixels each. At that size a prop has no silhouette, so
none of them read as objects. They read as defects on the animal, which is
exactly how they were described the first time anyone looked at them closely:
*"it grows a second horn"*, *"a leaf sprouts from its head"*, *"a random pixel"*.

41 of 70 variants had one. That is what this pipeline replaces.

## What it does

    props.py      split every illustration into CREATURE and SCENE, by finding
                  the largest connected run of #d97757 and subtracting it
    assign.py     assign each of the 75 illustrations to the app state it
                  actually describes
    place.py      anchor a scene to the side of OUR body it was composed on,
                  then slide it as one piece to where it fits with three cells
                  of air around the creature
    build_all.py  all of the above for every state, against the live sprite
    emit.py       write scenes.ts

`props.json`, `refpack.json` and `assign.json` are checked in so the pipeline
runs without the original zip. The zip is not ours to redistribute; the derived
coordinates are what the code needs.

## The creature is NOT from the pack

Read this before touching `frames.ts`.

Cinderpaw's mascot is a dark furry monster with **orange horns**, an **orange
face patch** and a **round orange belly** — see the render at
`D:\WEBSITES\hero photo.png`. In the sprite, `k` (#1c1c1e) is its **FUR** and
`o` is the orange. It is not an outline around an orange body.

That mistake has been made once already, on 2026-09-10: the whole sheet was
regenerated as a flat orange block "with the outline removed", which produced
the reference pack's own character and threw ours away. It was reverted from
git. The pack supplies **props**, never anatomy.

## Regenerating

    cd scripts/mascot
    python build_all.py     # recomputes placement against the current sprite
    python emit.py          # writes scenes.ts

`build_all.py` reads the live `SPA` frame for the creature's footprint, so a
change to the body automatically re-clears every prop around it.
