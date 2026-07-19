# Dynamic Content Sequencing

> Compressed from `remotion/vendor/hyperframes/skills-corpus/hyperframes-animation/rules/dynamic-content-sequencing.md`.
> Cutflow adaptation — see docs/hyperframes-skills/authoring-contract.md for the seek-safe contract.

## 用途 (when to reach for it)
A utility pattern for scenes that swap between DISTINCT content blocks (cards,
phrases, stats): each block's on-screen duration is computed from its content
length, not hardcoded. Serves **kinetic-typography** and **typewriter**.
Distinct from `discrete-text-sequence` (one text element changing states) —
this swaps whole content blocks (eyebrow+title+body together).

## 構造 (structure)
- One `class="clip"` display: `.eyebrow` / `.title` / `.body` (with reserved
  `min-height`) / optional `.progress-fill` bar.
- A `CONTENT[]` array; a flat `[{start,end}]` is pre-computed ONCE at setup from
  `BASE_DURATION + body.length × SEC_PER_CHAR + hold` — content-driven duration,
  no timers.
- A single driver `onUpdate` reverse-searches the pre-computed array and swaps
  DOM text only on transition (guarded by a `lastTitle` key), not every frame.

## コード骨子 (skeleton)
```css
.body { min-height: 160px; } /* reserve space so layout doesn't jump */
```
```js
window.__timelines = window.__timelines || {};
let cumulative = 0;
const TIMELINE = CONTENT.map((entry) => {
  const dur = BASE_DURATION + entry.body.length * SEC_PER_CHAR + entry.hold;
  const start = cumulative; cumulative += dur;
  return { ...entry, start, end: cumulative };
});
function entryAt(t) { for (let i=TIMELINE.length-1;i>=0;i--) if (t>=TIMELINE[i].start) return TIMELINE[i]; return TIMELINE[0]; }
const tl = gsap.timeline({ paused: true });
const driver = { t: 0 }; let lastTitle = "";
tl.to(driver, { t: TOTAL_DURATION, duration: TOTAL_DURATION, ease: "none", onUpdate: () => {
  const e = entryAt(driver.t);
  if (e.title !== lastTitle) { titleEl.textContent = e.title; bodyEl.textContent = e.body; lastTitle = e.title; }
} }, 0);
window.__timelines['<composition-id>'] = tl;
```

## seek-safe 注意点 (Cutflow adaptations)
- **Pre-compute `TIMELINE` once at setup, never per-frame** — `onUpdate` is then
  O(log n) reverse-search, deterministic under repeated seeks.
- DOM swap ONLY on transition (`lastTitle` guard) — per-frame `textContent`
  writes on an unchanged value still cause flicker under HF/Cutflow's renderer.
- `min-height` on the variable-length element — without it, downstream layout
  (progress bar, brand line) jitters as content length changes across entries.
- Driver ease `"none"` (linear) so `t` maps 1:1 to scene time.
- GSAP required for the shared driver; timeline paused, deterministic formula
  only (no `Math.random`, no timers).

## 値の目安 (value defaults)
- `BASE_DURATION` 0.6–1.5s; `SEC_PER_CHAR` 0.03–0.06s/char (≈17–33 chars/sec
  read pace); `HOLD_FINAL > HOLD_MID` by a clear margin so the close reads as a beat.
- `CONTENT` length (N) 3–6 entries — fewer isn't a sequence, more drags.

## vendor 全文参照 (full detail)
Full recipe (crossfade-between-items variant, per-item motion mapping, duration
formula ranges): vendor `.../rules/dynamic-content-sequencing.md`.
