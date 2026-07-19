# Press-Release Spring Chain

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/press-release-spring.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A tactile button press: linear compression, then spring-based elastic recovery,
with layered feedback (shadow shrink, release burst, background glow). Serves
**explainer-card** (CTA beat). Distinct from `spring-pop-entrance` (an arrival —
no prior resting state) and `physics-press-reaction` (adds a cursor; this rule
has none — just the button reacting to an implied press).

## 構造 (structure)
- `.press-stage` → `.bg-glow` (full-stage radial, behind) + `.burst` (radial pop,
  behind the button) + `.btn` (`z-index` above both).
- Two adjacent tweens on the SAME property (`scale`) at adjacent timeline
  positions: press (`power1.in`, compress) then release (`back.out`, recover).
  State continuity is automatic when both target the same property back-to-back.

## コード骨子 (skeleton)
```css
.btn { transform-origin:50% 50%; }   /* anchor compression on center */
.burst { position:absolute; z-index:1; opacity:0; pointer-events:none; }
```
```js
// Phase 1 — press: LINEAR, not spring (the dip must feel instant/tactile)
tl.to('#btn', { scale: PRESS_SCALE, duration: PRESS_DUR, ease: 'power1.in' }, PRESS_START);
// Phase 2 — release: spring recovery. RELEASE_START = PRESS_START + PRESS_DUR (adjacency
// is what makes GSAP thread state continuity automatically).
tl.to('#btn', { scale: 1, duration: RELEASE_DUR, ease: `back.out(${BOUNCE_FACTOR})` }, RELEASE_START);
tl.fromTo('#burst', { scale:1, opacity:0 },
                     { scale:6, opacity:0.8, duration:0.5, ease:'power2.out' }, RELEASE_START);
```

## seek-safe 注意点 (Cutflow adaptations)
- **State continuity is load-bearing**: release's start value must exactly equal
  press's end value. Keep the two tweens targeting the same property at adjacent
  timeline positions (`RELEASE_START = PRESS_START + PRESS_DUR`) — a gap or
  overlap breaks the spring illusion.
- **Linear press, spring release** — both spring reads squishy; both linear loses
  the tactile punch. Don't swap the ease families.
- Burst `z-index` behind the button (never in front — it would occlude at peak).
- Glow/burst peak opacity ≤ ~0.45–0.8 per range; background glow specifically
  ≤ 0.45 or it washes the whole composition.
- Climax dwell ≥1s (≥2s for "dramatic" variants) after the burst — a reveal at
  the very end of the clip reads as "flashed and gone."
- GSAP required (adjacent-tween state continuity); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `PRESS_SCALE` 0.88 (dramatic) – 0.92 (default) – 0.96 (subtle); never below
  0.85 (broken) or above 0.98 (imperceptible).
- `PRESS_DUR` 0.10–0.30s, shorter than `RELEASE_DUR` 0.40–0.90s — input is
  faster than spring recovery.
- Button footprint ≥3–5% of canvas area, or the press reads as visually
  insignificant.
- `BOUNCE_FACTOR` 1.4 (soft) – 2.0 (firm) – 2.8 (cartoony); burst max scale
  ≤ ~8 (beyond that the radial gradient pixelates visibly).

## Combinations
`sine-wave-loop` (idle micro-float on the button BEFORE the press) ·
`center-outward-expansion` (badge burst synced to release) ·
`cursor-click-ripple` (cursor click that triggers the press).

## vendor 全文参照 (full detail)
Full recipe (subtle vs dramatic press ranges, color-shift press, approve/confirm
state-change variant): vendor `.../rules/press-release-spring.md`.
