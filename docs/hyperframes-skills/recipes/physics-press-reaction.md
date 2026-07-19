# Physics Press Reaction (Cursor + Element Synced)

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/physics-press-reaction.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Models a real click: a cursor approaches a button, lands, and both compress IN
SYNC, then release together. Serves **code-card** (UI demo). Distinct from
`press-release-spring` (button-only, no cursor) — this is the COMBINED cursor +
element behavior.

## 構造 (structure)
- `.stack` (button + brand) + a scene-root-level `.cursor` SVG so it can
  translate freely across the whole stage (`transform-origin:0 0` — the arrow
  tip, not center, is the click point).
- Single `PRESS_INTENSITY` value drives both cursor AND button scale together
  via one `tl.to(['#btn','#cursor'], {...})` call — not two separate tweens.
- Phases: approach (cursor→button center) → press-down (both compress) →
  release (both spring back) → optional cursor exit.

## コード骨子 (skeleton)
```css
.cursor { position:absolute; pointer-events:none; z-index:100; transform-origin:0 0; }
.btn { transform-origin:50% 50%; will-change:transform; }
```
```js
gsap.set('#cursor', { x: CURSOR_START_X, y: CURSOR_START_Y });
tl.to('#cursor', { x: BTN_CX, y: BTN_CY, duration:1.0, ease:'power2.inOut' }, 0);
// down/up frame must satisfy: PRESS_DOWN_AT === approach end (no "tapping on air")
tl.to(['#btn','#cursor'], { scale: 1 - PRESS_INTENSITY, duration:0.15, ease:'power1.in' }, 1.0);
tl.to(['#btn','#cursor'], { scale: 1, duration:0.5, ease:`back.out(${BOUNCE_FACTOR})` }, 1.15);
```

## seek-safe 注意点 (Cutflow adaptations)
- **Same press scale on cursor AND button, one array target** — if only the
  button scales the cursor appears to "tap on air"; if only the cursor scales
  the button feels disconnected.
- **Cursor must arrive before press starts**: `PRESS_DOWN_AT` must equal
  `APPROACH_START + APPROACH_DUR` exactly, or the press reads unattributed.
- `up-frame > down-frame` — release always after press.
- `#cursor` is `pointer-events:none` — purely decorative; never gates real
  interactivity.
- No real `mouseenter`/`click` events — HF is a render context, everything runs
  via the timeline.
- Climax dwell ≥1s after release.
- GSAP required (multi-target array tweens + phase adjacency); pinned CDN +
  `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- `APPROACH_DUR` 0.7–1.3s (faster = urgent, slower = deliberate);
  `PRESS_DOWN_DUR` 0.1–0.25s; `RELEASE_DUR` 0.4–0.7s.
- `PRESS_INTENSITY` 0.05 (subtle) – 0.10 (standard) – 0.15 (heavy), applied as
  `scale: 1 - PRESS_INTENSITY` on both cursor and button in one call.
- `BOUNCE_FACTOR` 1.6 (soft) – 2.0 (firm) – 2.4 (cartoony) on the release.
- Cursor start position should be off-screen or a far corner so the approach
  reads as motion-in, not a teleport.

## Combinations
`press-release-spring` (the BUTTON-only variant; this rule layers a cursor on
top) · `cursor-click-ripple` (adds a ripple at the click point) ·
`scale-swap-transition` (the press can TRIGGER the swap).

## vendor 全文参照 (full detail)
Full recipe (multi-element chain press, hold-press with pulsing inner glow,
value ranges): vendor `.../rules/physics-press-reaction.md`.
