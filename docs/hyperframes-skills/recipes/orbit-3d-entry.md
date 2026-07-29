# Orbit 3D Entry

> Compressed from `docs/hyperframes-vendor/skills-corpus/hyperframes-animation/rules/orbit-3d-entry.md`.
> FrameWright adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Icons/glyphs flip in from 3D space then settle into a **continuous** elliptical
orbit around a focal center — distinct from a one-shot reveal (the motion keeps
running). Serves **grid-card-assemble** and **logo-assemble** (icons orbiting a
brand mark). Distinct from `depth-scatter-assemble` (resolves flat, no orbit) and
`center-outward-expansion` (2D burst, no depth).

## 構造 (structure)
- `.scene` (`perspective` required) → `.orbit-stage` (`preserve-3d`) → N
  `.orbit-item` (each `position:absolute`, centered via `top/left:50%`) +
  `.orbit-center` (the headline, pushed forward via `translateZ` so the orbit
  never occludes it).
- Each item carries `data-angle` — its fixed initial position on the ellipse.
- z-index on orbit items is capped `[1,50]` (paint order inside `preserve-3d`
  follows Z, not stacking context) so the center label, pinned above via
  translateZ, is never covered.

## コード骨子 (skeleton)
```css
.scene { perspective: 1800px; }                 /* REQUIRED */
.orbit-stage { transform-style: preserve-3d; }
.orbit-item { position:absolute; top:50%; left:50%; will-change:transform; }
.orbit-center { transform: translateZ(220px); z-index: 9999; }  /* clearance */
```
```js
// ⚠️ CRITICAL: gsap.set() the orbital start BEFORE any tween — flip-in happens
// IN PLACE at the orbit position, never at center (else a mid-air teleport).
const a = (Number(el.dataset.angle) / 360) * Math.PI * 2;
gsap.set(el, { xPercent:-50, yPercent:-50, x: Math.cos(a)*RADIUS_X, y: Math.sin(a)*RADIUS_Y,
               rotateX: 90, rotateY: -45, z: -100, opacity: 0, scale: 0 });
tl.to(el, { rotateX:0, rotateY:0, z:0, opacity:1, scale:1,
            duration: 0.55, ease: 'back.out(1.4)' }, i * 0.10);
// orbit phase — 0→1 progress proxy, driven inside the timeline (no rAF)
const orbitState = { p: 0 };
tl.to(orbitState, { p: 1, duration: 12, ease: 'none', onUpdate: () => {
  const ang = a + orbitState.p * Math.PI * 2;
  el.style.transform = `translate(-50%,-50%) translate(${Math.cos(ang)*RADIUS_X}px,${Math.sin(ang)*RADIUS_Y}px)`;
}}, i * 0.10 + 0.55);
```

## seek-safe 注意点 (FrameWright adaptations)
- **⚠️ Entry must flip IN PLACE at orbital position** — `gsap.set()` every item to
  `(cos(angle)·RADIUS_X, sin(angle)·RADIUS_Y)` with `opacity:0` before adding any
  tween. Phase 1 animates only rotation/opacity/scale, never translate.
- Orbit runs via a `0→1` progress tween's `onUpdate`, not `requestAnimationFrame` —
  required so HF's frame-by-frame seek stays deterministic.
- **No `Math.random`** for orbit angle — each item's angle is a fixed `data-angle`.
- GSAP required (multi-phase per-item tweens + shared clock); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline keyed to `data-composition-id`. Byte tier.
- `perspective` + `preserve-3d` on stage AND each item — drop either and the flip-in
  reads as a flat scale, not a 3D reorientation.

## 値の目安 (value defaults)
- `RADIUS_X` 300–900px, `Y_TO_X_RATIO` 0.4–0.7 (perspective-flattened ellipse,
  keep < 1 or it reads as a frontal halo, not a tilted ring).
- `ORBIT_DURATION` 4–25s (short = frenetic, long = calm drift);
  `ENTRY_DUR` 0.4–0.8s, `STAGGER` 0.06–0.12s (cascade should finish before the
  orbit phase needs to feel continuous).
- Element count 4–12 — fewer feels empty, more crowds the center.
- Cap orbit-item `z-index` to `[1,50]` and push the center label forward via
  `translateZ` — `z-index` alone is unreliable inside `preserve-3d` (paint
  order follows Z, not stacking context).

## Combinations
`center-outward-expansion` (alternative burst entry; also the reversed driver
for a collapse finish) · `cursor-click-ripple` (center element as a CTA that
triggers the collapse) · `sine-wave-loop` (per-item idle wobble atop the orbit).

## vendor 全文参照 (full detail)
Full recipe (radius/ratio math, center-clearance formula, collapse-to-center
variant): vendor `.../rules/orbit-3d-entry.md`.
