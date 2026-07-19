# SVG Icon Enrichment

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/svg-icon-enrichment.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Treats an SVG icon as animated PARTS (clock hand, recording dot, data-stream
dashes) instead of a static image. Serves **explainer-card** and
**diagram/labeled**. Distinct from `svg-path-draw` (animates the OUTLINE
appearing) — this animates INTERNAL parts, ideally *after* the outline has drawn.

## 構造 (structure)
- Inline `<svg>` per icon, with named `<line>`/`<circle>`/`<path>` children —
  each gets its own GSAP-driven micro-animation.
- Four signature patterns: **rotation** (clock hand), **oscillation** (opposing
  groups rotate ±sin), **pulse** (scale+opacity via sin, ring lags dot by π/2),
  **dash flow** (`strokeDashoffset` linear via time).
- All driven by `onUpdate` inside the paused timeline — never CSS `@keyframes`.

## コード骨子 (skeleton)
```css
.clock-hand { transform-origin: 60px 60px; transform-box: fill-box; } /* HTML els only */
```
```js
// Pattern: rotation — via a phase proxy, not CSS animation
const minState = { deg: 0 };
tl.to(minState, { deg: 360*1.2, duration: 4, ease:'none', onUpdate: () =>
  hand.setAttribute('transform', `rotate(${minState.deg} 60 60)`) }, 0);   // SEE NOTE ↓
// Pattern: dash flow
const flowState = { offset: 0 };
tl.to(flowState, { offset: -240, duration: 4, ease:'none', onUpdate: () =>
  dataFlow.style.strokeDashoffset = String(flowState.offset) }, 0);
```

## seek-safe 注意点 (Cutflow adaptations)
- **⚠️ CRITICAL: for rotation/scale around an explicit center inside SVG, use the
  SVG `transform` attribute — `el.setAttribute('transform', 'rotate(deg cx cy)')`**
  — NOT CSS `transform` + `transform-origin`. CSS's `transform-box:fill-box`
  interprets the origin in the element's own (bbox-local) coordinates, so a thin
  `<line>`'s bbox puts `60 60` outside the line and the hand flies off-axis
  instead of rotating in place. Same trap for small inner shapes (a dot's bbox is
  just the dot, not the viewBox).
- Run all continuous animation via timeline `onUpdate` — CSS `@keyframes` or
  `requestAnimationFrame` both desync from HF's frame-by-frame seek.
- Amplitudes stay subtle (icons are decorative); phase-offset sibling parts
  (ring vs dot by π/2, minute vs second hand) — pure sync reads mechanical.
- `stroke-linecap: round` on flowing/dashed lines for clean edges.
- GSAP required (per-part phase-driven `onUpdate`); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline keyed to `data-composition-id`. Byte tier.

## 値の目安 (value defaults)
- Rotation: minute-hand revolutions 0.5–2.0 across the duration; second hand
  should be visibly faster (`> minute × 3`) for the speed contrast to read.
- Pulse: cycles 2–4 over a 3–5s comp (≥5 reads anxious, ≤1 reads forgotten);
  dot amplitude 0.05–0.20, ring amplitude lower than the dot's (must not
  overshadow it), ring phase-offset by π/2 for a ripple feel.
- Dash flow: total offset must be an integer multiple of the dash period
  (dash+gap) or the loop's end frame shows a visible phase jump.
- Ease: rotation/pulse driver use `ease:'none'` (the trig itself provides the
  curve); only the brand/label reveal uses an eased tween (`power3.out`).

## Combinations
`svg-path-draw` (outline draws first, enrichment activates second) ·
`orbit-3d-entry` (orbiting items are themselves enriched icons) ·
`sine-wave-loop` (whole icon floats while internal parts animate).

## vendor 全文参照 (full detail)
Full recipe (all 4 pattern math + value ranges, stroke-draw→enrichment chain,
per-icon stagger): vendor `.../rules/svg-icon-enrichment.md`.
