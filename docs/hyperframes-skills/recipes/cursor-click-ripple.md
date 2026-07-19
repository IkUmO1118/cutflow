# Cursor Click Ripple

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/cursor-click-ripple.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
An animated cursor moves to a target, depresses on click, and emits expanding
ripple rings from the click point. Serves **code-card** (UI demo). Pairs with
`physics-press-reaction` (adds the ripple on top of that rule's synced press) or
stands alone as the lighter-weight click affordance.

## 構造 (structure)
- `.target-button` + `.cursor` (SVG, `pointer-events:none`, high z-index) +
  1–3 `.ripple` rings — **all present in the DOM from t=0**, not conditionally
  rendered.
- Timeline phases: move (eased cursor translate) → click (cursor+target yoyo
  scale-depress, `repeat:1`) → ripple (rings scale out + fade, staggered).

## コード骨子 (skeleton)
```css
.ripple { position:absolute; border-radius:50%; transform:translate(-50%,-50%) scale(0);
          opacity:0; pointer-events:none; }  /* hidden via style, NOT removed from DOM */
```
```js
tl.to('.cursor', { x: TARGET_X, y: TARGET_Y, duration:0.5, ease:'back.out(1.3)' }, 0);
tl.to('.cursor', { scale:0.85, duration:0.08, ease:'power2.in', yoyo:true, repeat:1 }, CLICK_AT);
tl.to('.target-button', { scale:0.95, duration:0.08, ease:'power2.in', yoyo:true, repeat:1 }, CLICK_AT);
tl.set(['.ripple-1','.ripple-2','.ripple-3'], { opacity: 1 }, CLICK_AT);
tl.to(['.ripple-1','.ripple-2','.ripple-3'],
      { scale: 5, opacity: 0, duration: 0.7, ease: 'power2.out',
        stagger: 0.08, immediateRender: false }, CLICK_AT);
```

## seek-safe 注意点 (Cutflow adaptations)
- **⚠️ Ripple elements must exist in the DOM from `t=0` at `opacity:0, scale(0)`
  — never conditionally rendered/inserted.** Conditional DOM insertion breaks
  arbitrary-frame seek (a seek to a frame before insertion would show nothing
  where the ripple should already exist-but-hidden).
- **`immediateRender:false` on the ripple expand tween** — holds the initial
  `scale:0, opacity:0` state until the click moment; without it the tween
  pre-renders and rings appear at the wrong size at `t=0`.
- Move before click: the click only fires after the move tween has visibly
  settled — clicking mid-motion reads as unintentional.
- Ripples expand from the exact click point (button's visual center), not any
  bounding-box origin.
- Cursor compresses more than target (`0.80–0.90` vs `0.92–0.97`) — the cursor
  is the actor, the target the recipient.
- GSAP required (multi-phase + staggered array tween); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline, finite `yoyo`+`repeat:1` only. Byte tier.

## 値の目安 (value defaults)
- `MOVE_DUR` 0.4–1.0s, must end before `CLICK_AT` (a click mid-move reads as a
  misclick). `MOVE_EASE`: `power2.inOut` (calm) / `back.out(1.2–1.4)` (settle
  with a tiny recoil) / `power3.out` (decisive).
- `PRESS_DUR` (yoyo half-duration) 0.06–0.12s; cursor compresses more than the
  target (0.80–0.90 vs 0.92–0.97) — the cursor is the actor.
- `RIPPLE_DUR` 0.5–1.0s, `RIPPLE_SCALE` 3–6, `RIPPLE_STAGGER` 0.06–0.12s (0 for
  a single ring — reads more elegant in a busy scene).

## Combinations
`orbit-3d-entry` (click as the pivot that collapses orbiting elements) ·
`center-outward-expansion` (click triggers an outward burst) ·
`press-release-spring` (stronger physical feel on the target button).

## vendor 全文参照 (full detail)
Full recipe (single-ring variant, keyframed attack-decay envelope, value
ranges): vendor `.../rules/cursor-click-ripple.md`.
