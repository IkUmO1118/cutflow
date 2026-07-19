# Vertical Spring Ticker

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/vertical-spring-ticker.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Slot-machine vertical scroll: a masked column steps through states with a
snappy "click-click" cadence (not a smooth linear scroll). Serves **stat/count-up**
and **kinetic-typography**. Distinct from a marquee/ticker loop (see
`sine-wave-loop` note) — this is discrete stepped settling, not continuous motion.

## 構造 (structure)
- `.ticker` (`overflow:hidden`, fixed height = one item's height) masks a
  `.stack-inner` column (`flex-direction:column`) of `.item`s, all the SAME height.
- Translate of `.stack-inner` = `-ITEM_HEIGHT × sum(spring_i.progress)` — each
  spring contributes one discrete step; summing (not replacing) is the trick.
- No tracks/z-index — one flat masked column.

## コード骨子 (skeleton)
```css
.ticker { height: 204px; overflow: hidden; } /* MUST equal .item height */
.stack-inner { display: flex; flex-direction: column; will-change: transform; }
.item { height: 204px; font-variant-numeric: tabular-nums; } /* if numeric */
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const springs = Array.from({ length: STEPS }, () => ({ p: 0 }));
function applyTransform() {
  const sumP = springs.reduce((a, s) => a + s.p, 0);
  innerEl.style.transform = `translateY(${-sumP * ITEM_HEIGHT}px)`;
}
applyTransform();
springs.forEach((spring, i) => {
  tl.to(spring, { p: 1, duration: 0.45, ease: "back.out(1.7)", onUpdate: applyTransform },
       STEP_START + i * STEP_SPACING);
});
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- Sum springs in `onUpdate`, don't tween the final position directly — the
  additive form is what produces the discrete-click cadence under frame seek.
- `STEP_SPACING ≤ STEP_DUR` (overlap) — non-overlapping steps read as a linear
  scroll instead of "click-click".
- **No `innerHTML` swaps between steps** — the same items translate; replacing
  content mid-scroll breaks the illusion and desyncs on re-seek.
- No CSS `transition` on `.stack-inner` — competes with the additive transform.
- **GSAP required** for the summed onUpdate; pinned CDN + `data-hf-requires="gsap"`;
  timeline paused, finite steps only (no `repeat:-1`).
- Container/item height must match pixel-exact or items partially peek past the mask.

## 値の目安 (value defaults)
- `STEP_DUR` 0.3–0.7s; `STEP_SPACING` 0.3–0.5s and `≤ STEP_DUR` (the overlap is
  what makes steps additive).
- `BOUNCE_FACTOR` (`back.out`) 1.4 (gentle click) → 2.0 (firm) → 2.5+ (casino climax).

## vendor 全文参照 (full detail)
Full recipe (numeric/reverse variants, bounce tuning, pause-between-groups): vendor
`.../rules/vertical-spring-ticker.md`.
