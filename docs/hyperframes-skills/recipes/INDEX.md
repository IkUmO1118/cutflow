# Recipes — atomic motion recipes (Cutflow adaptation)

> Adapted from HeyGen HyperFrames skills (Apache-2.0). See ../PROVENANCE.md.

A recipe is **one upstream motion rule, compressed to a Cutflow-safe skeleton**
(60–100 lines): 用途 / 構造 / コード骨子 / seek-safe 注意点 / vendor 全文参照.
The vendor rule (avg ~290 lines) stays the reference for value-tuning tables,
variations, and combinations — recipes give you the mechanism and the Cutflow deltas.

**Compose 2–4 recipes per scene** with a single paused timeline (or a set of WAAPI
`.animate()` calls). A card is one HTML file; recipes are the moves you stack inside
it. Cards themselves come from `../card-patterns.md` (the numbered menu the LLM picks
from) — recipes are the finer-grained motion vocabulary those patterns are built out of.

## Fence convention (the machine-test safety net) — READ THIS

Recipes are **code skeletons, not full compositions**. To avoid the render/
determinism fragility of 36 full cards *and* keep the check-gate clean:

- Fenced code is **partial**: ` ```css ` / ` ```js `, or ` ```html ` that is a
  **fragment WITHOUT a `data-composition-id` root**.
- A **complete** composition, if ever shown, goes in a ` ```text ` fence.
- `test/hyperframeExamples.test.ts` globs `recipes/*.md`: any ` ```html ` block that
  contains `data-composition-id` MUST pass `checkComposition` with 0 errors / 0
  warnings. Skeleton-only recipes satisfy this **vacuously** — that is the design.

Full, checkable cards live in `../examples/` and `../card-patterns.md`, not here.

## Cross-cutting Cutflow adaptations (true for most recipes)

- **No tracks.** Upstream uses `data-track-index`; Cutflow's interpreter ignores it.
  Stacking is CSS `z-index`. Visibility is each clip's `data-start`/`data-duration`.
- **GSAP timeline key = the card's `data-composition-id`**, not the upstream literal
  `"main"`. GSAP is allowed only via a pinned CDN `<script src>` (exact url+integrity+
  `crossorigin="anonymous"`) + `data-hf-requires="gsap"` + a `{paused:true}` timeline
  registered on `window.__timelines[...]`. Stays **byte** tier (DOM writes only).
- **Prefer CSS/WAAPI**; reach for GSAP only when the choreography earns it.
- **`fromTo` not `from`** so t=0 seek is correct; **transforms only** (no width/height
  tween); **finite repeats** (no `repeat:-1`). `data-duration` on root is NOT the
  source of truth for length — clip windows are.
- **Fonts: generic families only** (`system-ui`/`sans-serif`/`serif`/`monospace`).
  Upstream's embedded display faces (Archivo Black, Bebas, League Gothic) silently
  fall back at render — recipes that leaned on one say so.

## Tag taxonomy

Recipes carry tags so you can pick by intent. Axes:

- **surface**: `text` · `data`/`stat` · `svg` · `layout`/`network` · `ui`/`interaction`
- **motion**: `entrance` · `transition` · `idle`/`ambient` · `camera`/`zoom` ·
  `kinetic` · `stagger` · `draw` · `3d` · `blur`
- **mechanism**: `css` · `waapi` · `gsap` · `clip-path` · `scale`/`transform` ·
  `measure` (reads layout) · `svg-stroke`
- **hazard**: `measure+zoom` (byte-determinism risk) · `no-input` (no CutFlow ASR/audio
  timing; hand-authored arrays)

## Determinism / seek-safe legend (last table column)

- **byte** — transform/opacity/clip-path only, no measurement-driven zoom. Re-render
  byte-identical. The default and the goal.
- **byte\*** — byte tier, but a caveat applies (embedded-font fallback, or a static
  measurement); noted in the recipe.
- **perceptual-risk** — reads `getBoundingClientRect`/`measureText` and drives a
  zoom/camera off it → per-frame AA jitter (P0: YMAX~60–120). Measure ONCE at setup
  behind `window.__hyperframes.__ready`, never per-frame. Expect perceptual, not
  byte-exact, equality.
- **no-input** — depends on ASR/audio word timing that CutFlow does NOT provide;
  timings are hand-authored arrays.

## Recipes (36)

Filename = `recipes/<name>.md`. "Serves" names card-patterns; `*` marks a prospective
P3 pattern (titlecard-reveal / grid-card-assemble / comparison-split / logo-assemble /
typewriter).

### Text & Typography

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `hacker-flip-3d.md` | Per-glyph 3D flip + deterministic glyph substitution (decryption reveal) | text, 3d, reveal, decode, gsap | kinetic-typography, titlecard-reveal* | byte |
| `vertical-spring-ticker.md` | Slot-machine vertical scroll in a masked column (stepped tweens) | text, ticker, scroll, vertical, gsap | stat/count-up, kinetic-typography | byte |
| `counting-dynamic-scale.md` | Counter whose scale grows with the value; O(1) onUpdate, tabular-nums | counter, number, stat, count-up, scale | stat/count-up | byte |
| `discrete-text-sequence.md` | Replace whole text states at time thresholds (typos, holds, backspaces) | text, typing, discrete, threshold, gsap | typewriter*, code-card | byte |
| `asr-keyword-glow.md` | Keyword glow+scale+color synced to word timestamps (attack-decay envelope) | asr, highlight, glow, keyword, text, no-input | kinetic-typography | no-input |
| `3d-text-depth-layers.md` | N offset text layers with fading alpha = stacked 3D extrusion | text, 3d, depth, layers, typography | kinetic-typography, titlecard-reveal* | byte |
| `context-sensitive-cursor.md` | Typing cursor whose color switches per segment + square-wave blink | cursor, color, typewriter, segment, gsap | code-card, typewriter* | byte |
| `dynamic-content-sequencing.md` | Pre-compute a flat timing array from a script (char count × speed + hold) | timeline, sequencing, dynamic, script-driven | kinetic-typography, typewriter* | byte |
| `kinetic-beat-slam.md` | Percussive phrases slam on one shared beat array, distinct entrances, locked finale | text, kinetic, beat, slam, punchy, gsap | kinetic-typography, titlecard-reveal* | byte\* (embedded display font falls back) |

### Data & Stats

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `stat-bars-and-fills.md` | Number + graphic: growth bars (scaleY), progress fill (scaleX/ring), star wipe (clip-path) | data, stats, bars, progress, ring, stars, waapi | stat/count-up, comparison-split* | byte |

*(`counting-dynamic-scale.md` also serves this category — listed once under Text.)*

### Camera & Viewport

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `coordinate-target-zoom.md` | Zoom into a non-centered element via outer scale + inner counter-translate (`T=-offset`) | camera, zoom, scale, translate, measure, gsap | diagram/labeled, comparison-split* | perceptual-risk (measure+zoom) |
| `camera-cursor-tracking.md` | Two-phase virtual camera locked to a moving typing cursor (measureText) | camera, tracking, viewport, two-phase, measure | code-card, typewriter* | perceptual-risk (measure+zoom) |
| `multi-phase-camera.md` | Sequential pull-back / focus / push zoom + continuous micro-drift | camera, zoom, phase, drift, cinematic, gsap | diagram/labeled | perceptual-risk if focus is measured; byte for scripted scale |
| `viewport-change.md` | Virtual camera on one `.world` wrapper: `translate(x,y) scale(S)`, `T=-offset×S` | viewport, camera, zoom, pan, focus-lock, measure | diagram/labeled | perceptual-risk if focus is measured; byte for scripted transform |
| `depth-of-field-blur.md` | Rack-focus: tween `filter:blur()` + dim on off-focus layers, focal stays sharp | blur, depth-of-field, focus, rack-focus, gsap | explainer-card, diagram/labeled | byte |

### Layout & Network

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `avatar-cloud-network.md` | Avatars on an elliptical ring + SVG lines to center, staggered entry | avatar, cloud, network, social-proof, stagger, measure | grid-card-assemble* | byte\* (cloud center must match centerpiece exactly — measure once at setup) |
| `3d-page-scroll.md` | Full webpage as a tilted 3D card scrolling to reveal sections | 3d, page, scroll, tilt, perspective, product-demo | explainer-card | byte\* (perspective; pairs with asr-keyword-glow → no-input if word-synced) |
| `center-outward-expansion.md` | Elements clustered at center expand outward to CSS-set targets in lockstep | expansion, scatter, center, reveal, layout, gsap | grid-card-assemble*, diagram/labeled | byte |
| `split-tilt-cards.md` | Two cards, opposing rotationY tilts, entry from their sides, phase-opposed float | 3d, cards, split, tilt, comparison, gsap | comparison-split* | byte |
| `orbit-3d-entry.md` | Icons flip in from 3D then settle into a continuous elliptical orbit | orbit, 3d, flip, ellipse, icon, entry, gsap | grid-card-assemble*, logo-assemble* | byte |
| `ai-tracking-box.md` | Yellow L-bracket detection box + confidence label following a target on a sine path | ai, tracking, bounding-box, detection, corner | diagram/labeled | byte (box position recomputed from scripted path, not measured) |
| `depth-scatter-assemble.md` | N elements scatter into / reassemble from a rotating 3D depth-cloud | 3d, scatter, assemble, tumble, depth, gsap | logo-assemble*, grid-card-assemble* | byte |

### SVG & Icons

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `svg-icon-enrichment.md` | Bring icons alive: rotating hands, oscillating blades, pulsing dots, dash-flow | svg, icon, micro-animation, rotation, pulse | explainer-card, diagram/labeled | byte |
| `svg-path-draw.md` | Outline draws itself via stroke-dasharray/offset; ring rotated -90° to start at 12 | svg, stroke, draw, path, dasharray, measure | diagram/labeled, logo-assemble*, stat/count-up | byte (getTotalLength feeds a static value) |

### Idle & Ambient

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `sine-wave-loop.md` | Continuous breathing/idle motion via finite-repeat sine yoyo (or tl.time() onUpdate) | idle, loop, breathing, sine, ambient | any card (idle layer) | byte (finite repeats only) |
| `ambient-glow-bloom.md` | Un-triggered soft radial glow blooms behind a hero + bounded idle breathe | glow, bloom, ambient, radial, sheen, hero | chapter-title, titlecard-reveal*, stat/count-up | byte (peak opacity ≤ ~0.45) |

### Transition & Motion

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `reactive-displacement.md` | Collision transition: entering element's tween drives the exiting one's displacement | transition, physics, collision, displacement, gsap | comparison-split* | byte |
| `press-release-spring.md` | Tactile button press: linear compression then spring recovery (2 adjacent tweens) | spring, press, button, interaction, gsap | explainer-card (CTA) | byte |
| `physics-press-reaction.md` | Click sim: two sequential scale tweens (0.9→1.0) compress CTA + cursor together | spring, click, physics, press, cursor, gsap | code-card (UI demo) | byte |
| `cursor-click-ripple.md` | Cursor moves to target, depresses on click, emits expanding ripple (attack-decay) | cursor, click, ripple, mouse, keyframes, gsap | code-card (UI demo) | byte |
| `scale-swap-transition.md` | Morph two elements at one center: exit shrinks+fades, entrance pops `back.out(2)` | transition, morph, scale, swap, gsap | comparison-split* | byte |
| `card-morph-anchor.md` | Container morphs size (uniform scale) + radius + surface between two shots | morph, anchor, transition, border-radius, gsap | comparison-split* | byte (scale substitutes forbidden width/height tween) |
| `spring-pop-entrance.md` | Canonical entrance: scale 0→1 with `back.out` overshoot, `fromTo`, ≤500ms stagger | spring, entrance, pop, overshoot, stagger, gsap | ALL (explainer-card, stat/count-up, grid-card-assemble*) | byte |
| `motion-blur-streak.md` | Fake velocity blur on a fast entrance (SVG feGaussianBlur proxy or echo/ghost trail) | motion-blur, streak, velocity, ghost, fast, gsap | titlecard-reveal*, logo-assemble* | byte |

### Effect Recipes

| recipe | 用途 (1-line) | tags | serves card-pattern(s) | determinism |
|---|---|---|---|---|
| `gsap-effects.md` | Drop-in GSAP timeline blocks (typewriter, audio visualizer, reusable choreography) | gsap, recipe, drop-in, typewriter, audio-visualizer | typewriter*, kinetic-typography, stat/count-up | byte |
| `css-marker-patterns.md` | Marker-highlight modes: highlight sweep, circle, burst, scribble, sketchout | css, marker, highlight, text, emphasis, gsap | explainer-card, kinetic-typography, diagram/labeled | byte |

## Scene transitions

Scene-to-scene transitions are a separate, single-file catalog: **`transitions.md`**
(this directory). Cutflow renders one card per HTML file, so between-card transitions
are handled by the main-timeline overlays, not inside a card — the catalog collapses
the upstream `transitions/` set into one pointer file. Within-card phase changes use
hard clip-window cuts, not exit tweens.
