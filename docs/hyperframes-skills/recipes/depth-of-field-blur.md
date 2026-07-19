# Depth-of-Field Blur

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/depth-of-field-blur.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Rack-focus: pull the eye to a focal element by blurring + dimming everything
around it while the focal layer stays sharp. Serves **explainer-card** and
**diagram/labeled** — the DoF half of a camera push-in, or a standalone
spotlight (e.g. dimming non-hero stat cards).

## 構造 (structure)
- `.world` wraps a `.focal` layer (`z-index:2`, `--dof:0`, never blurred) plus
  N `.ctx` context layers (`z-index:1`) tagged `data-depth` for falloff.
- Every layer's `filter: blur(var(--dof))` reads a per-layer `--dof` custom
  property; a GSAP tween advances `--dof` (0→target) + `opacity` (1→dim) together.
- Focal must sit ABOVE context layers (`z-index`) so its sharp edges don't blend
  into the haze.

## コード骨子 (skeleton)
```css
.layer { --dof: 0px; filter: blur(var(--dof)); will-change: filter; }
.focal { z-index: 2; } .ctx { z-index: 1; opacity: 1; }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
gsap.utils.toArray(".ctx").forEach((el) => {
  const depth = Number(el.dataset.depth) || 1; // deterministic falloff, not Math.random
  tl.to(el, { "--dof": `${BLUR_PER_DEPTH * depth}px`, opacity: DIM_LEVEL,
    duration: FOCUS_DUR, ease: "power2.inOut" }, FOCUS_START);
});
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte** — no measurement involved; blur target is derived from `data-depth`
  (an attribute, never `Math.random`), so falloff is identical on every seek.
- Tween the `--dof` custom property on the GSAP timeline, **never a CSS
  `transition` on `filter`** — a CSS transition runs on the browser clock and
  flickers/desyncs under frame-by-frame seek.
- Blur SMALL/GROUPED layers, not a full-frame background — filter cost scales
  with radius × pixel area; keep per-layer blur ≤ ~24px on large surfaces.
- Focal layer's `--dof` stays `0` (or breathes ≤0.6px) — any visible blur on it
  kills the "this is the thing" read.
- No `repeat:-1`/CSS animation for optional idle breathing — a finite bounded
  `onUpdate` reading `sin()` only.
- GSAP required for the shared timeline; timeline paused; `will-change:filter`
  on animating layers.

## 値の目安 (value defaults)
- `BLUR_PER_DEPTH` 3–6px per depth step; `DIM_LEVEL` 0.4 (strong push-back) →
  0.55 (default) → 0.7 (subtle) — rarely below 0.35 or off-focus reads "removed."
- `FOCUS_DUR` 0.5–1.2s (a rack/pull is deliberate, not a snap).
- On a rack between two planes, both share `RACK_START`+`RACK_DUR` so they
  cross at the midpoint with no visible jump.

## vendor 全文参照 (full detail)
Full recipe (rack-focus between planes, spotlight-a-hero-metric, camera+DoF
combo, refocus-before-handoff): vendor `.../rules/depth-of-field-blur.md`.
