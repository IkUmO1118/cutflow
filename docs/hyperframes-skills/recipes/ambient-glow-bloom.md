# Ambient Glow Bloom

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/ambient-glow-bloom.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A soft radial glow blooms **un-triggered** behind a hero element (card/logo/
metric) and holds, giving it presence. Serves **chapter-title**,
**titlecard-reveal**, and **stat/count-up** (accent halo behind a landed metric).
Distinct from `press-release-spring`'s click-triggered burst and
`asr-keyword-glow`'s word-timed envelope — this one just blooms on settle.

## 構造 (structure)
- `.bloom-glow` (radial gradient, `z-index` BELOW the hero, negative `inset` so
  the halo extends past the hero edges) + `.hero-card` (`z-index` above).
- Two forms: **hero bloom** (opacity/scale swell in, then a bounded idle breathe
  during the hold) or **traveling sweep** (a narrow highlight band crosses a
  clipped `.surface` exactly once, no loop, no return).

## コード骨子 (skeleton)
```css
.bloom-glow { position:absolute; z-index:1; opacity:0; transform:scale(.85);
              pointer-events:none; will-change:transform,opacity; }
.hero-card  { position:relative; z-index:2; }
```
```js
tl.fromTo(glow, { opacity:0, scale:.85 },
                 { opacity: PEAK, scale:1, duration:0.9, ease:'power2.out' }, BLOOM_START);
// bounded breathe — phase proxy, NOT repeat:-1
const phase = { p: 0 };
tl.to(phase, { p: Math.PI*2*3, duration: 4, ease:'none', onUpdate: () => {
  const s = Math.sin(phase.p);
  glow.style.opacity = String(PEAK + s*0.03);
  glow.style.transform = `scale(${1 + s*0.02})`;
}}, BLOOM_START + 0.9);
```

## seek-safe 注意点 (Cutflow adaptations)
- **Peak opacity ≤ ~0.45** — higher washes the frame and the hero loses contrast
  against its own glow; default range is 0.15–0.30.
- **Breathe is BOUNDED, never a loop** — a finite `onUpdate` tween reading the
  phase proxy, not `repeat:-1`/`yoyo`. `sin(0)=0` so it starts exactly at the
  bloom's resting state, no jump. Same discipline as `sine-wave-loop`.
- **Sweep is ONE pass** — enters fully off one edge, exits fully off the other, a
  single time; a repeating sweep reads as a loading shimmer, not a reveal accent.
- Land glow and hero as one beat: time `BLOOM_START + BLOOM_DUR` to the hero's
  settle frame, not before/after it.
- N concurrent halos compound — shrink amplitude by `/√N`, stagger breathe
  periods (2.6s/2.9s/3.3s).
- GSAP required (bloom-in tween + bounded breathe phase); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier. No `Math.random`.

## 値の目安 (value defaults)
- Bloom-in 0.6–1.4s (align its end with the hero's settle frame so both land
  together, not glow-then-card or card-then-glow).
- Breathe period 2.5–4s (slower than element-level breathing in
  `sine-wave-loop` — glow wants a slower ambient pulse).
- Sweep: travel 0.8–1.6s, endpoints fully off-surface (`-(width+edge)` to
  `surfaceWidth+edge`) so the band never spawns/despawns mid-frame.
- Glow color darker + more saturated than the element it backs — same-hue,
  same-lightness glow disappears into the surface.

## Combinations
`sine-wave-loop` (pair the hero-bloom breathe with a sine breathe on the hero
itself, slightly out of phase) · `press-release-spring` (distinct sibling —
that burst is click-triggered, this one is not) ·
`stat-bars-and-fills` (glow blooms behind the hero metric as it lands).

## vendor 全文参照 (full detail)
Full recipe (bloom-and-hold, pulse-on-arrival, multi-hero relay, diagonal sweep
variants): vendor `.../rules/ambient-glow-bloom.md`.
