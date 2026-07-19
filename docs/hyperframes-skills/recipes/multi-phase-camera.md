# Multi-Phase Camera

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/multi-phase-camera.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Sequential camera zoom through 2-3 discrete phases (pull-back → focus → push)
plus continuous sine micro-drift, for cinematic pacing (anticipation → reveal →
settle). Serves **diagram/labeled**. Distinct from `viewport-change` (one
continuous zoom/pan, often focus-lock) — this is stepped phases + drift.

## 構造 (structure)
- `.scene` (`overflow:hidden`) wraps `.camera` (`transform-origin:50% 50%`),
  which wraps all content — the camera wraps EVERYTHING, never per-element.
- `phase.scale` steps through `PHASE_1→2→3` via sequential tweens on a plain
  state object; a separate sine `drift` tween ADDS a small translate on top,
  both composed in one `onUpdate` write to `camera.style.transform`.
- Background lives on `.scene`, never `.camera` (else scaling reveals the void).

## コード骨子 (skeleton)
```css
.scene { overflow: hidden; } /* required whenever any phase scale < 1 */
.camera { transform-origin: 50% 50%; will-change: transform; }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const phase = { scale: PHASE_1_SCALE };
tl.to(phase, { scale: PHASE_2_SCALE, duration: PHASE_2_DUR, ease: "power2.out" }, PHASE_2_AT);
tl.to(phase, { scale: PHASE_3_SCALE, duration: PHASE_3_DUR, ease: "power3.out" }, PHASE_3_AT);
const drift = { p: 0 };
tl.to(drift, { p: Math.PI * 2 * DRIFT_CYCLES, duration: TOTAL_DURATION, ease: "none", onUpdate: () => {
  const dx = Math.sin(drift.p) * DRIFT_AMP_X, dy = Math.sin(drift.p * 1.3) * DRIFT_AMP_Y;
  camera.style.transform = `scale(${phase.scale}) translate(${dx}px, ${dy}px)`;
} }, 0);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **byte for scripted phase scale** (no measurement) — the base 3-phase scale
  plan is deterministic. **perceptual-risk if the "targeted zoom into off-center
  element" variation is used** (it reads `getBoundingClientRect()`): then
  measure ONCE at setup behind `window.__hyperframes.__ready`, never per-frame;
  expect perceptual not byte equality.
- Drift X/Y at slightly different frequencies (ratio ≈1.3) so motion isn't a
  perfect diagonal (reads mechanical); amplitude imperceptible per-frame.
- `overflow:hidden` on `.scene` mandatory whenever any phase scale < 1.
- Ease family: `power2.out`/`power2.inOut`/`power3.out` only — `back.out` on a
  camera reads as an uncomfortable UI bounce, not a camera move.
- Drift is a **finite** sine sweep (`p: 2π×N cycles` over a fixed duration),
  never `repeat:-1`. GSAP required; timeline paused.

## 値の目安 (value defaults)
- Scale spread: PHASE_1 0.88–0.96, PHASE_2 0.98–1.02, PHASE_3 1.04–1.15.
- `DRIFT_CYCLES` 1–3 (higher reads as mechanical wobble, not organic drift);
  `DRIFT_AMP` a few px — imperceptible per-frame, visible over time.

## vendor 全文参照 (full detail)
Full recipe (phase-pattern table, camera-shake variant, targeted-zoom math):
vendor `.../rules/multi-phase-camera.md`.
