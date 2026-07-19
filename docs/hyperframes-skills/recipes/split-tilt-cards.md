# Split Tilt Cards

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/split-tilt-cards.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A symmetric "book-open" 3D layout for comparisons, before/after, or feature pairs:
two cards side by side, each tilted in the opposite `rotateY` direction. Serves
**comparison-split**. Distinct from `card-morph-anchor` (one container reshaping) —
here two static-shaped cards face each other from a shared `perspective`.

## 構造 (structure)
- `.scene` (bare, `perspective` set) → `.split-stage` (flex row, `preserve-3d`) →
  two `.card` children (`card-left` / `card-right`).
- Each card is `transform-style: preserve-3d` so its own rotate/translate compose
  cleanly under the stage's 3D context.
- Shadows are directional CSS (left card shadow falls right, vice versa) — not
  animated, just static per-card styling.
- No badges/labels inside a `.card` div (they'd inherit the tilt); float extras on
  `.split-stage` instead.

## コード骨子 (skeleton)
```css
.scene { perspective: 1600px; }               /* REQUIRED — else rotateY flattens */
.split-stage { display:flex; gap:80px; transform-style:preserve-3d; }
.card { transform-style:preserve-3d; will-change:transform; }
```
```js
// GSAP key = the card's data-composition-id (not "main").
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.fromTo('.card-left',  {x:-420, rotateY: TILT+8, opacity:0},
                         {x:0, rotateY: TILT,  opacity:1, duration:0.8, ease:'power3.out'}, 0.1);
tl.fromTo('.card-right', {x: 420, rotateY:-TILT-8, opacity:0},
                         {x:0, rotateY:-TILT, opacity:1, duration:0.8, ease:'power3.out'}, 0.25);
// counter-phase idle bob — Math.PI offset, FINITE repeat only
tl.to('.card-left',  {y:-6, duration:1.2, ease:'sine.inOut', yoyo:true, repeat:1}, 1.2);
tl.to('.card-right', {y: 6, duration:1.2, ease:'sine.inOut', yoyo:true, repeat:1}, 1.2);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- `fromTo` on both card entrances so a t=0 seek shows the pre-entry off-axis state,
  not a flash of the resting layout.
- **Finite float only**: `repeat:1` (or `Math.max(0, floor(...))` derived), never
  `repeat:-1` — the idle bob must end deterministically inside the clip window.
- `perspective` on `.scene` root and `preserve-3d` on stage + each card are both
  required — drop either and the tilt collapses to a flat scale.
- Fonts: generic families only; upstream's display face falls back silently — fine
  since the recipe's weight (800/900) reads without it.
- GSAP required (opposing rotateY + counter-phase timing needs one shared clock);
  pinned CDN + `data-hf-requires="gsap"` + paused registered timeline. Byte tier.
- Body copy stays ≤2 lines per card — tilted long paragraphs blur under rotation.

## 値の目安 (value defaults)
- `TILT` 10–18° (under 10 reads flat, over 18 folds the cards shut and body copy
  blurs); overshoot on entry (`TILT + 4–12°`) settles down to `TILT`.
- `ENTRY_SLIDE_DIST` 200–500px, `ENTRY_DUR` 0.6–1.2s; right card starts
  0–0.3s after the left (zero stagger feels mechanical).
- Float amplitude 3–8px, round-trip 1.6–3.2s — idle starts only after both
  cards have settled (`≥ max(LEFT_AT, RIGHT_AT) + ENTRY_DUR`).
- Shadow direction must match tilt sign (left card shadow falls right, and
  vice versa) or the 3D reads as broken.

## Combinations
`card-morph-anchor` (both cards could morph into one shape afterward) ·
`counting-dynamic-scale` (numbers as headline content per side).

## vendor 全文参照 (full detail)
Full recipe (tilt range, shadow-direction math, 3-card stacked variant): vendor
`.../rules/split-tilt-cards.md`.
