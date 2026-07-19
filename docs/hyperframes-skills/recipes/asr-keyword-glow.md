# ASR Keyword Glow

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/asr-keyword-glow.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Words glow + scale up when "spoken," via an attack→sustain→decay→rest envelope
per word timestamp. Serves **kinetic-typography** narration emphasis. ⚠️
**no-input**: CutFlow has no automatic ASR — word timings are HAND-AUTHORED
arrays the card author fills in, not derived from CutFlow's whisper transcript.

## 構造 (structure)
- One `class="clip"` phrase row of `<span class="word" data-word="…">` — one
  span per word, a `data-word` key looked up in a `TIMINGS` map.
- A single driver tween (`0 → SCENE_DURATION`) loops over all words each frame,
  computing each word's envelope value and writing `textShadow` blur + `scale`.
- No tracks/z-index — flat text, no stacking.

## コード骨子 (skeleton)
```css
.word { display: inline-block; transform-origin: 50% 50%; will-change: transform, text-shadow; }
```
```js
window.__timelines = window.__timelines || {};
// HAND-AUTHORED — no CutFlow ASR. One entry per <span data-word>.
const TIMINGS = { /* wordKey: { start, end }, … all seconds, monotonic non-overlap */ };
function envelope(t, start, end) {
  const releaseEnd = end + RELEASE;
  if (t < start) return 0;
  if (t < end) return Math.min((t - start) / ATTACK_DUR, 1);
  if (t < releaseEnd) return 1 - ((t - end) / RELEASE) * (1 - REST_LEVEL);
  return REST_LEVEL;
}
const tl = gsap.timeline({ paused: true });
const driver = { t: 0 };
tl.to(driver, { t: SCENE_DURATION, duration: SCENE_DURATION, ease: "none", onUpdate: () => {
  words.forEach((el) => {
    const timing = TIMINGS[el.dataset.word]; if (!timing) return;
    const env = envelope(driver.t, timing.start, timing.end);
    el.style.textShadow = `0 0 ${MAX_BLUR * env}px {glowColor}`;
    el.style.transform = `scale(${1 + MAX_SCALE_BOOST * env})`;
  });
} }, 0);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **No-input**: TIMINGS is a hand-authored `{start,end}` map, monotonic and
  non-overlapping. CutFlow's `transcript.json`/whisper word timestamps are NOT
  wired into this — do not assume auto-sync.
- Single driver + multi-word `onUpdate`, not one tween per word — keeps the
  timeline small at 60+ words.
- Envelope never zeroes fully after a word (`REST_LEVEL > 0`) — the "breadcrumb"
  of recent emphasis is the point; don't drop it for a simpler on/off.
- `text-shadow` not `box-shadow` — glows the glyph, not the inline-block box.
- Driver ease must be `"none"` (linear) so `t` maps 1:1 to scene time; any other
  ease distorts the per-word envelope shape.
- GSAP required for the shared driver; timeline paused, no CSS animation on words.

## vendor 全文参照 (full detail)
Full recipe (karaoke-style variant, multi-octave glow, 3D pop-out): vendor
`.../rules/asr-keyword-glow.md`.
