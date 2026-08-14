/**
 * The call sphere, in WebGL.
 *
 * The CSS version got close to a *surface* and could never be a *volume* —
 * layered gradients can fake bands of colour and cannot fake light bending
 * through a solid, which is the whole of what the reference image is. Three
 * passes made that clear rather than fixing it, so this is the same object
 * built the way the reference was built.
 *
 * What produces the look, in order of how much it matters:
 *
 *  1. **Thin-film iridescence.** `MeshPhysicalMaterial.iridescence` is a real
 *     wavelength-interference term — the rainbow shifts with viewing angle
 *     because the film thickness the ray crosses changes, which is why it reads
 *     as an object and not as a texture. This is the one thing no gradient can
 *     imitate.
 *  2. **A displaced surface.** The ridges are geometry, not a stripe pattern:
 *     they catch light on the crest and shadow in the trough on their own. The
 *     twist is a rotation that grows with height, which is what "wrung cloth"
 *     is.
 *  3. **Something to reflect.** Iridescence and clearcoat are both reflections;
 *     with nothing around the sphere they render as flat grey. The environment
 *     is generated here as a small gradient — no file, no fetch, no CDN, which
 *     matters because this ships inside a desktop app and must work offline.
 *
 * ponytail: raw three, no react-three-fiber and no drei. That is three
 * dependencies and a reconciler to draw one sphere that never changes its
 * scene graph. Add them if a second 3D surface ever appears.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { CallPhase } from '@/hooks/useCallSession';

/**
 * How fast the sphere turns and how hard it churns, per state. Same contract
 * the CSS orb had: one object at four tempos, so it stays recognisable while
 * telling you what it is doing.
 */
const TEMPO: Record<CallPhase, { spin: number; churn: number; ridge: number }> = {
  idle:      { spin: 0.045, churn: 0.10, ridge: 0.0015 },
  ready:     { spin: 0.060, churn: 0.14, ridge: 0.0018 },
  listening: { spin: 0.130, churn: 0.34, ridge: 0.0030 },
  thinking:  { spin: 0.290, churn: 0.80, ridge: 0.0045 },
  speaking:  { spin: 0.190, churn: 0.52, ridge: 0.0038 },
};

/**
 * The colour that lives INSIDE the glass.
 *
 * The two references turned out to be different objects, and the ridged one
 * sent this component chasing the wrong problem. What is actually wanted is a
 * smooth glossy sphere with soft swirls of colour suspended in it — no relief
 * at all — which is both closer to the original orb and far easier: broad soft
 * blobs painted once into a texture, turned slowly under a clear coat.
 *
 * Drawn at 512 and blurred hard on purpose: the swirls should have no visible
 * edge anywhere, because an edge inside glass reads as a decal on the surface.
 */
