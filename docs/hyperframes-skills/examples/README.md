# HyperFrames example cards

This directory holds **reference composition cards** for HyperFrames — small,
self-contained `.html` files that render (via `node src/cli.ts hyperframe`) into
silent motion-graphic clips. They are worked examples of the authoring contract:
each one is a legal `composition.html` that the CutFlow native interpreter can seek.

They are adapted from upstream `heygen-com/hyperframes` @ `458df4c` (see
`../PROVENANCE.md`), mechanically converted to satisfy the CutFlow contract by the
rules in `docs/plans/2026-07-20-hf-extraction-conversion-rules.md`.

## Naming

`<source-skill>--<original-name>.html`, e.g.
`hyperframes-animation--hook-counter-burst.html`,
`music-to-video--typewriter-reveal.html`,
`talking-head-recut--academic.html`,
`motion-graphics--circle-highlight.html`.

## The machine gate (0 error / 0 warning)

Every card here passes `checkComposition` (`src/lib/hyperframeCheck.ts`) with
**zero errors and zero warnings**. This is enforced by
`test/hyperframeExamples.test.ts`, which runs the checker over every `.html` in this
directory. The gate is **static** — it validates the composition contract (root,
typed variables, clip discipline, remote-URL ban with the pinned-CDN exception,
seek-safe drivers, font embedding, determinism tier, `data-hf-requires`, GSAP/Lottie/Anime.js/Three.js/raw WebGPU
registration). It does **not** render the card.

What the conversion changed, mechanically, relative to upstream:
- GSAP cards: the `<script src>` is repinned to the exact CDN tag (url + `integrity`
  + `crossorigin="anonymous"`) and the root declares `data-hf-requires="gsap"`.
- Root `data-start` / `data-duration` removed (root is not a clip).
- Named CSS fonts normalized to generic/system families (see note below).
- talking-head cards: an outer element was promoted to the composition root
  (`data-composition-id` + `data-width`/`data-height`) and the preview `scale(0.5)`
  removed. They render as static overlay references.

## Determinism note (static gate only)

The gate is the static checker, **not** render byte-equality. A card passing 0/0
here is guaranteed to be a legal, seek-safe composition — but **GSAP cards that
animate large text do NOT render byte-identically across independent headless-Chrome
launches** (measured YMAX ≈ 60–120; font rasterization of large animating glyphs
differs per process, amplified by zoom). This is known and accepted: these cards are
authoring references, and a human previews before burning anything into a final cut.
Static shape-only / final-frame-static cards do render byte-identically. See the
rulebook §7 for the measured evidence.

## Font normalization and the embedded-font example

Where upstream used a named webfont as the first family in a `font-family:`
declaration (`Inter`, `Google Sans`, `Playfair Display`, `Helvetica Neue`, `Arial`,
`Impact`, `Georgia`, …, or a `var(--font-*)` custom property), the first family was
folded to a generic so rendering does not depend on a machine having that font:
sans → `system-ui, sans-serif`, mono → `ui-monospace, monospace`, serif →
`ui-serif, Georgia, serif` (must lead with a generic keyword — a bare `Georgia`
first family still warns).

`cutflow--embedded-woff2-font.html` is the deliberate exception: it is the X1
worked example for a user-supplied, subset WOFF2 embedded as a
`data:font/woff2` `@font-face`. Its source, license, hashes, and reproducible
external subsetting command are recorded in
`test/fixtures/hyperframe-fonts/README.md`. No subsetting tool is bundled with
CutFlow.

`hyperframes-animation--three-geometry.html` is the X3 manual/core-only worked
example: fixed 640x360 geometry, Three.js r160 exact URL+SRI, perceptual tier,
fixed pixel ratio, and absolute-time `hf-seek` rendering with no external assets.

`hyperframes-animation--raw-webgpu-wgsl.html` is the X4 native/manual worked
example: fixed 640x360 WGSL, perceptual tier, a synchronous pre-await `hf-seek`
listener with latest-time retention, readiness-gated device/pipeline setup,
fatal device-loss handling, compilation checks, and per-frame queue submission.
TypeGPU remains out; this card has no library or CDN dependency.

## CONVERT-SUBSTITUTE cards (asset removed/substituted)

Most cards convert with only the mechanical rules above. A few carried a dependency
that had to be handled so the card renders faithfully without a missing asset. The
render sandbox CSP allows only `data:` for `img-src` (no local/remote media), so any
card that referenced an external media file (which the *static* checker does not flag,
because a relative path is not a "remote URL") had that reference replaced with a
self-contained inline stand-in:

| card | what was substituted |
|---|---|
| `music-to-video--logo-split-lockup-pulse.html` | Upstream `@font-face` loading `assets/fredoka-700.woff2` ("Lockup") removed; family normalized to `system-ui, sans-serif`. |
| `motion-graphics--circle-highlight.html` | Live `<img id="shot">` set to `assets/shot.png` (a product screenshot) → a styled `<div>` placeholder ("SCREENSHOT", CSS gradient); the `.src` assignment and a trailing self-running `tl.play()` were removed. |
| `music-to-video--held-text-strobe-burst.html` | JS-built texture `url(.../masks/<name>.png)` → an inline `repeating-linear-gradient` stand-in texture (strobe/flip timeline unchanged). |
| `hyperframes-animation--metric-video-text-pivot.html` | The `assets/demo.mp4` reference (in a "how to add footage" comment; the body already uses a CSS `.video-scene`) was dropped. |
| `talking-head-recut--hairline.html`, `--polaroid.html` | The `input-video.mp4` example path in a doc comment was genericized (`{video-src}`); the live DOM already uses a CSS `VIDEO` placeholder panel. |

These cards are silent authoring references: the media (a talking-head video, a demo
clip, a product screenshot, a texture) is a *slot* a real production fills — the
example shows the composition/overlay around it, with an inline placeholder standing
in for the media.

## Rendering a card standalone (`--durationSec`)

The CutFlow interpreter derives a card's length from its `class="clip"` elements
(`max(data-start + data-duration)`), **not** from the root. Cards whose motion lives
on the root or in JS rather than on timed clips — most talking-head style/layout cards
(static overlays with no clip) and a few templates — have no intrinsic duration, so a
standalone render needs an explicit length:
`node src/cli.ts hyperframe <dir> --name <card> --durationSec 5`. They still pass the
static 0/0 gate (duration is not a static-contract property); the flag only affects the
`hyperframe` render step. Cards with proper clips render without the flag.

## Excluded upstream cards (not directly converted)

Three upstream cards retain self-running GPU code or extra remote dependencies and
are therefore not directly converted. The separate X3 Three.js example above shows
the supported absolute-time/core-only route:

| upstream card | reason |
|---|---|
| `music-to-video/references/templates/held-message-living-field` | Loads legacy `three.js@0.147.0` with a `requestAnimationFrame` loop and remote Google Fonts; it has not been mechanically rewritten to the r160 `hf-seek` core-only contract. |
| `music-to-video/references/motion-primitives/bg-flow-field` | Raw WebGL (`canvas.getContext("webgl")`) flow-field driven by `requestAnimationFrame`. GPU/ANGLE output is driver-dependent (not byte-deterministic). |
| `music-to-video/references/motion-primitives/text-spectral-rays` | Raw WebGL + 2D-canvas compositing. Same GPU nondeterminism; excluded by policy even though the static checker passes it. |
