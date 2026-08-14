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
  idle:      { spin: 0.045, churn: 0.10, ridge: 0.004 },
  ready:     { spin: 0.060, churn: 0.14, ridge: 0.005 },
  listening: { spin: 0.130, churn: 0.34, ridge: 0.008 },
  thinking:  { spin: 0.290, churn: 0.80, ridge: 0.011 },
  speaking:  { spin: 0.190, churn: 0.52, ridge: 0.009 },
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

  ctx.fillStyle = '#F6F2FF';
  ctx.fillRect(0, 0, c.width, c.height);

  const blob = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // Wrapped horizontally: this is an equirect map, so a blob near either edge
  // is drawn twice or it shows a seam down the back of the sphere.
  const zones: Array<[number, number, number, string]> = [
    [0.16, 0.34, 0.40, 'rgba(124, 78, 232, 0.95)'],
    [0.34, 0.72, 0.34, 'rgba(90, 58, 210, 0.85)'],
    [0.54, 0.30, 0.36, 'rgba(232, 84, 40, 0.92)'],
    [0.70, 0.62, 0.30, 'rgba(255, 168, 60, 0.88)'],
    [0.88, 0.40, 0.32, 'rgba(96, 206, 232, 0.80)'],
    [0.02, 0.62, 0.26, 'rgba(255, 255, 255, 0.95)'],
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

export function CallOrb3D({ phase, level }: { phase: CallPhase; level: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Written every frame by the component, read every frame by the loop. Refs
   *  rather than deps, so a mic level arriving 60×/s never rebuilds the scene. */
  const stateRef = useRef({ phase, level });
  stateRef.current = { phase, level };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL (software rendering disabled, driver blocklisted). The caller
      // keeps its CSS orb visible underneath, so the call still has a subject.
      return;
    }

    // Cap at 2: this is a 240px sphere, and a 3rd-generation retina ratio buys
    // nothing visible while quadrupling the fragment work on a screen that is
    // also decoding audio.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(240, 240, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
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
    const material = new THREE.MeshPhysicalMaterial({
      map: swirl,
      // Colour suspended in glass, not painted on metal. Zero metalness and a
      // near-mirror clearcoat is the whole difference between "swirl sphere"
      // and the ribbed chrome the first version chased: the coat carries the
      // gloss and the highlight, the map underneath carries the colour, and
      // nothing about the surface is supposed to have texture.
      metalness: 0,
      roughness: 0.22,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      // A trace, not the subject. Enough to warm the rim where the coat turns
      // away from the eye; at 1 it took the swirls over and made foil again.
      iridescence: 0.22,
      iridescenceIOR: 1.25,
      iridescenceThicknessRange: [180, 520],
      envMapIntensity: 1.25,
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

      const { phase: p, level: lv } = stateRef.current;
      const t = TEMPO[p];

      if (!reduced) {
        uniforms.uTime.value += dt * t.churn;
        spun += dt * t.spin;
      }
      uniforms.uRidge.value += (t.ridge - uniforms.uRidge.value) * Math.min(dt * 3, 1);

      const target = p === 'listening' ? lv * 0.09 : 0;
      swell += (target - swell) * Math.min(dt * 6, 1);
      uniforms.uSwell.value = swell;

      mesh.rotation.y = spun;
      mesh.rotation.x = Math.sin(spun * 0.6) * 0.16;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
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
