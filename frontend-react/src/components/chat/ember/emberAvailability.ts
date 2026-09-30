/**
 * Whether this machine can run the campfire game, asked once per launch: the
 * game's export shipped with this build, and the graphics speak WebGL 2. When
 * it cannot, `reason` is what Settings shows, so nobody has to wonder where
 * the game went.
 */
export type EmberAvailability = { ok: true } | { ok: false; reason: string };

export const GAME_URL = '/games/ember/index.html';

export function hasWebGL2(doc: Document = document): boolean {
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    (gl as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

let cached: Promise<EmberAvailability> | null = null;

export function emberAvailability(): Promise<EmberAvailability> {
  cached ??= (async (): Promise<EmberAvailability> => {
    if (!hasWebGL2()) return { ok: false, reason: "This computer's graphics don't support WebGL 2, which the game needs." };
    try {
      const res = await fetch(GAME_URL);
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      return { ok: false, reason: 'This build of Cinderpaw was made without the game.' };
    }
    return { ok: true };
  })();
  return cached;
}

/** Tests only: forget the answer so the next call asks again. */
export function resetEmberAvailability(): void {
  cached = null;
}
