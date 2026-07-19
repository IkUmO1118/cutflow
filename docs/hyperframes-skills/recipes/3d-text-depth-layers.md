# 3D Text Depth Layers

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/3d-text-depth-layers.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
N offset copies of the same text, back layers translucent, front layer fully
opaque — a physical "stacked extrusion" depth illusion. Serves
**kinetic-typography** and **titlecard-reveal**. Distinct from `text-shadow`
(can't have per-layer hue/opacity/animation) — each layer here is a real DOM node.

## 構造 (structure)
- One `class="clip"` stack container; N `.depth-text` copies, back-to-front.
- Back layers (`is-back`, high index `i`) are `position:absolute`, translucent,
  offset by `(i·OFFSET_X, i·OFFSET_Y)`. Front layer (`is-front`, `i=0`) is
  `position:relative` (defines container size) and full opacity/color.
- z-index only matters if depth layers overlap other elements; within the stack,
  DOM append order (back-to-front) is what stacks them visually.

## コード骨子 (skeleton)
```css
.depth-text.is-back { position: absolute; top: 0; left: 0; pointer-events: none; }
.depth-text.is-front { position: relative; z-index: 10; }
```
```js
window.__timelines = window.__timelines || {};
// Build back-to-front so front (i=0) is appended last.
for (let i = LAYER_COUNT - 1; i >= 0; i--) {
  const el = document.createElement("div");
  el.className = "depth-text " + (i === 0 ? "is-front" : "is-back");
  el.textContent = TEXT;
  if (i > 0) {
    el.style.color = `rgba({backHueRGB}, ${Math.max(0.85 - i * 0.1, 0.15)})`;
    el.style.transform = `translate(${i * 2}px, ${i * 2}px)`; // 1-3px/axis; static, no measurement
  }
  stack.appendChild(el);
}
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte\* — static offsets are the default**: the base form is a static stacked
  layout, purely CSS-positioned, no `getBoundingClientRect` — byte-stable. Only
  the optional "dynamic depth pulse" variation (sine-driven offset growth) adds
  an `onUpdate`, still deterministic (no measurement involved either way).
- Layer color via `rgba()`/`color`, not element `opacity` — opacity fades the
  glyph AND any shadow together; `rgba` fades just the glyph.
- Use `transform: translate()` for offsets, never `top`/`left` — translate
  composes cleanly with centering and avoids reflow/jitter.
- **Fonts**: works with any weight but needs 900/black + ≥60px to read as
  layered; generic families (`sans-serif`) fall back fine, just pick a heavy weight.
- If animated (cascade fade-in), GSAP is used for staggered `fromTo` opacity —
  pinned CDN, paused timeline, finite stagger only.
- No per-letter animation (hacker-flip, typewriter) layered on top of a 4-6-deep
  stack — combine effects only by dropping depth to 2-3 layers.

## 値の目安 (value defaults)
- `LAYER_COUNT` 4–6 (below 4 doesn't read as 3D, above 6 clutters on tight kerning).
- `OFFSET_X/Y` 1–3px per axis (above ~4px reads as glitch, not depth); pick one
  light-direction sign convention and keep it consistent across the composition.

## vendor 全文参照 (full detail)
Full recipe (color-shift variant, dynamic pulse math, layer-count/offset ranges):
vendor `.../rules/3d-text-depth-layers.md`.
