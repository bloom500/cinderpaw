# Feral Cinematic Shell Design

**Date:** 2026-08-16

**Status:** Approved in conversation; awaiting written-spec review

## Objective

Give every non-call Feral page a consistent cinematic environment while
preserving the product's existing graphite-and-amber identity, functional
clarity, and dual light/dark themes. Replace the white startup frame with a
theme-correct Feral loading experience that appears before React mounts.

This is the first subproject in the broader UI modernization. Its implementation
is deliberately limited to three files:

- `frontend-react/index.html`
- `frontend-react/public/feral-prepaint.js`
- `frontend-react/src/styles/globals.css`

Sidebar composition, individual page layouts, cards, model selection, Skills,
Settings, and Memory controls are separate follow-up subprojects.

## Non-goals

- Do not change the voice sphere, call-stage palette, call controls, transcript,
  or any file in the protected voice/audio surface.
- Do not redesign page content or navigation in this subproject.
- Do not add WebGL, canvas renderers, image assets, or runtime dependencies.
- Do not alter theme persistence, application state, inference behavior, or
  backend APIs.
- Do not refactor unrelated UI code.

## Visual Direction

Feral should feel like one continuous cinematic space rather than a collection
of flat pages. The environment uses a graphite base, amber as its only active
accent, and a restrained blue-violet counterlight for depth. Glass is a
material hierarchy, not a decorative effect applied to every element.

The shell consists of composited visual layers on the document body, behind
the React root and page content:

1. A theme-specific base color that is always opaque.
2. Large, soft amber and blue-violet atmospheric lights.
3. A slow ambient drift using transforms and opacity only.
4. A subtle grain/noise layer that prevents gradients from looking synthetic.
5. A vignette that keeps text-heavy page centers calm and readable.

The existing page content remains above these layers. The background must never
intercept pointer events or alter document layout.

## Dual-theme Materials

### Dark

- Near-black graphite base with warm brown undertones.
- Diffuse amber key light and restrained blue-violet shadow light.
- Dark translucent glass with a faint internal gradient.
- Fine, light upper-edge reflections and soft colored shadows.
- Existing amber brand tokens remain the only active/action accent.

### Light

- Warm ivory base rather than pure white.
- Amber sunlight and cool blue-grey shadow light.
- Milky glass with enough opacity to keep body text readable.
- Softer shadows and brighter edge reflections than dark mode.
- Identical geometry, hierarchy, and interaction states to dark mode.

Theme changes alter light and material tokens, not component structure. The
existing `data-theme="dark|light"` contract remains the source of truth.

## Startup and Loading Experience

The current white frame occurs before the React module applies persisted theme
state. `index.html` and a small same-origin pre-paint script will provide the
first paint directly:

- `feral-prepaint.js` loads from the application's own origin, satisfying the
  existing `script-src 'self'` CSP without an unsafe inline script. It reads the
  existing `feral-ui` persisted theme preference, resolves `system`, and applies
  `data-theme` before the React module is requested.
- Minimal inline startup CSS gives `html`, `body`, and `#root` a theme-correct
  opaque background before external CSS and JavaScript finish loading.
- Static startup markup presents a large, low-contrast `FERAL` wordmark, an
  amber atmospheric light, and a compact loading indicator.
- The loading surface is decorative but accessible: it exposes a concise
  startup label and does not fake detailed subsystem progress that the bootstrap
  process cannot actually report.
- The pre-paint script observes the React root. When React mounts real content,
  it marks the document ready; CSS fades the startup surface out and the script
  then removes it from accessibility and pointer flow.

If React fails before mounting, the startup surface remains visible instead of
revealing a white page. Existing application error handling remains responsible
for post-mount failures; adding a native bootstrap error protocol is out of
scope.

## Runtime Scene and Motion

The document body owns the decorative scene through fixed pseudo-elements
beneath the React root. The scene is shared across every normal route so page
changes remain in the same visual world and do not remount its animated layers.

