# Reactive Displacement

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/reactive-displacement.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
An entering element's spring causally DRIVES an exiting element's displacement —
"A moves *because* B hit it." Serves **comparison-split**. Distinct from
`scale-swap-transition` (overlaps but isn't causal) and `card-morph-anchor` (one
container morphing, not two elements colliding).

## 構造 (structure)
- Two `.card` elements sharing one center footprint: `.victim` (exiting) and
  `.intruder` (entering, `z-index` above the victim so it visually "wins").
- **Single driver** (`{p:0→1}`) feeds BOTH motions inside one `onUpdate` — never
  two independent tweens, or the collision stops being causally linked.
- Intruder completes its full `0→1` entry; victim completes its exit at a
  *fraction* of the driver (`VICTIM_FRACTION`, ~0.5) so it's already gone by the
  time the intruder centers — the overlap moment is the "hit."

## コード骨子 (skeleton)
```css
.card { position:absolute; will-change:transform,opacity; }
.intruder { z-index:2; } .victim { z-index:1; }
```
```js
const driver = { p: 0 };
tl.to(driver, { p:1, duration:0.9, ease:'back.out(1.5)', onUpdate: () => {
  const intruderX = INTRUDER_START_X * (1 - driver.p);
  intruder.style.transform = `translate(-50%,-50%) translateX(${intruderX}px)`;
  intruder.style.opacity = String(Math.min(1, driver.p * 5));
  const victimP = Math.min(1, driver.p / 0.5);           // finishes at HALF the driver
  victim.style.transform = `translate(-50%,-50%) translateX(${VICTIM_END_X * victimP}px)`;
  victim.style.opacity = String(1 - victimP);
}}, DRIVER_AT);
```

## seek-safe 注意点 (Cutflow adaptations)
- **Single driver, multiple derived values in one `onUpdate`** — don't tween
  intruder and victim with separate `tl.to()` calls; compute both from one
  proxy or they can drift apart under seek and the "collision" stops reading.
- **Directional momentum**: intruder enters from positive X → victim exits
  negative X (same axis, opposite sign). Different axes read as "passed each
  other," not collided.
- `overflow:hidden` on `.scene` — off-stage motion exceeds the frame.
- Climax dwell ≥1s after the intruder settles — the impact is the headline beat.
- GSAP required (one driver, coordinated derived writes); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `DRIVER_DUR` 0.6–1.4s; `BOUNCE_FACTOR` (`back.out`) 1.2–2.0 — low = firm
  settle, high = overshoot/bounce.
- `VICTIM_FRACTION` 0.4–0.5 (hard ceiling ~0.6) — below 0.4 the victim
  disappears before the impact reads; above 0.6 the collision metaphor breaks
  and the motions read as parallel, not causal.
- Intruder initial tilt 5–15°, settling to 0° at center — visualizes momentum
  transfer ("spinning in then planting").
- Climax dwell ≥1.0s after the intruder settles — this is where the new
  content gets read.

## Combinations
`hacker-flip-3d` (intruder text reveals via hacker-flip during entry) ·
`sine-wave-loop` (idle breathing on the intruder during dwell) ·
`vertical-spring-ticker` (intruder as a ticker that "shoves" prior content out).

## vendor 全文参照 (full detail)
Full recipe (impact-rotation, vertical collision, wobble-after-settle, multi-
victim ripple): vendor `.../rules/reactive-displacement.md`.
