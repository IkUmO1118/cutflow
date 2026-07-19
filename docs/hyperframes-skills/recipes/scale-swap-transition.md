# Scale-Swap Transition

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/scale-swap-transition.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Simulates a "morph" between two DOM elements by overlapping exit and entrance
scale animations — lighter weight than `card-morph-anchor` (no dimension
morphing) and easier than SVG path interpolation. Serves **comparison-split**
(a same-shape state swap, e.g. icon → icon).

## 構造 (structure)
- One `.swap-wrap` (fixed size) containing two `.card`s, both `position:absolute;
  inset:0` — same footprint, `transform-origin:50% 50%` on both.
- `.outgoing` (`z-index:1`) shrinks+fades fast (`power2.in`); `.incoming`
  (`z-index:2`, starts at `opacity:0, scale:EXIT_SCALE`) pops in with overshoot
  (`back.out`) starting slightly BEFORE the outgoing finishes — the `OVERLAP`
  window is what sells the morph illusion.

## コード骨子 (skeleton)
```css
.card { position:absolute; inset:0; transform-origin:50% 50%; will-change:transform,opacity; }
.incoming { opacity:0; transform:scale(0.7); }  /* EXIT_SCALE starting point */
```
```js
tl.to('#outgoing', { scale: 0.7, opacity: 0, duration: 0.4, ease: 'power2.in' }, TRIGGER);
tl.to('#incoming', { scale: 1.0, opacity: 1, duration: 0.55, ease: `back.out(1.8)` },
      TRIGGER + 0.4 - OVERLAP);   // OVERLAP 0.1–0.2s window
```

## seek-safe 注意点 (Cutflow adaptations)
- **Incoming `z-index` must be ABOVE outgoing** — otherwise the outgoing's
  fade-tail bleeds through the incoming's lower opacity and reads as a muddy
  double-exposure.
- **`OVERLAP` stays in the 0.1–0.2s window** — too much and both are clearly
  visible together (no morph read); too little leaves a visible empty gap.
- Bouncy ease only on the incoming (`back.out`); outgoing stays `power2.in` —
  reversing them makes the swap feel mechanical instead of "arriving with weight."
- Never `display:none` the outgoing after fade — leave `opacity:0` so layout
  doesn't reflow.
- Inner content (a subline) reveals AFTER the container settles, not during the
  morph — competing reveals lose.
- GSAP required (two coordinated overlapping tweens); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `EXIT_DUR` 0.3–0.5s, `ENTER_DUR` 0.45–0.7s (longer than exit so the overshoot
  settles); `OVERLAP` 0.1–0.2s.
- `EXIT_SCALE` 0.6–0.8 — smaller reads more dramatic but risks reading as
  "vanish" instead of "morph."
- `BOUNCE_FACTOR` 1.4 (soft) – 1.8 (firm) – 2.2 (cartoony) on the incoming pop.
- Subline/inner-content reveal gap 0.2–0.4s after incoming settles.

## Combinations
`press-release-spring` (button press TRIGGERS the swap) ·
`sine-wave-loop` (idle breathing on the final state) ·
`card-morph-anchor` (the alternative for SHAPE-changing, not same-shape, swaps).

## vendor 全文参照 (full detail)
Full recipe (triple-swap 3-state cycle, color-shift no-scale variant, value
ranges): vendor `.../rules/scale-swap-transition.md`.
