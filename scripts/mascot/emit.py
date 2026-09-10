import io, json, re

M = '../../frontend-react/src/components/chat/mascot/'
b = json.loads(io.open('built.json', encoding='utf-8').read())
scenes = b['scenes']

# This script writes scenes.ts and NOTHING else.
#
# It used to rewrite frames.ts from a generated body as well. On 2026-09-10 that
# path regenerated all 127 frames as a flat orange block "with the outline
# removed", which threw our creature away and produced the reference pack's own
# character; it was reverted from git. The creature is a dark furry monster --
# `k` is its FUR, not an outline -- and it is now hand-owned in frames.ts, which
# this pipeline only READS, to know where the props must not stand.

PAWS_DOC = """
/**
 * Where the creature puts its paws for each scene, in FRAME cells.
 *
 * Lifted from the reference the same way the scene was. Its hands are separate
 * blobs of body colour placed against whatever it is using -- two on the
 * barbell, one on the scroll, two up beside the banner -- so the offset of a
 * blob from its body says this is an illustration where the creature is DOING
 * the thing, and on which side, and how high. That is all we take: side and
 * height, snapped to the two positions our own creature has, because the sprite
 * is a different animal at a different size and a copied offset would put a paw
 * in mid-air.
 *
 * 45 of the 73 illustrations have no hands out at all, and those stay empty on
 * purpose: in them the creature stands next to the object, it does not use it.
 *
 * Indexed alongside SCENES -- entry i belongs to scene i of the same state.
 */
export const PAWS: Partial<Record<MascotState, readonly (readonly (readonly [number, number])[])[]>> = {"""

# ---------------- scenes.ts ----------------
L = ['''/**
 * The scene around the creature, lifted out of the reference pack.
 *
 * The 75 illustrations these sprites were drawn from share one body and put
 * everything else AROUND it: the blocks below, the Z's above, the window
 * beside. Each entry here was produced mechanically -- their character was
 * found and subtracted, and what remained was anchored to the side of OUR body
 * it had been composed on, then slid as one piece to somewhere it fits with
 * three cells of air around the creature. Nothing was traced by hand, and their
 * character is in none of it.
 *
 * A state can carry several scenes. That is where a state's variety comes from
 * now: not from redrawing the creature, but from what is standing next to it,
 * which is how the pack was composed in the first place.
 *
 * Coordinates are canvas cells, the space `effects.ts` draws in.
 * Regenerate with `scratchpad/build_all.py`.
 */
import type { MascotState } from './frames';
import type { EffectPixel } from './effects';

/** x, y, colour. Flat triples rather than objects: there are 1.5k of them. */
export type ScenePixel = readonly [number, number, string];

export const SCENES: Partial<Record<MascotState, readonly (readonly ScenePixel[])[]>> = {''']
for st, group in scenes.items():
    L.append('  %s: [' % st)
    for g in group:
        px = ','.join('[%d,%d,%r]' % (x, y, c) for x, y, c in g['px']).replace("'", '"')
        L.append('    /* %s */ [%s],' % (g['from'], px))
    L.append('  ],')
L.append('};')
L.append(PAWS_DOC)
for st, group in scenes.items():
    L.append('  %s: [' % st)
    for g in group:
        cells = ','.join('[%d,%d]' % (c, r) for c, r in g['paws'])
        L.append('    /* %s */ [%s],' % (g['from'], cells))
    L.append('  ],')
L.append('''};

/**
 * Which scene, and where it sits this tick.
 *
 * A state with several scenes shows a different one each time it comes round,
 * rather than cycling while you watch: a prop that swaps itself mid-thought is
 * a distraction, and the whole reason the old choreography was deleted was that
 * motion nobody asked for stops being seen. So the choice advances on ENTERING
 * the state, and holds for as long as the state does.
 *
 * The scene also rises and falls a pixel, on a slower count than the body's own
 * bob. Slower on purpose: matched exactly, creature and prop would read as one
 * rigid object being moved by a machine.
 */
let lastState: MascotState | null = null;
let pick = 0;

export function sceneFor(state: MascotState, tick: number): EffectPixel[] {
  const group = SCENES[state];
  if (!group || group.length === 0) return [];
  advance(state, group.length);
  const scene = group[pick % group.length];
  const lift = tick % 8 < 4 ? 0 : 1;
  return scene.map(([x, y, color]) => ({ x, y: y + lift, color }));
}

function advance(state: MascotState, count: number): void {
  if (state === lastState) return;
  lastState = state;
  pick = (pick + 1) % count;
}

/**
 * The paws that belong to the scene now on screen.
 *
 * It has to be the SAME scene, so it reads the choice `sceneFor` already made
 * rather than making one of its own: a creature reaching to its left while the
 * thing it is reaching for stands on its right is worse than not reaching at
 * all. It advances the choice itself too, so it stays correct when the effects
 * layer is skipped entirely, which is what reduced motion does.
 */
export function pawsFor(state: MascotState): readonly (readonly [number, number])[] {
  const group = PAWS[state];
  if (!group || group.length === 0) return [];
  advance(state, group.length);
  return group[pick % group.length] ?? [];
}''')
io.open(M + 'scenes.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')

print('scenes.ts : %d scenes, %d pixels' % (
    sum(len(v) for v in scenes.values()),
    sum(len(g['px']) for v in scenes.values() for g in v)))
