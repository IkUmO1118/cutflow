# Hacker Flip 3D

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/hacker-flip-3d.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Per-glyph 3D flip reveal that "decrypts" into the target word: each character
flickers through substitute glyphs, then settles on the real one. Serves
**kinetic-typography** and **titlecard-reveal**. Distinct from `discrete-text-sequence`
(whole-string swaps) — this is per-character, always ending on a known target.

## 構造 (structure)
- One `class="clip"` stage (`display:grid;place-items:center`) with `perspective`
  on the stage — required or `rotateX` renders flat.
- A ghost row (`opacity:0`, identical text) reserves layout width so flicker glyphs
  don't shift it; a live row of per-char `<span>` sits over it.
- No tracks/z-index needed — one flat text composition.

## コード骨子 (skeleton)
```css
.stage { perspective: 1500px; } /* REQUIRED, else rotateX looks 2D */
.hacker-char { transform-origin: bottom; transform-style: preserve-3d; }
```
```js
// GSAP key = the card's data-composition-id (NOT "main").
window.__timelines = window.__timelines || {};
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Deterministic "random" — seeded by index+progress, NEVER Math.random.
function pseudoGlyph(seed) {
  const h = ((seed * 9301 + 49297) % 233280) / 233280;
  return GLYPHS[Math.floor(h * GLYPHS.length)];
}
const tl = gsap.timeline({ paused: true });
charEls.forEach((el, i) => {
  const state = { p: 0 };
  tl.to(state, { p: 1, duration: 0.55, ease: "power3.out", onUpdate: () => {
    if (state.p < 0.6) el.textContent = pseudoGlyph(i * 1000 + Math.floor(state.p * 100));
    else el.textContent = el.dataset.target;
    el.style.transform = `rotateX(${90 - state.p * 90}deg)`;
    el.style.opacity = Math.min(1, state.p * 2);
  } }, i * 0.05);
});
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **Deterministic pseudo-random only** — the seeded hash keyed on char index +
  progress, never `Math.random()`; HF/Cutflow seeks the same frame repeatedly and
  must render the same glyph every time.
- `onUpdate` is O(1) per char per frame — text-content + transform writes only, no
  layout thrash.
- `fromTo`-equivalent via explicit `p:0→1` state (not `from`) so t=0 seek is correct.
- **Fonts**: monospace is preferred so flicker glyphs hold width; a proportional
  generic (`sans-serif`) still works but pair with the ghost-row width reservation.
- GSAP required (per-char stagger + onUpdate); pinned CDN + `data-hf-requires="gsap"`;
  timeline stays paused, never `tl.play()`.

## vendor 全文参照 (full detail)
Full recipe (flicker-rate tuning, reveal-threshold, variations): vendor
`.../rules/hacker-flip-3d.md`.
