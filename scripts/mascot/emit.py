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
  if (state !== lastState) {
    lastState = state;
    pick = (pick + 1) % group.length;
  }
  const scene = group[pick % group.length];
  const lift = tick % 8 < 4 ? 0 : 1;
  return scene.map(([x, y, color]) => ({ x, y: y + lift, color }));
}''')
io.open(M + 'scenes.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')

print('scenes.ts : %d scenes, %d pixels' % (
    sum(len(v) for v in scenes.values()),
    sum(len(g['px']) for v in scenes.values() for g in v)))
