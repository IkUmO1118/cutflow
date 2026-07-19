# Card Morph Anchor

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/card-morph-anchor.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A container smoothly reshapes between two visual states — the morph itself IS
the shot transition, no separate transition effect needed. Serves
**comparison-split**. Distinct from `scale-swap-transition` (two same-shape
elements swapping, no dimension change).

## 構造 (structure)
- One persistent `.morph-card` holding `.content-old` (opacity 1 → 0 during the
  first ~40% of the morph) and `.content-new` (opacity 0 → 1 during the last
  ~40%), both `position:absolute; inset:0`.
- Optional `.next-shot-anchor` behind the card for a final hand-off fade; use
  **DOM order** (render it BEFORE `.morph-card` in markup) for stacking, not a
  mid-fade `z-index` snap.
- `overflow:hidden` on the morph container so content clips during the shape
  change instead of overflowing the animating border-radius.

## コード骨子 (skeleton)
```css
.morph-card { overflow:hidden; display:grid; place-items:center; }
```
```js
// ⚠️ Cutflow forbids tweening width/height directly — substitute UNIFORM SCALE.
// A fixed-size container at its "shot 1" footprint scales to the "shot 2" ratio;
// border-radius/background tween normally (both are allowed properties).
tl.to('.morph-card', { scale: SHOT_TWO_SCALE, borderRadius: SHOT_TWO_RADIUS,
                       background: '{surfaceShotTwo}', duration: 0.9, ease: 'power2.inOut' }, MORPH_START);
tl.to('.content-old', { opacity: 0, duration: 0.9*0.4, ease: 'power1.in' }, MORPH_START);
tl.to('.content-new', { opacity: 1, duration: 0.9*0.4, ease: 'power1.out' }, MORPH_START + 0.9*0.6);
```

## seek-safe 注意点 (Cutflow adaptations)
- **⚠️ Cutflow forbids `width`/`height` tweens (transforms only) — use a uniform
  `scale` on the card instead** of upstream's literal `width`/`height` morph.
  Pick the card's rest size so `scale` alone spans "shot 1 footprint" →
  "shot 2 footprint"; `border-radius`/`background` still tween directly (not
  transform-restricted properties).
- Old content fades early, new content fades late — the shape change happens
  BETWEEN the two fades, giving a natural "blink" moment.
- Same ease family for shape and crossfade (`power2.inOut`) — mixing a bouncy
  content fade with a smooth shape morph reads unsynchronized.
- `borderRadius` end value ≤ half the smaller dimension, or it visually clamps.
- Don't snap `z-index` mid-fade for a hand-off — use DOM order instead, or the
  stacking flip causes a visible pop before the opacity tween finishes.
- GSAP required (multi-property lockstep tween); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `HOLD_BEAT` 0.6–1.5s pre-morph dwell so the viewer registers shot 1 first.
- `MORPH_DUR` 0.6–1.2s; old-content fade and new-content fade fractions
  0.3–0.5 each, with `OLD_FADE_FRAC + NEW_FADE_FRAC ≤ 1` (the gap between is
  the "shape-only" moment).
- Ease: `power2.inOut` canonical; avoid `back.out`/`elastic.out` on the morph
  itself — overshoot fights the dimensional change.
- If handing off to `.next-shot-anchor`, its visuals must be pixel-identical to
  the morph's final state or the crossfade pops.

## Combinations
`scale-swap-transition` (simpler morph without dimension change — just scale +
content swap) · `sine-wave-loop` (gentle breathing on the final small icon).

## vendor 全文参照 (full detail)
Full recipe (target-position landing math, gradient-stop matching, hold-beat
timing): vendor `.../rules/card-morph-anchor.md`.