function makeSwirlTexture(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S / 2;
  const ctx = c.getContext('2d')!;

  // A tinted base, not white. The first attempt filled with #F6F2FF and let the
  // blobs fade to transparent white, so every colour was averaged toward paper
  // and the sphere rendered as a pale fog — visible only once it was actually
  // looked at rather than reasoned about.
  ctx.fillStyle = '#5B2BC9';
  ctx.fillRect(0, 0, c.width, c.height);

  const blob = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    // Holds full strength through the middle: a gradient that starts falling
    // off at the centre has no solid colour anywhere, which is what turns
    // swirls into haze.
    g.addColorStop(0.45, color);
    g.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // Wrapped horizontally: this is an equirect map, so a blob near either edge
  // is drawn twice or it shows a seam down the back of the sphere.
  // Big and overlapping. Small blobs on a large map read as spots; the
  // reference is a handful of broad regions that meet and bleed into each other.
  // Order and size, both of which were wrong the first time and cost four
  // screenshots: the light colours were drawn LAST over the saturated ones, and
  // every blob was wide enough to cover half the map, so the composite averaged
  // to pale lavender. Light first, saturated on top, and none of them large
  // enough to own the whole sphere. A white blob is gone entirely — white on a
  // 512px map is not a highlight, it is an eraser.
  // Four regions, not six, and each one big enough to own a quarter of the
  // sphere. The reference is a handful of broad zones that meet and bleed; a
  // longer list at smaller radius reads as stripes once the map wraps, which is
  // exactly what the last version looked like.
  const zones: Array<[number, number, number, string]> = [
    [0.62, 0.58, 0.52, 'rgba(255, 186, 72, 1)'],
    [0.90, 0.30, 0.46, 'rgba(72, 214, 244, 1)'],
    [0.16, 0.34, 0.54, 'rgba(132, 66, 250, 1)'],
    [0.40, 0.80, 0.48, 'rgba(238, 52, 32, 1)'],
  ];


  for (const [fx, fy, fr, color] of zones) {
    const x = fx * c.width;
    const y = fy * c.height;
    const r = fr * c.height;
    blob(x, y, r, color);
    if (x < r) blob(x + c.width, y, r, color);
    if (x > c.width - r) blob(x - c.width, y, r, color);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/**
 * The room, as an equirectangular gradient.
 *
 * Deliberately not neutral: the sphere stands on an orange field, and a
 * reflective object that reflects nothing of its surroundings is the classic
 * tell of a 3D asset pasted onto a background. Warm below, cool light above —
 * the cool half is what the iridescence splits into colour, the warm half is
 * what ties it to the screen it sits on.
 */
function makeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#FFFFFF');
  g.addColorStop(0.22, '#CFE0FF');
  g.addColorStop(0.44, '#9FB6E8');
  g.addColorStop(0.62, '#C97A52');
  g.addColorStop(0.82, '#A8452A');
  g.addColorStop(1.0, '#4A1C10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 256);

  // A window. A smooth gradient has no bright small source anywhere, so a
  // clearcoat has nothing to catch and the sphere renders matte no matter how
  // low its roughness — the first look at this was a foggy ball for exactly
  // that reason. This is the hard highlight.
  // Wide and soft rather than a point. A pinprick source gives a pinprick
  // highlight, which reads as a rendering artefact; the reference's highlight is
  // a broad soft oval, because a real window is a panel and not a bulb.
  const spec = ctx.createRadialGradient(22, 48, 2, 22, 48, 54);
  spec.addColorStop(0, '#FFFFFF');
  spec.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, 64, 130);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  // PMREM, because a raw equirect map on a rough material bands badly — the
  // pre-filtered mip chain is what makes the roughness read as roughness.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

export function CallOrb3D({
  phase,
  level,
  working = false,
  onActive,
}: {
  phase: CallPhase;
  level: number;
  /**
   * Called with true once WebGL is up, false if it never comes. The CSS orb
   * underneath is a fallback and has to be TOLD to get out of the way — drawn
   * on top of it without this, both spheres are visible at once and the older
   * one shows through the new one's edges.
   */
  onActive?: (ok: boolean) => void;
  /**
   * A tool is running right now. Its own signal rather than a sixth phase,
   * because it is orthogonal: Feral can be answering out loud WHILE a search
   * is still running, and the sphere should be able to say both at once.
   */
  working?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Written every frame by the component, read every frame by the loop. Refs
   *  rather than deps, so a mic level arriving 60×/s never rebuilds the scene. */
  const stateRef = useRef({ phase, level, working });
  stateRef.current = { phase, level, working };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL (software rendering disabled, driver blocklisted). The caller
      // keeps its CSS orb visible underneath, so the call still has a subject.
      onActive?.(false);
      return;
    }

    // Cap at 2: this is a 240px sphere, and a 3rd-generation retina ratio buys
    // nothing visible while quadrupling the fragment work on a screen that is
    // also decoding audio.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(240, 240, false);
    // ACES desaturates saturated colour hard by design — it is a film curve,
    // and the swirls are the subject here, not a photographic highlight roll-off.
    // Linear keeps them the colour they were painted.
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.0;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = '240px';
    renderer.domElement.style.height = '240px';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 4.6);

    const env = makeEnvironment(renderer);
    scene.environment = env;

    // Icosahedron rather than a UV sphere: the displacement below is per-vertex,
    // and a UV sphere's poles crowd vertices where nothing needs them while
    // starving the equator where the ridges live.
    const geometry = new THREE.IcosahedronGeometry(1, 64);

    const swirl = makeSwirlTexture();

    // Lights, because a scene lit only by an image-based environment lights the
    // ALBEDO with that environment — and this environment is mostly white sky,
    // so the purple underneath rendered as pale lavender no matter what the
    // texture said. Two: a key that gives the coat a direction, and a warm
    // bounce so the underside is not dead.
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(-1.6, 2.2, 2.4);
    scene.add(key);
    const bounce = new THREE.DirectionalLight(0xffb27a, 0.30);
    bounce.position.set(1.4, -1.8, 0.8);
    scene.add(bounce);
    const material = new THREE.MeshPhysicalMaterial({
      map: swirl,
      // The same swirls again as EMISSION, and this is what sells "colour
      // suspended in glass" rather than "colour painted on a ball": light
      // leaving from inside cannot be washed out by what is reflecting off the
      // outside. Held well under 1 so it glows rather than self-illuminates
      // into a flat sticker.
      emissive: 0xffffff,
      emissiveMap: swirl,
      emissiveIntensity: 0.32,
      // Colour suspended in glass, not painted on metal. Zero metalness and a
      // near-mirror clearcoat is the whole difference between "swirl sphere"
      // and the ribbed chrome the first version chased: the coat carries the
      // gloss and the highlight, the map underneath carries the colour, and
      // nothing about the surface is supposed to have texture.
      metalness: 0,
      // Near-zero: at 0.22 the surface scattered the environment into a haze
      // and the swirls came out as fog. Glass this glossy is what lets the
      // colour underneath stay saturated.
      roughness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.01,
      // A trace, not the subject. Enough to warm the rim where the coat turns
      // away from the eye; at 1 it took the swirls over and made foil again.
      iridescence: 0.22,
      iridescenceIOR: 1.25,
      iridescenceThicknessRange: [180, 520],
      // Low. The environment is there for the highlight and the rim, not to light
      // the ball — at 1.25 the white sky reflected across the whole surface and
      // washed every swirl to pastel.
      envMapIntensity: 0.55,
    });

    // Displacement in the vertex stage. Done with onBeforeCompile rather than a
    // ShaderMaterial so the whole physical-material lighting model — clearcoat,
    // iridescence, tone mapping — is kept instead of reimplemented.
    const uniforms = {
      uTime: { value: 0 },
      uRidge: { value: TEMPO[phase].ridge },
      uSwell: { value: 0 },
    };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uRidge = uniforms.uRidge;
      shader.uniforms.uSwell = uniforms.uSwell;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime;
           uniform float uRidge;
           uniform float uSwell;`,
        )
        // `begin_vertex` defines `transformed`; displacing there means the
        // normals recomputed downstream follow the ridges, which is what makes
        // them catch light instead of looking painted on.
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float lat = asin(clamp(normal.y, -1.0, 1.0));
           float lon = atan(normal.z, normal.x);
           // The twist: longitude sheared by latitude, so the ridges wind around
           // the ball instead of ringing it. This is the whole "wrung cloth".
           float wound = lon + lat * 2.6 + uTime * 0.35;
           float ridges = sin(wound * 9.0) * 0.55
                        + sin(wound * 17.0 + lat * 3.0) * 0.28
                        + sin(lat * 14.0 - uTime * 0.5) * 0.17;
           // Ridges fade at the poles, where a sphere's own curvature already
           // crowds them and the displacement would pinch into a spike.
           float polar = 1.0 - pow(abs(normal.y), 3.0);
           transformed += normal * (ridges * uRidge * polar + uSwell);`,
        );
    };

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let raf = 0;
    let last = performance.now();
    let spun = 0;
    // Smoothed, because a raw mic level is spiky enough to make the surface
    // jitter — the sphere should swell with the voice, not vibrate at it.
    let swell = 0;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const { phase: p, level: lv, working: busy } = stateRef.current;
      const t = TEMPO[p];

      // Tool work reads as CHURN, not as speed. Spinning faster is what the
      // sphere already does while thinking, so reusing it would say the same
      // thing twice and mean neither; making the colour inside move while the
      // ball itself keeps its tempo says "something is happening in there",
      // which is exactly what a tool call is. It also composes: Feral can be
      // speaking and searching at once, and both show.
      const churn = t.churn * (busy ? 3.4 : 1);

      if (!reduced) {
        uniforms.uTime.value += dt * churn;
        spun += dt * t.spin;
      }
      uniforms.uRidge.value += (t.ridge - uniforms.uRidge.value) * Math.min(dt * 3, 1);

      // A slow pulse under the surface while it works, on top of whatever the
      // microphone is doing. Small enough to be felt rather than watched.
      const pulse = busy && !reduced ? Math.sin(now / 420) * 0.012 + 0.012 : 0;
      const target = (p === 'listening' ? lv * 0.09 : 0) + pulse;
      swell += (target - swell) * Math.min(dt * 6, 1);
      uniforms.uSwell.value = swell;

      mesh.rotation.y = spun;
      mesh.rotation.x = Math.sin(spun * 0.6) * 0.16;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);
    onActive?.(true);

    return () => {
      onActive?.(false);
      cancelAnimationFrame(raf);
      geometry.dispose();
      material.dispose();
      env.dispose();
      swirl.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Built once. Phase and level reach the loop through the ref above; putting
    // them here would tear down and rebuild WebGL on every microphone sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center" />;
}
