# 3D Page Scroll

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/3d-page-scroll.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A webpage rendered as a tilted 3D card that scrolls internally to reveal
specific sections — product-demo feel with physical depth. Serves
**explainer-card**. If paired with `asr-keyword-glow` for word-synced
highlights, the composite becomes **no-input** (hand-authored timings, no
CutFlow ASR).

## 構造 (structure)
- `.tilt-card` (`overflow:hidden`, static `perspective`+`rotateY`+`rotateX` via
  CSS or `gsap.set`, `transform-style:preserve-3d`) clips `.page-content`
  (real DOM sections, taller than the card — NOT a screenshot).
- Optional `.spotlight` overlay (radial-gradient dim, `pointer-events:none`)
  sits above the scrolling content, fixed relative to the card.
- Tilt angle is static for the whole scene — only `.page-content`'s `y` moves.

## コード骨子 (skeleton)
```css
.tilt-card { overflow: hidden; transform-style: preserve-3d;
  transform: translate(-50%,-50%) perspective({p}) rotateY({tiltY}) rotateX({tiltX}); }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// SCROLL_DISTANCE measured once from real section-height geometry — not a free tunable.
tl.to(".page-content", { y: -SCROLL_DISTANCE, duration: SCROLL_DUR, ease: "power3.out" }, SCROLL_AT);
tl.to(".spotlight", { opacity: 1, duration: 0.6, ease: "power1.inOut" }, SPOTLIGHT_AT);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte\* — perspective caveat**: the tilt/scroll transforms themselves are
  scripted (no runtime measurement), so this is byte-stable in the transform
  sense; the caveat is 3D-perspective rendering can show sub-pixel AA
  differences at steep angles — treat as byte with a perspective note, not a
  perceptual-risk recipe (no zoom-from-measurement is happening here).
- **No-input if word-synced**: pairing with `asr-keyword-glow` to highlight
  sections in cadence with narration means those word timings are
  HAND-AUTHORED, since CutFlow has no ASR wired into card authoring.
- `SCROLL_DISTANCE` comes from real cumulative section-height geometry measured
  at design/authoring time — not an eyeballed pixel guess.
- Shadow direction must match tilt sign (negative `tiltY` ⇒ positive shadow X).
- Same easing across all scroll phases in one scene (mixing reads as jerky).
- GSAP required; timeline paused, finite scroll distance only.

## 値の目安 (value defaults)
- `tiltYDeg` ±4–12° (bigger = more dramatic 3D, near 0 collapses to flat panel);
  `perspectivePx` 800–2000.
- `SCROLL_DUR` 0.8–1.8s; same ease (`power3.out`/`power4.out`) across every
  scroll phase in one scene.
- `SCROLL_DISTANCE` and `sectionHeight` are derived from real page layout, never
  a free-hand guess — mismatch either overshoots the content or stalls short.

## vendor 全文参照 (full detail)
Full recipe (multi-phase scroll variant, tilt/perspective ranges, spotlight
tuning): vendor `.../rules/3d-page-scroll.md`.
