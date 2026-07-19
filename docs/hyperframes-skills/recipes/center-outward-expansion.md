# Center-Outward Expansion

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/center-outward-expansion.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Elements start clustered at screen center and radiate outward to their final
layout positions, in lockstep via a shared progress value. Serves
**grid-card-assemble** and **diagram/labeled**. Can stand alone (per-item
stagger) or be DRIVEN by another animation's progress (e.g. a counter) for a
synced "chord" beat.

## 構造 (structure)
- `.burst-wrap` (`place-items:center`) holds `.burst-item`s, each pinned at
  `top:50%;left:50%;transform:translate(-50%,-50%)` — the centering trick.
- Targets are set ONCE in CSS/`data-*` attributes (`data-target-x/y`); GSAP
  tweens `x`/`y` offsets from `0` (center) toward the target in lockstep.
- No tracks/z-index — items are same-layer, differentiated only by position.

## コード骨子 (skeleton)
```css
.burst-item { position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%); will-change: transform; }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
items.forEach((el, i) => {
  const targetX = Number(el.dataset.targetX), targetY = Number(el.dataset.targetY);
  tl.fromTo(el, { xPercent: -50, yPercent: -50, x: 0, y: 0, scale: 0.6, opacity: 0 },
    { x: targetX, y: targetY, scale: 1, opacity: 1, duration: EXPAND_DUR, ease: "power3.out" },
    i * STAGGER + ENTRY_AT);
});
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte** — targets are static CSS/`data-*` constants set once, never a runtime
  measurement; fully deterministic under seek.
- **`fromTo` explicit start state** (not `from`) so a t=0 seek renders items
  correctly clustered at center, not at their final CSS position.
- Use `translate`, never `left`/`top`, for the outward motion — it composes
  cleanly with the `translate(-50%,-50%)` centering trick; mutating `left`/`top`
  fights it and causes pixel jitter.
- Out-easing only (`power2.out`/`power3.out`/`expo.out`) — `in` easing reads as
  items being sucked back toward center, not flung outward.
- If driven by a counter/beat, share the SAME duration + ease as the driver so
  both land as one chord, not an arpeggio.
- GSAP required for the staggered `fromTo`; timeline paused, finite stagger only.

## 値の目安 (value defaults)
- `ITEM_COUNT` 3–8 (more causes visual chaos where cards overlap mid-expansion).
- `EXPAND_DUR` 1.0–1.8s; `STAGGER` 0.04–0.08s (tighter = simultaneous chord,
  looser = lazy arpeggio); `ITEM_COUNT × STAGGER` should stay `< EXPAND_DUR`.
- If driven by a counter, `EXPAND_DUR`/ease must equal the counter's — a chord,
  not two separate beats.

## vendor 全文参照 (full detail)
Full recipe (synced-expansion-by-counter variant, partially-spread start,
stagger/count ranges): vendor `.../rules/center-outward-expansion.md`.
