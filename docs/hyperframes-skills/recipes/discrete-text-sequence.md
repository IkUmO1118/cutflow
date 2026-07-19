# Discrete Text Sequence

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/discrete-text-sequence.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
Replace WHOLE text states at time thresholds instead of typing char-by-char —
enables non-linear effects (typos, corrections, bulk paste, thinking pauses).
Serves **typewriter** and **code-card**. Distinct from `dynamic-content-sequencing`
(swaps distinct content blocks, not string-editing states of one line).

## 構造 (structure)
- One `class="clip"` terminal-style row: `.prompt` + fixed-width `.text-wrap`
  (prevents right-edge jitter as string length changes) holding `.text` + `.cursor`.
- An array `SEQUENCE = [{t, text}, …]`; a single driver tween's `onUpdate`
  reverse-searches for the latest entry whose `t` has passed and renders it.
- No animation between states — the jump is instant (no CSS `transition`).

## コード骨子 (skeleton)
```css
.text-wrap { min-width: {longestStateWidth}px; white-space: nowrap; } /* no transition */
```
```js
window.__timelines = window.__timelines || {};
const SEQUENCE = [
  { t: 0.0, text: "" }, { t: T_K1, text: "{p1}" },
  { t: T_BULK, text: "{fullCorrectedText}" }, { t: T_DONE, text: "{fullCorrectedText} ✓" },
];
function textAt(time) {
  for (let i = SEQUENCE.length - 1; i >= 0; i--) if (time >= SEQUENCE[i].t) return SEQUENCE[i].text;
  return "";
}
const tl = gsap.timeline({ paused: true });
const driver = { t: 0 };
tl.to(driver, { t: TOTAL_DURATION, duration: TOTAL_DURATION, ease: "none",
  onUpdate: () => { textEl.textContent = textAt(driver.t); } }, 0);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **Reverse-search array each frame** (O(n), n small) — don't index by frame; the
  sequence is sparse and time-keyed, which is exactly what makes seeking safe.
- **No CSS `transition`** on `.text` — a transition turns the discrete jump into
  a smear and desyncs from the seek clock.
- Cursor blink must be deterministic (`Math.sin(driverPhase)`), never a CSS
  `@keyframes` animation — those run on the browser clock, not the seek clock.
- Monospace font + `white-space: nowrap` — proportional fonts and wrapping both
  break the fixed-width jitter guard.
- GSAP required for the driver `onUpdate`; timeline stays paused (`{paused:true}`),
  finite duration only.
- Distinguish from the "smooth-slice" typewriter variation (continuous per-char) —
  use discrete only when you need non-linear states.

## 値の目安 (value defaults)
- Keystroke thresholds 0.06–0.20s apart for "human typing"; pauses 0.3–0.6s at
  natural word breaks; bulk-paste jumps multiple chars in one entry.
- `TOTAL_DURATION ≥ T_DONE + ~1s` climax dwell so the completion marker is seen.

## vendor 全文参照 (full detail)
Full recipe (thinking-pause, completion-pulse, per-state color variations): vendor
`.../rules/discrete-text-sequence.md`.