The default experience is cinematic:

- atmospheric lights drift slowly;
- grain shifts subtly;
- page content receives no continuous transform;
- glass and foreground controls may use existing backdrop blur;
- route changes do not restart or flash the background animation.

This subproject establishes CSS hooks for later `Cinematic`, `Balanced`, and
`Minimal motion` profiles but does not add the Appearance setting or persisted
state. That setting requires its own three-file follow-up. Until then, the full
cinematic profile is the default and the operating system's reduced-motion
preference is authoritative.

Under `prefers-reduced-motion: reduce`, all ambient animation stops while the
complete static lighting composition remains visible. Browsers naturally
throttle compositor animations in hidden/minimized windows; explicit inference
state coupling is deferred until a later subproject can use an existing,
verified state signal without expanding this slice.

## Glass Material Tokens

`globals.css` will add semantic tokens for both themes rather than hard-coded
colors in components:

- scene base and key/counter lights;
- glass surface levels;
- glass border and upper-edge reflection;
- glass shadow and bloom;
- scene grain and vignette strength.

The tokens allow later page and component subprojects to adopt the same material
system without duplicating rgba values. Existing palette and shadcn aliases stay
intact. The documented `--brand` versus shadcn `--accent` naming contract must
not change.

The `.call-stage` token override remains authoritative inside voice mode. New
scene selectors must not target `.call-stage`, orb classes, or voice overlay
descendants.

## Performance Constraints

The cinematic look may use GPU compositing, but must not introduce an unbounded
render loop or consume layout time continuously:

- animate only `transform` and `opacity` on large ambient layers;
- never animate `filter`, `backdrop-filter`, gradient stops, layout, or paint-
  heavy box shadows;
- do not apply full-screen `backdrop-filter`;
- keep the number of continuously animated full-screen layers to two or fewer;
- use a small repeatable grain representation rather than a full-resolution
  image;
- preserve an opaque base below every translucent layer;
- stop all decorative animation for reduced-motion users.

These constraints protect local inference responsiveness while still allowing
high-fidelity visuals on capable hardware.

## Accessibility and Robustness

- Body text and controls retain their existing semantic text tokens.
- Decorative scene layers use `aria-hidden="true"` and cannot receive focus or
  pointer events.
- The startup label is readable by assistive technology; the giant wordmark and
  decorative lights are hidden from it.
- Light and dark themes must never show transparent text over an uncontrolled
  desktop/window background.
- The app remains usable when blur support is missing: opaque fallback surfaces
  and the base scene still provide hierarchy.
- The frameless window controls remain above the scene and all routed content.

## Verification

The implementation is complete only when all of the following are demonstrated:

1. Cold start in persisted dark mode never shows a white frame.
2. Cold start in persisted light mode begins with warm ivory, not dark or white
   flash, and transitions into the matching application theme.
3. `system` preference resolves correctly before React mounts.
4. Every normal route shares the cinematic background without resetting it.
5. Voice call visuals are pixel-equivalent to the pre-change version.
6. Reduced-motion mode renders a static scene with no ambient animation.
7. Unsupported blur falls back to readable opaque materials.
8. React tests/typecheck and the repository-wide `./scripts/verify.sh` gate pass.

Visual verification should cover the home/chat empty state, Models, Settings,
Extensions, Connectors, Memory Layers, Skills overlay, and the call overlay in
both dark and light themes at the application's 1280×800 default size.

## Follow-up Subprojects

After this foundation lands, subsequent independently approved slices can adopt
the material system without expanding this implementation:

1. Sidebar information hierarchy and glass treatment.
2. Home/chat composer, suggestions, and model selector.
3. Skills full-page versus quick-drawer behavior.
4. Shared page container and Settings layout.
5. Models browser density, compatibility, and download hierarchy.
6. Extensions and Connectors card/form consistency.
7. Memory terminology, controls, and trust affordances.
8. Appearance profiles for Cinematic, Balanced, and Minimal motion.
