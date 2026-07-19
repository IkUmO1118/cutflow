# SVG Path Draw

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/svg-path-draw.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Reveals an SVG shape as if a pen were tracing it — a logo mark, a diagram
connector, or a progress ring. Serves **diagram/labeled**, **logo-assemble**, and
the ring form of **stat/count-up** (delegates from `stat-bars-and-fills`).
Distinct from `svg-icon-enrichment` (animates parts AFTER the outline exists).

## 構造 (structure)
- Inline `<svg>` with one or more `<path>`/`<circle>` children, `fill:none`,
  `stroke-linecap:round`.
- Each path's `stroke-dasharray` is set to its own `getTotalLength()` (a real DOM
  measurement, not a magic number); `stroke-dashoffset` starts equal to that
  length (fully hidden) and animates to `0` (fully drawn).
- Multi-segment marks stagger draws at ~70–80% of the previous segment's
  duration so the eye reads one continuous stroke, not N separate animations.

## コード骨子 (skeleton)
```css
.logo-mark path { fill:none; stroke-width:12; stroke-linecap:round; stroke-linejoin:round; }
```
```js
// Measurement feeds a STATIC dash value, not a zoom — stays byte-stable.
document.querySelectorAll('.logo-mark path').forEach((p) => {
  const len = p.getTotalLength();
  p.style.strokeDasharray = `${len}`;
  p.style.strokeDashoffset = `${len}`;
});
tl.to('#bar-left',  { strokeDashoffset: 0, duration: 0.5, ease: 'power2.out' }, 0.2);
tl.to('#bar-right', { strokeDashoffset: 0, duration: 0.5, ease: 'power2.out' }, 0.45);
tl.to('#bar-mid',   { strokeDashoffset: 0, duration: 0.35, ease: 'power2.out' }, 0.85);
```
Ring form: rotate `-90deg` via `transform-origin:center` so the draw starts at 12
o'clock instead of the default 3 o'clock.

## seek-safe 注意点 (Cutflow adaptations)
- `getTotalLength()` is measured at setup (inline SVG is already in the DOM at
  that point) and only feeds a static dasharray value — this is NOT the
  measure+zoom hazard; the result is baked once, stays byte-stable.
- `fill:none` in CSS is required for outline-only draws, or the fill area appears
  immediately and ruins the reveal.
- **Never `back.out`/`elastic.out` on a stroke draw** — pens don't bounce; use
  `power2.out` (deceleration) or `ease:'none'` for a constant-speed trace.
- Works on any element with a stroke (`path`,`circle`,`rect`,`line`,`polyline`);
  loaded `<image>` SVGs are NOT measurable this way — must be inline.
- GSAP not strictly required (WAAPI could tween `stroke-dashoffset` too), but the
  staggered multi-segment chain is cleaner as a GSAP timeline; pin CDN +
  `data-hf-requires="gsap"` if used. Byte tier.

## 値の目安 (value defaults)
- Per-segment draw duration 0.3–0.8s (short = snap, long = deliberate pen
  trace); stagger successive segments at ~70–80% of the prior segment's
  duration so the eye reads one continuous stroke.
- Brand/wordmark fade-in starts only after the last stroke settles, plus a
  small ~0.2s beat so the strokes visibly "land" first.
- Overestimate `strokeDasharray` slightly (`len × 1.05`) if a complex path's
  `getTotalLength()` looks off — too large is invisible at animation start, too
  small clips the end.

## Combinations
`counting-dynamic-scale` (stroke draws an icon while a number counts up beside
it) · `hacker-flip-3d` (SVG logo draws, then a hacker-flipped wordmark reveals
under it) · `stat-bars-and-fills` (the ring-progress form delegates here).

## vendor 全文参照 (full detail)
Full recipe (stagger timing table, draw-then-fill variant, rotation start-point
trick): vendor `.../rules/svg-path-draw.md`.
