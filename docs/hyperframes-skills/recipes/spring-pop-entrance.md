# Spring-Pop Entrance

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/spring-pop-entrance.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
THE canonical entrance: an element (or staggered group) arrives by scaling
`0 → 1` on a smooth long-tail settle. Serves ALL card patterns (explainer-card,
stat/count-up, grid-card-assemble). Distinct from `press-release-spring` (a
click/press→release feedback chain — a prior resting state exists); this rule
has NO press phase, the element simply springs into being.

## 構造 (structure)
- Single hero: one element, `transform-origin:50% 50%`, `fromTo` from
  `{scale:0, opacity:0}`.
- Group: N `.pop-item`s in a grid, each getting the same `fromTo` with a
  deterministic index-derived stagger — the whole group must land inside one
  ~0.5s beat, not a slow arpeggio.

## コード骨子 (skeleton)
```css
.pop-hero, .pop-item { transform-origin:50% 50%; will-change:transform; }
```
```js
// Smooth beats bouncy — power3.out is the DEFAULT, no overshoot.
tl.fromTo('#hero', { scale:0, opacity:0 },
                    { scale:1, opacity:1, duration:0.55, ease:'power3.out' }, ENTRY_AT);
// Group: deterministic stagger, capped so ITEM_COUNT × STAGGER ≤ ~0.5s
items.forEach((el, i) => tl.fromTo(el, { scale:0, opacity:0, y:24 },
  { scale:1, opacity:1, y:0, duration:0.55, ease:'power3.out' }, GROUP_ENTRY_AT + i*0.06));
```

## seek-safe 注意点 (Cutflow adaptations)
- **Default ease is `power3.out` (smooth, NO overshoot)** — bouncy `back.out` is
  a rare, explicitly-playful exception (consumer/fun brand only), never the
  default; it's the #1 turn-off in agent-made motion. Reach for `expo.out` for a
  punchier front, still smooth.
- **`fromTo`, always** — explicit `{scale:0, opacity:0}` start so a t=0 seek
  lands there exactly; a CSS-hidden start + `.to()` flickers under seek.
- **`ITEM_COUNT × STAGGER ≤ ~0.5s`** — derive `STAGGER = min(0.06, 0.5/N)` so a
  group always reads as one arriving beat, not a list reveal.
- Main subject visible by `t ≤ 0.5s` — don't let the hero finish arriving late.
- No idle loop baked in — this entrance is finite; hand off held slots to
  `sine-wave-loop` (subtle jitter) on a separate, later tween.
- Index-derived stagger/tilt only, never `Math.random`.
- GSAP required (fromTo + deterministic stagger); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `POP_DUR` 0.4–0.7s; the main subject must be visible by `t ≤ 0.5s`.
- `STAGGER` 0.04–0.08s, capped so `ITEM_COUNT × STAGGER ≤ ~0.5s` — beyond that
  the group stops reading as one beat.
- `Y_RISE` 0 (pure pop) – 32px, kept small so `scale` stays the dominant motion.
- Bouncy exception only: `back.out(OVERSHOOT)` with `OVERSHOOT ≤ ~2` and a
  small `ROT_FROM` (±10°) — reserved for explicitly playful/consumer tone.

## Combinations
`sine-wave-loop` (at most subtle jitter on a held node AFTER the pop lands) ·
`center-outward-expansion` (elements pop in as they radiate to their slots) ·
`press-release-spring` (the reaction counterpart once popped in).

## vendor 全文参照 (full detail)
Full recipe (calm/firm/bouncy variant selection, origin-anchored pop, spring-ease
physics option): vendor `.../rules/spring-pop-entrance.md`.
