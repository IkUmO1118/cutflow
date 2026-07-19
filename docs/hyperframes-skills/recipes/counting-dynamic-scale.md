# Counting Dynamic Scale

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/counting-dynamic-scale.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A counter whose transform `scale` grows in lockstep with the number, adding
visual weight without tweening `font-size`. Serves **stat/count-up**. Pair with
`stat-bars-and-fills` for the graphic half of the beat.

## 構造 (structure)
- One `class="clip"` stage; a fixed-width `.counter-wrap` holds `.counter` (the
  number, static final `font-size` in CSS) + optional `.counter-suffix`.
- A single paused timeline drives two synchronized tweens at the same position:
  the numeric value (`onUpdate` writes `textContent`) and `.counter`'s `scale`.
- No tracks — visibility is the clip window; layers only need z-index if a
  suffix/label overlaps.

## コード骨子 (skeleton)
```css
.counter { font-variant-numeric: tabular-nums; /* MANDATORY */
  font-size: {endSize}; transform-origin: center; } /* static size, never tweened */
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const state = { value: 0 };
const START_SCALE = START_SIZE / END_SIZE;
tl.to(state, { value: TARGET_VALUE, duration: 1.6, ease: "power3.out",
  onUpdate: () => { counter.textContent = Math.round(state.value).toLocaleString(); } }, 0);
tl.fromTo(counter, { scale: START_SCALE }, { scale: 1, duration: 1.6, ease: "power3.out" }, 0);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- `onUpdate` is O(1): `Math.round` + `textContent` only, no style writes beyond
  the separate scale tween — HF/Cutflow seeks call this every frame.
- **`Math.round` not `Math.floor`** — mid-integer seeks should show the final
  value briefly, not the previous one.
- `tabular-nums` is mandatory — without it, digit-count changes (9→10→100)
  jitter the layout under any seek.
- Value tween and scale tween share position `0` + same duration/ease so they
  land as one beat, not an arpeggio.
- Avoid `back.out`/`elastic.out` on the counter itself — overshoot reads as
  unstable data; save bounce for a paired graphic.
- **GSAP unnecessary in principle** (two tweens could be WAAPI), but sharing one
  ease/duration exactly is simplest as one paused GSAP timeline — either is fine;
  keep it byte tier (DOM writes only).

## 値の目安 (value defaults)
- `START_SIZE` ≈ 40–60% of `END_SIZE` (smaller = more dramatic growth).
- `COUNT_DUR` 1.2–2.5s — below ~0.8s reads as a flash, not a count.
- Ease: `power2.out` (default) → `power3.out` (dramatic, recommended) →
  `expo.out` (very dramatic); never `back.out`/`elastic.out` on the number itself.
- Fixed-width container as belt-and-suspenders — even with `tabular-nums`,
  glyph shape changes can still shift baselines slightly.

## vendor 全文参照 (full detail)
Full recipe (ease table, suffix/label beats, 3D depth-entry variant): vendor
`.../rules/counting-dynamic-scale.md`.
