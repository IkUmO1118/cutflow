# Viewport Change

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/viewport-change.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Virtual camera on ONE `.world` wrapper: `translate(x,y) scale(S)`, a single
continuous zoom/pan/focus-lock (vs `multi-phase-camera`'s discrete phases +
drift). Serves **diagram/labeled**. ⚠️ **Note the ×S delta from
`coordinate-target-zoom`** — this rule's counter-translate is `T = -offset × S`
(single wrapper, scale applied first), NOT `T = -offset` (nested wrappers).

## 構造 (structure)
- `.scene` (`overflow:hidden`, background here) wraps `.world`
  (`transform-origin:50% 50%`), which wraps all content in world space.
- A single `cam = {scale, x, y}` state object is the one source of truth; every
  tween that touches camera writes through one `applyCamera()` that composes
  the transform string — never split scale/translate across separate writers.
- No tracks/z-index — one flat world layer.

## コード骨子 (skeleton)
```css
.scene { overflow: hidden; } .world { transform-origin: 50% 50%; will-change: transform; }
```
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const cam = { scale: 1, x: 0, y: 0 };
function applyCamera() { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`; }
applyCamera();
// T = -offset × S (single-wrapper form; differs from coordinate-target-zoom's T=-offset)
const counterY = -TARGET_OFFSET_Y * TARGET_SCALE;
tl.to(cam, { scale: TARGET_SCALE, y: counterY, duration: ZOOM_DUR, ease: "power3.inOut", onUpdate: applyCamera }, ZOOM_START);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **perceptual-risk if the focal offset is measured** (`getBoundingClientRect`)
  rather than laid out from known CSS geometry — measure ONCE at setup behind
  `window.__hyperframes.__ready`, never per-frame; expect perceptual not byte
  equality. **byte if the offset is a scripted/known constant.**
- **Transform-order gotcha (the whole point of this recipe)**: single-wrapper
  `translate(x,y) scale(S)` applies scale FIRST, so `T = -offset × S`. Do not
  reuse `coordinate-target-zoom`'s `T = -offset` formula here — it drifts
  off-center as `S` changes.
- Single `cam` object + one `applyCamera()` — never write scale and translate
  from two separate `onUpdate`s or the composed transform string order is unstable.
- `overflow:hidden` on `.scene`; background on `.scene` never `.world`.
- GSAP required; timeline paused, `will-change:transform` on `.world`.

## 値の目安 (value defaults)
- `TARGET_SCALE`: 1.02–1.05 subtle / 1.05–1.15 "ta-da" / 1.15–1.30 noticeable /
  1.5+ dramatic. Perception: <5% imperceptible, 10–15% comfortable, >30% cinematic.
- `ZOOM_DUR` 1.0–2.0s (under 0.8s teleports, over 2.5s drags).
- Prefer subtle continuous motion (1.05–1.15×) for product feel; save >1.3×
  zooms for a dramatic narrative moment.

## vendor 全文参照 (full detail)
Full recipe (focus-lock follow variant, composite multi-phase scale, scale
perception table): vendor `.../rules/viewport-change.md`.
