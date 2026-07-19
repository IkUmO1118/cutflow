# AI Tracking Box

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/ai-tracking-box.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A bounding box with L-bracket corner markers that tracks a moving target,
simulating real-time AI object detection. Serves **diagram/labeled**. Genre
convention: detection yellow (`#facc15`) on a dark background — any other hue
loses the "AI HUD" read.

## 構造 (structure)
- `.scene` (dark radial bg) → `.bg-mascot` (the tracked target) + `.track-box`
  (`position:absolute`, size/position written per-frame) containing 4 `.corner`
  divs (two-sided borders, not a full box outline — that's the genre signature)
  and a `.label` tag showing class + confidence %.
- Box position/size are **recomputed every frame from the target's position**,
  never tweened independently — the box must never lag the target.

## コード骨子 (skeleton)
```css
.corner.tl { border-top:6px solid #facc15; border-left:6px solid #facc15; }
.track-box { position:absolute; pointer-events:none; will-change:transform,width,height; }
```
```js
// entry: fade+scale in, then continuous scripted tracking (NOT measured/tweened)
tl.to(box, { opacity:1, scale:1, duration:0.5, ease:'back.out(1.4)' }, 0.5);
const tracking = { p: 0 };
tl.to(tracking, { p: Math.PI*2*1.5, duration:4, ease:'none', onUpdate: () => {
  const mx = CX + Math.cos(tracking.p)*80, my = CY + Math.sin(tracking.p)*50;
  const w = 320 + Math.sin(tracking.p*2.3)*30, h = 320 + Math.sin(tracking.p*2.3+Math.PI/2)*30;
  box.style.width = `${w}px`; box.style.height = `${h}px`;
  box.style.left = `${mx - w/2}px`; box.style.top = `${my - h/2}px`;
  label.textContent = `${GLYPH} ${LABEL} · ${Math.round(97 + Math.sin(tracking.p*4)*2)}%`;
}}, 1.0);
```

## seek-safe 注意点 (Cutflow adaptations)
- **Box position/size is a scripted trig function of timeline time, not a
  measurement + zoom** — `onUpdate` writes width/height/left/top directly from
  `Math.sin`/`Math.cos` of the progress proxy. That keeps it byte-stable (no
  `getBoundingClientRect`), unlike `coordinate-target-zoom`'s hazard.
- No CSS `animation` on box/corners — must be timeline `onUpdate`, or HF's seek
  desyncs from the tracking math.
- Confidence flicker stays inside a tight band (95–99%); outside that reads as
  "uncertain" or "fake-precise" — keep `CONFIDENCE_VAR` small (1–3).
- Size jitter is subtle (~5–10% of base size) — too much reads as a broken
  detector, none reads as a static UI screenshot.
- GSAP required (per-frame `onUpdate` writing multiple styles); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier (DOM style writes only,
  all derived from deterministic trig — no `Math.random`).

## 値の目安 (value defaults)
- `{detectionYellow}` is a discrete genre convention (`#facc15`/`#FCD34D`
  family) on a dark navy/near-black background — other hues lose the "AI
  detection" read entirely; this isn't a tunable color, it's a signal.
- `TRACK_DUR` 2–8s with `CYCLES` 0.5–3 oscillations (keep effective Hz < ~0.6 or
  the drift blurs); `SIZE_VAR` ~5–10% of `SIZE_BASE`.
- `CONFIDENCE_MEAN` 95–99 with `CONFIDENCE_VAR` 1–3 — 100 reads "fake-precise,"
  below 95 reads "uncertain."
- L-brackets, not a full border — the corner-only outline is the genre
  signature; a full box reads as a generic UI element, not a detector.

## Combinations
`viewport-change` (zoom into the tracked box after detection) ·
`multi-phase-camera` (wide shot during tracking, push-in on lock) ·
`sine-wave-loop` (the mascot idle-breathes inside the box).

## vendor 全文参照 (full detail)
Full recipe (drift/size/confidence value ranges, multi-object detection, lost-then-
reacquired variant): vendor `.../rules/ai-tracking-box.md`.
