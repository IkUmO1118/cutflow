# Motion-Blur Streak

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/motion-blur-streak.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Fakes directional velocity blur on a fast entrance or camera push-through (real
per-frame motion blur has no meaning under a seeked/paused renderer). Serves
**titlecard-reveal** and **logo-assemble**. Entrances/mid-shot moves ONLY — never
a mid-composition exit (that reads as a glitch; exits are the transition's job).

## 構造 (structure)
Two paths, pick one:
- **(A) directional SVG blur** — inline `<filter>` with `<feGaussianBlur
  stdDeviation="X 0">` (X on the motion axis, 0 across it); GSAP tweens a
  proxy `{v}` and writes it via `setAttribute` each frame.
- **(B) echo/ghost trail** — 2–4 duplicate copies behind the lead at decreasing
  opacity, offset backward along the motion vector by index, collapsing onto
  the lead as it settles.
- Both share ONE ease/window with the position tween so peak-blur lands exactly
  on peak-speed and resolves to 0 exactly at the settle.

## コード骨子 (skeleton)
```js
// Path A — proxy tween writes the SVG attribute (GSAP can't tween it directly)
const blurProxy = { v: 18 };
const writeBlur = () => blurNode.setAttribute('stdDeviation', `${blurProxy.v} 0`);
writeBlur();   // seed frame 0 so t=0 seek shows the streaked start, not a sharp pre-frame
tl.fromTo('#streak-el', { x: -600, opacity:0 }, { x:0, opacity:1, duration:0.4, ease:'power4.out' }, 0.2);
tl.to(blurProxy, { v:0, duration:0.4, ease:'power4.out', onUpdate: writeBlur }, 0.2);  // SAME ease+window
```

## seek-safe 注意点 (Cutflow adaptations)
- **Blur peaks at peak speed, resolves to 0 at the settle** — the whole rule.
  Position and blur/echo MUST share the same `out`-family ease (`expo.out`/
  `power4.out`) and window; an `in`/`inOut` ease breaks the coupling.
- **Path A: seed `stdDeviation` once at setup**, before play, so a seek to
  `t=0` renders the streaked start rather than a momentarily-sharp pre-frame.
- **Path B: ghost offsets/opacity are index-derived** (`i*ECHO_STEP_PX`,
  `BASE/i`) — never `Math.random`.
- `overflow:hidden` on `.scene` — the smear/furthest ghost extends past the
  resting position during travel.
- Filter region generous (`x/y:-50%, width/height:200%`) or the smear clips at
  the box edge.
- Entrances only — never an exit on a non-final frame; earn a ≥1s sharp dwell
  after the snap.
- GSAP required (proxy-driven attribute tween or multi-echo coordination);
  pinned CDN + `data-hf-requires="gsap"` + paused timeline. Byte tier — all
  finite, no `repeat`/`Math.random`.

## 値の目安 (value defaults)
- `MOVE_DUR` 0.25–0.6s — over ~0.7s it stops reading as velocity blur and
  looks like a focus pull instead.
- Path A `PEAK_BLUR` 8 (subtle) – 18 (default) – 30 (extreme); ≤ ~30 or the
  element is unreadable for the first several frames.
- Path B ghost count 2–4 (>4 reads as a stutter/strobe); `ECHO_STEP_PX`
  12–40px; `GHOST_BASE_OPACITY` ≤ ~0.6 or ghosts read as duplicate elements.
- Heavy display weight (≥120px, ≥800 weight) so the smear has mass — thin type
  smears into invisibility.

## Combinations
`kinetic-beat-slam` (streak as the entrance for one phrase in a beat sequence) ·
`center-outward-expansion` (grid streak-in = center-expansion + velocity blur) ·
`scale-swap-transition` (alternative for a same-footprint swap, not an arrival).

## vendor 全文参照 (full detail)
Full recipe (vertical streak, camera push-through radial blur, staggered grid
streak-in): vendor `.../rules/motion-blur-streak.md`.
