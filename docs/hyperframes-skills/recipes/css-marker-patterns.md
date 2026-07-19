# CSS Marker Patterns

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/css-marker-patterns.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Pure CSS + GSAP implementations of five marker/emphasis modes over text —
**highlight** sweep, **circle**, **burst**, **scribble** underline, **sketchout**
strikethrough — with no external library dependency. Serves **explainer-card**,
**kinetic-typography**, and **diagram/labeled** as an emphasis accent on a word
or phrase.

## 構造 (structure)
- Each mode wraps the target text in a `position:relative` span with a sibling
  marker layer (`z-index:0`, behind the `z-index:1` text): a bar (highlight), a
  ring (circle), radiating line spans (burst), an SVG path (scribble), or two
  crossed line spans (sketchout).
- All marker layers start at `scale(0)`/`opacity:0` (or `clip-path`/`dashoffset`
  fully hidden) and are revealed by a GSAP tween keyed to the caption's timing.

## コード骨子 (skeleton)
```css
.mh-highlight-bar { transform:scaleX(0); transform-origin:left center; z-index:0; }
.mh-circle-ring   { transform:translate(-50%,-50%) rotate(-3deg) scale(0); }
.mh-burst-line    { transform:rotate(var(--angle)); transform-origin:bottom center; opacity:0; }
```
```js
tl.to('#hl-1', { scaleX: 1, duration: 0.5, ease: 'power2.out' }, 0.6);              // highlight
tl.to('#circle-1', { scale:1, rotation:-3, duration:0.6, ease:'back.out(1.7)' }, 0.7); // circle
// scribble: measure once, draw via stroke-dashoffset (same mechanism as svg-path-draw)
const len = path.getTotalLength();
gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
tl.to(path, { strokeDashoffset: 0, duration: 0.8, ease: 'power1.inOut' }, 0.7);
```

## seek-safe 注意点 (Cutflow adaptations)
- **Vary burst line lengths** (40–80px range) for an organic feel — equal
  lengths read as mechanical/computer-generated.
- Circle mode's `back.out(1.7)` wobble is the one place overshoot is idiomatic
  here (a hand-drawn ring settling) — still finite, no repeat.
- Scribble's `getTotalLength()` feeds a static dasharray value, same as
  `svg-path-draw` — not a measure+zoom hazard.
- Mode-cycling across caption groups (`MODES[gi % MODES.length]`) must be
  index-derived, never `Math.random`, to stay deterministic under seek.
- No CSS `@keyframes`/`transition` on any marker layer — GSAP timeline only, or
  it desyncs from HF's frame-by-frame seek.
- GSAP required for the reveal timing (mostly CSS for the shapes themselves);
  pinned CDN + `data-hf-requires="gsap"` + paused timeline. Byte tier.

## 値の目安 (value defaults)
- Highlight sweep duration ~0.5s, `power2.out`; multi-line highlight staggers
  bars ~0.3s apart.
- Circle ring sized 130–160% of the word's width/height so it clears the text
  with breathing room; tighter for short words, looser (ellipse) for long ones.
- Burst: 8–12 radiating lines, lengths varied 40–80px, stagger ~0.03s.
- Mode-cycling across caption groups: cycle every 2–3 groups for high energy,
  every 4–5 for a calmer register.

## Combinations
`kinetic-beat-slam` (finale underline/circle accent) ·
`svg-path-draw` (shares the scribble mode's dash-offset draw mechanism) ·
any caption-heavy card (explainer-card, diagram/labeled) as an emphasis layer.

## vendor 全文参照 (full detail)
Full recipe (all 5 modes' full markup, wavy-path generator, strikethrough
variant): vendor `.../rules/css-marker-patterns.md`.
