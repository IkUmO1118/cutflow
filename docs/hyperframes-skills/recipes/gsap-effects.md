# GSAP Effects (drop-in blocks)

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/gsap-effects.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A grab-bag of drop-in GSAP timeline blocks that don't warrant their own recipe:
**typewriter** (character-by-character reveal, cursor blink, backspace, word
rotation) and **audio visualizer** (pre-extracted audio data driving Canvas/DOM
from the timeline). Serves **typewriter**, **kinetic-typography**, and
**stat/count-up**. This recipe stays intentionally thin — see vendor for the
full choreography set.

## 構造 (structure)
- Typewriter: `TextPlugin` registered, one `<span>` for text + one `<span>` for
  a blinking cursor, flush with no gap between them.
- Audio visualizer: audio features are extracted OFFLINE to a JSON file
  (`{fps, frames:[{time, rms, bands}]}`), loaded synchronously (inline or sync
  XHR — never async `fetch`), then a `tl.call(...)` per frame index drives
  Canvas/DOM rendering from `rms`/`bands`.

## コード骨子 (skeleton)
```js
// Typewriter — chars-per-second controls pacing (3-5 dramatic .. 15-20 energetic)
gsap.registerPlugin(TextPlugin);
tl.to('#typed-text', { text: { value: TEXT }, duration: TEXT.length / CPS, ease: 'none' }, 0);
```
```js
// Audio visualizer — data loaded SYNCHRONOUSLY (no async fetch/.then)
var AUDIO_DATA = /* parsed audio-data.json */;
for (let f = 0; f < AUDIO_DATA.totalFrames; f++) {
  tl.call(() => {
    const frame = AUDIO_DATA.frames[f];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // draw using frame.rms / frame.bands
  }, [], f / AUDIO_DATA.fps);
}
```

## seek-safe 注意点 (Cutflow adaptations)
- **Cursor blink pattern**: one cursor visible at a time; blink → solid (typing
  starts) → type → solid → blink (done). Never `hidden → solid` directly.
- **Backspace needs manual substring removal** — `TextPlugin` only removes from
  the front, wrong direction for backspacing.
- **Audio data must load synchronously** — HF reads `window.__timelines`
  synchronously after page load; building the timeline inside a `fetch().then()`
  means it isn't ready when capture starts.
- No Web Audio API at render time — there's no real playback during a seek;
  audio features are pre-extracted offline (ffmpeg + numpy) into JSON.
- GSAP + `TextPlugin` (typewriter) required via pinned CDN +
  `data-hf-requires="gsap"`; register the paused timeline under the card's
  `data-composition-id`. Byte tier (deterministic frame-indexed `tl.call`).

## 値の目安 (value defaults)
- Typewriter CPS: 3–5 dramatic/suspense, 8–12 conversational, 15–20 energetic
  (tech demos, code), 30+ near-instant (filling long blocks).
- Visualizer smoothing 0.1–0.2 (snappy) to 0.3–0.5 (flowing); band count 4
  (background glow) to 32 (dense radial layouts), 16 is the balanced default.
- Bass drives big moves (scale/glow/position); treble drives detail
  (shimmer/flicker); pick 2–3 animated properties — more reads as noise.
- Layer multiple canvases via CSS `z-index` for a background/foreground depth
  split rather than per-element complexity in one canvas.

## Combinations
`discrete-text-sequence` and `context-sensitive-cursor` (share the typewriter
cursor-blink discipline) · any stat/count-up card (audio visualizer as an
ambient backdrop layer behind a metric).

## vendor 全文参照 (full detail)
Full recipe (multi-line cursor handoff, word rotation/append, visualizer spatial
mapping, band-count table): vendor `.../rules/gsap-effects.md`.
