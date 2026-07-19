# Sine Wave Loop

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/sine-wave-loop.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Keeps a settled element from feeling dead, as **subtle jitter** or (rarely) a
single bounded ambient breath. Serves any card as an idle layer. **Reach for this
last**: prefer sequential reveal timed to the VO first, then low-amplitude jitter,
before a full breathing loop — circular "breathing = alive" is the cheap,
reflexive move and reads weak at the upper amplitude end.

## 構造 (structure)
- No new DOM — this rule adds a phase-driven `onUpdate` on top of an element
  that has already landed from its own entrance tween.
- A single long tween advances `phase.p` from `0 → 2π·CYCLES`; `onUpdate` feeds
  `Math.sin(phase.p)` into `scale`/`y`/`rotation` offsets **added to** the
  element's resting transform, never replacing it.
- `sin(0) = 0` at the moment idle starts — the offset is exactly zero, so there
  is no jump from the entry's settled state into the breathe.

## コード骨子 (skeleton)
```css
.hero { will-change: transform; }   /* idle only ADDS to the post-entry transform */
```
```js
const phase = { p: 0 };
tl.to(phase, {
  p: Math.PI * 2 * CYCLES,           // e.g. CYCLES = IDLE_DUR / 2.8
  duration: IDLE_DUR, ease: 'none',  // sine itself carries the curve
  onUpdate: () => {
    const s = Math.sin(phase.p);
    hero.style.transform = `translateY(${s * Y_AMP_PX}px) scale(${1 + s * SCALE_AMP})`;
  },
}, IDLE_START_TIME);                 // ≥ entry end + ~0.1s buffer
```

## seek-safe 注意点 (Cutflow adaptations)
- **Amplitude defaults to the LOW end** — scale `0.008–0.015`, translate `±2–3px`.
  Push higher only for an isolated hero in a short (<6s), kinetic-brief scene.
- **Finite repeats only** — this is a single long tween over `IDLE_DUR`, never
  `repeat:-1`/`yoyo` looping forever; `ease:'none'` on the phase tween (the sine
  itself provides the easing curve).
- Compose, don't replace: idle output must add to the entry's resting transform.
- N concurrent idle elements: shrink amplitude by `/√N` and stagger periods
  (2.1s/1.9s/2.4s) — synced motion on several elements compounds into a shimmer.
- No CSS `@keyframes` for idle — the browser's render clock desyncs from HF's
  seek clock; drive it inside the GSAP timeline only.
- GSAP required (phase proxy + `onUpdate`); pinned CDN + `data-hf-requires="gsap"`
  + paused timeline. Byte tier.

## 値の目安 (value defaults)
- Cycle period 2.5–4s for a long idle window, 1.5–3s otherwise — under 1.5s
  feels frantic, over 4s feels lifeless in a short scene.
- Long idle (`IDLE_DUR > 6s` or >30% of the composition): halve the amplitudes
  and slow `CYCLES` so each breath is 3–4s; consider fading amplitude to zero
  over the last ~20% so the scene visibly settles before the next transition.
- Concurrent idle on N elements: amplitude ≤ default `/√N` per element, with
  staggered periods (e.g. 2.1s/1.9s/2.4s) — synced motion on several elements
  reads mechanical, not alive.
- Different elements offset by `Math.PI/2` (90°) so they're not moving in
  lockstep.

## Combinations
After `press-release-spring` (button idle-breathes post-release) ·
`counting-dynamic-scale` (final number breathes) ·
`card-morph-anchor` (settled card idle-bobs) ·
`orbit-3d-entry` (center label breathes while items orbit).

## vendor 全文参照 (full detail)
Full recipe (multi-octave breathing, settle-and-fade envelope for long idles,
period/cycle math): vendor `.../rules/sine-wave-loop.md`.
