# Camera Cursor Tracking

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/camera-cursor-tracking.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A two-phase virtual camera that keeps a horizontally-growing element (typed
search bar, growing URL) in frame: static Phase 1, then Phase 2 tracks the
focal point at a fixed screen fraction. Serves **code-card** and **typewriter**.
⚠️ perceptual-risk — read the seek-safe note before using.

## 構造 (structure)
- `.viewport` (`overflow:hidden`) clips `.world` (`transform:translateX(0)`,
  `white-space:nowrap`), which holds the growing text + inline cursor.
- Phase math: `finalWorldX = Math.min(INITIAL_OFFSET, trackingOffset)` — this
  keeps the static→tracking handoff mathematically continuous, no jump.
- No tracks/z-index — single flat world layer.

## コード骨子 (skeleton)
```css
.viewport { overflow: hidden; display: flex; padding-left: {VIEWPORT_PAD_LEFT}; }
.world { white-space: nowrap; transform: translateX(0); }
```
```js
// Measure ONCE at setup, behind __ready — see seek-safe note.
window.__hyperframes.__ready = (async () => {
  await document.fonts.ready;
  const fullWidth = textEl.scrollWidth;
  const trackingDelta = Math.max(0, VIEWPORT_PAD_LEFT + fullWidth - CURSOR_TARGET_FRACTION * VIEWPORT_WIDTH);
  const tl = (window.__timelines = window.__timelines || {});
  const t = gsap.timeline({ paused: true });
  t.to(".world", { x: -trackingDelta, duration: TRACK_DUR, ease: "power2.inOut" }, TRACK_START);
  window.__timelines['<composition-id>'] = t;
})();
```

## seek-safe 注意点 (Cutflow adaptations)
- **⚠️ perceptual-risk (measure+zoom, P0)**: `scrollWidth`/`getBoundingClientRect`
  feeding a camera translate is a byte-determinism hazard (per-frame AA jitter,
  YMAX~60-120). **Measure ONCE at setup behind `window.__hyperframes.__ready`,
  never per-frame.** Expect perceptual, not byte-exact, re-render equality.
- Vendor's upstream synchronous-build note (no `fonts.ready` gate, to dodge
  worker-race flicker) does NOT apply to Cutflow: the interpreter awaits
  `HF.__ready` AND `document.fonts.ready` before seeking, so gating measurement
  behind `__ready` is the correct and required Cutflow pattern — do the opposite
  of the vendor's raw-HTML advice here.
- Cursor blink: finite `sin()`-driven or `yoyo` tween, never CSS `@keyframes` —
  desyncs from seek.
- `overflow:hidden` on `.viewport`; camera pan ease `power2.inOut`, never `back.out`
  (overshoot reads as UI bounce, not camera).
- GSAP required; timeline paused, registry key = composition id.

## 値の目安 (value defaults)
- `CURSOR_TARGET_FRACTION` 0.5 (center-tracked) → 0.75 (right-leaning, more
  revealed text stays visible behind the cursor).
- `TRACK_DUR` 0.8–2.0s (under 0.5s snaps, over 2.5s drags); `REVEAL_DUR` scaled
  by character count, cadence 0.05–0.15s/char.

## vendor 全文参照 (full detail)
Full recipe (centered/right-tracked variations, continuous typing driver): vendor
`.../rules/camera-cursor-tracking.md`.
