# Stat Bars & Fills

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/stat-bars-and-fills.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Give a number **visual weight**: a small bar chart, a progress bar/ring filling to
a percentage, or a star row filling to a fractional rating. Serves **stat/count-up**
(pair with `counting-dynamic-scale` for the number) and the graphic half of
**comparison-split**. Pure transform + clip-path, so it is byte-stable and needs no
GSAP.

## 構造 (structure)
- One `class="clip"` frame; graphics inside are bare elements (no per-bar clip).
- **Growth bars**: flex row, `align-items:flex-end`; each `.bar` has its final
  height in CSS and animates `scaleY:0→1` from `transform-origin:bottom`.
- **Progress fill**: a `.track` box (`overflow:hidden`) over a `.fill` that is
  `width:100%` and animates `scaleX:0→pct` from `transform-origin:left`.
- **Star wipe**: gold `★★★★★` layer over a gray layer, revealed by animating
  `clip-path: inset(0 <right>% 0 0)`.
- Pick single-focus OR split-frame and hold it across all stats.

## コード骨子 (skeleton)
```css
.bar   { transform: scaleY(0); transform-origin: bottom center; }  /* grow UP */
.track { width:520px; height:16px; overflow:hidden; border-radius:8px; }
.fill  { width:100%; height:100%; transform: scaleX(0); transform-origin: left center; }
.stars-gold { position:absolute; inset:0; width:100%; clip-path: inset(0 100% 0 0); }
```
```js
// WAAPI, no library. Each fence-hidden bar element is a .clip; these drive the fill.
bar.animate([{transform:'scaleY(0)'},{transform:'scaleY(1)'}],
            {duration:700, delay:300, easing:'cubic-bezier(.2,.8,.2,1)', fill:'both'});
fill.animate([{transform:'scaleX(0)'},{transform:'scaleX(0.92)'}],   // 92%
            {duration:1000, delay:300, easing:'ease-out', fill:'both'});
gold.animate([{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 8% 0 0)'}], // 4.6/5
            {duration:1000, delay:300, easing:'ease-out', fill:'both'});
```
Ring form: measure `getTotalLength()` once at setup, animate `stroke-dashoffset`
(delegates to `svg-path-draw`).

## seek-safe 注意点 (Cutflow adaptations)
- **Transforms + clip-path only** — never tween `width`/`height` (runtime-forbidden;
  a `scaleX` of a 0-width element also renders invisible, hence `width:100%` on `.fill`).
- `transform-origin` must be `bottom` (bars) / `left` (fills) — default center scales
  from the middle and looks wrong.
- `fill:'both'` so the value is correct at t=0 and holds after landing under seek.
- Match the paired count-up: same `delay`+`duration`+ease so number and graphic land
  as one beat.
- **GSAP unnecessary** — WAAPI covers stagger via per-element `delay`. Byte tier.
- Ring `getTotalLength()` is a measurement, but it feeds a static dash value (not a
  zoom), so it stays byte-stable — no perceptual flag needed.

## 値の目安 (value defaults)
- Bar count 4–6 (last bar = accent); stagger 0.06–0.1s via per-element `delay`.
- Fill duration 0.8–1.2s, shared with the count-up so both land together.
- Exactly **one** accent hue across bars/fill/stars; everything else muted.

## Combinations
`counting-dynamic-scale` (the number beside the graphic) · `svg-path-draw`
(the progress-ring draw mechanics).

## vendor 全文参照 (full detail)
Full recipe (value ranges, ring mechanics, blueprint choice): vendor
`.../rules/stat-bars-and-fills.md`.
